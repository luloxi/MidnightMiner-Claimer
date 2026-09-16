import { NextRequest, NextResponse } from "next/server";
import { validateMnemonic } from "bip39";
import {
  AddressChain,
  AddressKind,
  BlockfrostUtxo,
  deriveSigningKey,
  deriveWallets,
  deriveWalletsMultiAccount,
} from "@/lib/cardano";

const BF = "https://cardano-mainnet.blockfrost.io/api/v0";
const MIDNIGHT_THAW_API = "https://mainnet.prod.gd.midnighttge.io";
const GLOBAL_SPONSOR_SCAN_ACCOUNTS = 25;

/**
 * The thaw build endpoint reuses the funding UTxOs as collateral when none is supplied, and
 * collateral is capped at 3 inputs. Sending more is rejected with `invalid_number_of_inputs`.
 */
const MAX_FUNDING_UTXOS = 3;

/**
 * The funding address pays the min-ADA of the redeemed NIGHT output plus the fee. Below roughly
 * 2 ADA the endpoint fails with TxBodyErrorAdaBalanceTooSmall, so poor addresses are skipped in
 * favour of a sponsor that can actually cover it.
 */
const MIN_FUNDING_LOVELACE = BigInt(3_000_000);

/** Pick the funding UTxOs to send: biggest first, pure-ADA preferred, never more than the cap. */
function selectFundingUtxos(utxos: BlockfrostUtxo[]): { selected: BlockfrostUtxo[]; lovelace: bigint } {
  const lovelaceOf = (u: BlockfrostUtxo) =>
    BigInt(u.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
  const byValueDesc = (a: BlockfrostUtxo, b: BlockfrostUtxo) =>
    lovelaceOf(a) > lovelaceOf(b) ? -1 : lovelaceOf(a) < lovelaceOf(b) ? 1 : 0;

  const pureAda = utxos.filter((u) => u.amount.length === 1).sort(byValueDesc);
  const withTokens = utxos.filter((u) => u.amount.length > 1).sort(byValueDesc);

  const selected = [...pureAda, ...withTokens].slice(0, MAX_FUNDING_UTXOS);
  return {
    selected,
    lovelace: selected.reduce((sum, u) => sum + lovelaceOf(u), BigInt(0)),
  };
}

async function bf(path: string, apiKey: string) {
  const res = await fetch(`${BF}${path}`, {
    headers: { project_id: apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blockfrost ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function bfMaybe(path: string, apiKey: string) {
  const res = await fetch(`${BF}${path}`, {
    headers: { project_id: apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blockfrost ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

interface MidnightBuildResponse {
  redeemed_amount: number;
  require_thawing_extra_signature: boolean;
  transaction: string;
  transaction_id: string;
}

interface SponsorCandidate {
  accountIndex: number | null;
  address: string;
  signingKeyHexes: string[];
  utxos?: BlockfrostUtxo[] | null;
}

type UtxoCache = Map<string, Promise<BlockfrostUtxo[] | null>>;

interface NoRedeemableThawsInfo {
  nextThawAt: string | null;
  nowAt: string | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSpentInputsSubmitError(errorText: string) {
  const normalized = errorText.toLowerCase();
  return (
    normalized.includes("all inputs are spent") ||
    normalized.includes("already been included")
  );
}

function parseNoRedeemableThaws(errorText: string): NoRedeemableThawsInfo | null {
  if (!errorText.includes("NoRedeemableThaws")) return null;

  const nextThawMatch = errorText.match(/nextThaw = POSIXTime \{getPOSIXTime = (\d+)\}/);
  const nowMatch = errorText.match(/now = POSIXTime \{getPOSIXTime = (\d+)\}/);

  return {
    nextThawAt: nextThawMatch ? new Date(Number(nextThawMatch[1])).toISOString() : null,
    nowAt: nowMatch ? new Date(Number(nowMatch[1])).toISOString() : null,
  };
}

async function buildClaimTx(
  address: string,
  changeAddress: string,
  fundingUtxos: string[]
): Promise<MidnightBuildResponse> {
  const res = await fetch(`${MIDNIGHT_THAW_API}/thaws/${address}/transactions/build`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      origin: "https://redeem.midnight.gd",
      referer: "https://redeem.midnight.gd/",
      priority: "u=1, i",
      "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Google Chrome\";v=\"146\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"Windows\"",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      change_address: changeAddress,
      collateral_utxos: [],
      funding_utxos: fundingUtxos,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Midnight thaw build ${res.status}: ${text.slice(0, 500)}`);
  }

  return res.json() as Promise<MidnightBuildResponse>;
}

async function toCborFundingUtxos(address: string, utxos: BlockfrostUtxo[]) {
  const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
  const outputAddr = lib.Address.from_bech32(address);

  return utxos.map((utxo) => {
    const value = lib.Value.new(
      lib.BigNum.from_str(
        utxo.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0"
      )
    );

    const multiAsset = lib.MultiAsset.new();
    let hasAssets = false;

    const byPolicy = new Map<string, { unit: string; quantity: string }[]>();
    for (const amount of utxo.amount) {
      if (amount.unit === "lovelace") continue;
      const policy = amount.unit.slice(0, 56);
      const list = byPolicy.get(policy) ?? [];
      list.push(amount);
      byPolicy.set(policy, list);
    }

    for (const [policy, assetsForPolicy] of byPolicy.entries()) {
      const scriptHash = lib.ScriptHash.from_bytes(Buffer.from(policy, "hex"));
      const assets = lib.Assets.new();
      for (const asset of assetsForPolicy) {
        const assetHex = asset.unit.slice(56);
        const assetName = lib.AssetName.new(Buffer.from(assetHex, "hex"));
        assets.insert(assetName, lib.BigNum.from_str(asset.quantity));
      }
      multiAsset.insert(scriptHash, assets);
      hasAssets = true;
    }

    if (hasAssets) value.set_multiasset(multiAsset);

    const txInput = lib.TransactionInput.new(
      lib.TransactionHash.from_hex(utxo.tx_hash),
      utxo.tx_index
    );
    const txOutput = lib.TransactionOutput.new(outputAddr, value);
    const txUnspent = lib.TransactionUnspentOutput.new(txInput, txOutput);
    return Buffer.from(txUnspent.to_bytes()).toString("hex");
  });
}

async function signBuiltTransaction(txHex: string, signingKeyHexes: string[]) {
  const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
  const tx = lib.Transaction.from_bytes(Buffer.from(txHex, "hex"));
  const txBody = tx.body();
  const witnessSet = tx.witness_set();

  const existingVkeys = witnessSet.vkeys() ?? lib.Vkeywitnesses.new();
  const txHash = lib.hash_transaction(txBody);

  for (const signingKeyHex of [...new Set(signingKeyHexes)]) {
    const keyBytes = Buffer.from(signingKeyHex, "hex");
    const privKey = keyBytes.length === 32
      ? lib.PrivateKey.from_normal_bytes(keyBytes)
      : lib.PrivateKey.from_extended_bytes(keyBytes);
    existingVkeys.add(lib.make_vkey_witness(txHash, privKey));
  }

  witnessSet.set_vkeys(existingVkeys);

  return Buffer.from(
    lib.Transaction.new(txBody, witnessSet, tx.auxiliary_data()).to_bytes()
  ).toString("hex");
}

async function loadUtxos(
  address: string,
  blockfrostApiKey: string,
  cache: UtxoCache
): Promise<BlockfrostUtxo[] | null> {
  let existing = cache.get(address);
  if (!existing) {
    existing = bfMaybe(`/addresses/${address}/utxos`, blockfrostApiKey) as Promise<BlockfrostUtxo[] | null>;
    cache.set(address, existing);
  }
  return existing;
}

function normalizeAccountIndexes(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of input) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 20) break;
  }
  return out;
}

async function waitForValidityWindow(txHex: string, blockfrostApiKey: string) {
  const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
  const tx = lib.Transaction.from_bytes(Buffer.from(txHex, "hex"));
  const txBody = tx.body();
  const invalidBefore =
    txBody.validity_start_interval_bignum?.()?.to_str?.() ??
    txBody.validity_start_interval?.()?.toString?.() ??
    null;

  if (!invalidBefore) return;

  const targetSlot = Number(invalidBefore);
  if (!Number.isFinite(targetSlot)) return;
  const requiredSlot = targetSlot + 1;

  const latestBlock = await bf("/blocks/latest", blockfrostApiKey);
  const currentSlot = Number(latestBlock.slot ?? 0);
  if (currentSlot >= requiredSlot) return;

  const waitMs = Math.min(Math.max(requiredSlot - currentSlot, 1) * 1_000 + 400, 25_000);
  await sleep(waitMs);

  const check = await bf("/blocks/latest", blockfrostApiKey);
  const slotAfterWait = Number(check.slot ?? 0);
  if (slotAfterWait >= requiredSlot) return;

  if (slotAfterWait < requiredSlot) {
    await sleep(Math.min(Math.max(requiredSlot - slotAfterWait, 1) * 1_000 + 400, 8_000));
  }
}

async function deriveAutoSponsorCandidates(
  sponsorMnemonic: string,
  targetSigningKeyHex: string,
  blockfrostApiKey: string,
  utxoCache: UtxoCache
): Promise<SponsorCandidate[]> {
  if (!sponsorMnemonic) return [];

  const sponsorWallets = await deriveWalletsMultiAccount(
    sponsorMnemonic,
    1,
    GLOBAL_SPONSOR_SCAN_ACCOUNTS
  );

  const candidates = await Promise.all(
    sponsorWallets.map(async (wallet) => {
      const utxos = await loadUtxos(wallet.baseAddress, blockfrostApiKey, utxoCache);
      const { lovelace } = selectFundingUtxos(utxos ?? []);

      if (lovelace < MIN_FUNDING_LOVELACE) return null;

      const { signingKeyHex } = await deriveSigningKey(
        sponsorMnemonic,
        wallet.accountIndex,
        0
      );

      return {
        accountIndex: wallet.accountIndex,
        address: wallet.baseAddress,
        lovelace,
        signingKeyHexes: [signingKeyHex, targetSigningKeyHex],
        utxos,
      };
    })
  );

  return candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => (a.lovelace > b.lovelace ? -1 : a.lovelace < b.lovelace ? 1 : 0))
    .map(({ accountIndex, address, signingKeyHexes, utxos }) => ({
      accountIndex,
      address,
      signingKeyHexes,
      utxos,
    }));
}

export async function POST(req: NextRequest) {
  try {
    const {
      mnemonic,
      fromAccountIndex,
      fromAddressIndex = 0,
      fromChain = 0,
      fromAddressKind = "base",
      blockfrostApiKey,
      sponsorAccountIndex,
      sponsorAccountIndexes,
    } = await req.json() as {
      mnemonic: string;
      fromAccountIndex: number;
      fromAddressIndex?: number;
      fromChain?: AddressChain;
      fromAddressKind?: AddressKind;
      blockfrostApiKey?: string;
      sponsorAccountIndex?: number | null;
      sponsorAccountIndexes?: number[];
    };

    const effectiveBlockfrostKey =
      blockfrostApiKey?.trim() || process.env.BLOCKFROST_API_KEY?.trim() || "";

    if (!mnemonic || !validateMnemonic(mnemonic.trim())) {
      return NextResponse.json({ error: "Invalid mnemonic" }, { status: 400 });
    }
    if (!effectiveBlockfrostKey) {
      return NextResponse.json({ error: "Missing BLOCKFROST_API_KEY" }, { status: 400 });
    }

    const { signingKeyHex, baseAddressHex } = await deriveSigningKey(
      mnemonic.trim(),
      fromAccountIndex,
      fromAddressIndex,
      fromChain,
      fromAddressKind
    );

    const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
    const senderBech32 = lib.Address.from_bytes(
      Buffer.from(baseAddressHex, "hex")
    ).to_bech32();

    const rankedIndexes = normalizeAccountIndexes(sponsorAccountIndexes);
    if (typeof sponsorAccountIndex === "number" && Number.isInteger(sponsorAccountIndex) && sponsorAccountIndex >= 0) {
      if (!rankedIndexes.includes(sponsorAccountIndex)) rankedIndexes.unshift(sponsorAccountIndex);
    }

    const attemptState: {
      lastBuildError: string;
      noRedeemableInfo: NoRedeemableThawsInfo | null;
    } = {
      lastBuildError: "",
      noRedeemableInfo: null,
    };

    for (let submitAttempt = 0; submitAttempt < 3; submitAttempt++) {
      const utxoCache: UtxoCache = new Map();
      const triedAddresses = new Set<string>();
      const built: { tx: MidnightBuildResponse | null; signedTxHex: string } = {
        tx: null,
        signedTxHex: "",
      };

      const tryCandidate = async (candidate: SponsorCandidate) => {
        if (triedAddresses.has(candidate.address)) return false;
        triedAddresses.add(candidate.address);

        const fundingUtxosRaw = candidate.utxos?.length
          ? candidate.utxos
          : await loadUtxos(candidate.address, effectiveBlockfrostKey, utxoCache);
        if (!fundingUtxosRaw?.length) return false;

        const { selected, lovelace } = selectFundingUtxos(fundingUtxosRaw);
        if (lovelace < MIN_FUNDING_LOVELACE) {
          attemptState.lastBuildError =
            `${candidate.address} has only ${(Number(lovelace) / 1_000_000).toFixed(2)} ADA available ` +
            `in its ${MAX_FUNDING_UTXOS} largest UTxOs, which cannot cover the claim`;
          return false;
        }

        try {
          const fundingUtxos = await toCborFundingUtxos(candidate.address, selected);
          const nextBuild = await buildClaimTx(senderBech32, candidate.address, fundingUtxos);
          built.tx = nextBuild;
          built.signedTxHex = await signBuiltTransaction(
            nextBuild.transaction,
            nextBuild.require_thawing_extra_signature ? candidate.signingKeyHexes : [candidate.signingKeyHexes[0]]
          );
          return true;
        } catch (err) {
          attemptState.lastBuildError = String(err);
          attemptState.noRedeemableInfo =
            parseNoRedeemableThaws(attemptState.lastBuildError) ?? attemptState.noRedeemableInfo;
          return false;
        }
      };

      if (!rankedIndexes.length) {
        const senderUtxos = await loadUtxos(senderBech32, effectiveBlockfrostKey, utxoCache);
        if (senderUtxos?.length) {
          await tryCandidate({
            accountIndex: null,
            address: senderBech32,
            signingKeyHexes: [signingKeyHex],
            utxos: senderUtxos,
          });
        }
      }

      if (!built.tx || !built.signedTxHex) {
        if (rankedIndexes.length) {
          for (const accountIndex of rankedIndexes) {
            const [wallet] = await deriveWallets(mnemonic.trim(), 1, accountIndex);
            const utxos = await loadUtxos(wallet.baseAddress, effectiveBlockfrostKey, utxoCache);
            if (!utxos?.length) continue;
            const { signingKeyHex: sponsorSigningKeyHex } = await deriveSigningKey(
              mnemonic.trim(),
              accountIndex,
              0
            );
            if (await tryCandidate({
              accountIndex,
              address: wallet.baseAddress,
              signingKeyHexes: [sponsorSigningKeyHex, signingKeyHex],
              utxos,
            })) break;
          }
        } else {
          const scanned = await deriveAutoSponsorCandidates(
            mnemonic.trim(),
            signingKeyHex,
            effectiveBlockfrostKey,
            utxoCache
          );
          for (const candidate of scanned) {
            if (await tryCandidate(candidate)) break;
          }
        }
      }

      if (!built.tx || !built.signedTxHex) {
        if (attemptState.noRedeemableInfo) {
          return NextResponse.json({
            code: "NO_REDEEMABLE_THAWS",
            error: attemptState.noRedeemableInfo.nextThawAt
              ? `There is no claimable thaw yet. Next thaw: ${attemptState.noRedeemableInfo.nextThawAt}`
              : "There is no claimable thaw yet for this wallet.",
            nextThawAt: attemptState.noRedeemableInfo.nextThawAt,
            nowAt: attemptState.noRedeemableInfo.nowAt,
          }, { status: 409 });
        }
        return NextResponse.json({
          error: attemptState.lastBuildError || "No sponsor with enough ADA was found to submit the claim",
        }, { status: 400 });
      }

      await waitForValidityWindow(built.signedTxHex, effectiveBlockfrostKey);

      const submitRes = await fetch(`${BF}/tx/submit`, {
        method: "POST",
        headers: {
          project_id: effectiveBlockfrostKey,
          "Content-Type": "application/cbor",
        },
        body: Buffer.from(built.signedTxHex, "hex"),
        signal: AbortSignal.timeout(30_000),
      });
      const submitText = await submitRes.text();
      if (submitRes.ok) {
        const txHash = submitText.replace(/"/g, "");
        return NextResponse.json({
          txHash,
          redeemedAmount: built.tx.redeemed_amount,
          explorerUrl: `https://cardanoscan.io/transaction/${txHash}`,
        });
      }

      if (!isSpentInputsSubmitError(submitText) || submitAttempt === 2) {
        return NextResponse.json({
          error: `Submit failed: ${submitText}`,
        }, { status: 502 });
      }

      await sleep(4_000);
    }

    return NextResponse.json({
      error: "Could not submit the claim after retrying with fresh UTxOs",
    }, { status: 502 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
