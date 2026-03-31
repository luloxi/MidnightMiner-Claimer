import { NextRequest, NextResponse } from "next/server";
import { validateMnemonic } from "bip39";
import { deriveSigningKey, deriveWalletsMultiAccount, BlockfrostUtxo } from "@/lib/cardano";

const BF = "https://cardano-mainnet.blockfrost.io/api/v0";
const MIDNIGHT_THAW_API = "https://mainnet.prod.gd.midnighttge.io";
const GLOBAL_SPONSOR_SCAN_ACCOUNTS = 25;

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
}

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
      "accept-language": "es-419,es;q=0.9",
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
  const safetySlots = 1;
  const requiredSlot = targetSlot + safetySlots;

  for (let i = 0; i < 24; i++) {
    const latestBlock = await bf("/blocks/latest", blockfrostApiKey);
    const currentSlot = Number(latestBlock.slot ?? 0);
    if (currentSlot >= requiredSlot) return;

    const waitMs = Math.min(Math.max(requiredSlot - currentSlot, 1) * 1_000, 10_000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw new Error(
    `La tx no llegó a la ventana de validez a tiempo (slot requerido ${requiredSlot})`
  );
}

async function deriveAutoSponsorCandidates(
  sponsorMnemonic: string,
  targetSigningKeyHex: string,
  blockfrostApiKey: string
): Promise<SponsorCandidate[]> {
  if (!sponsorMnemonic) return [];

    const sponsorWallets = await deriveWalletsMultiAccount(
      sponsorMnemonic,
      1,
    GLOBAL_SPONSOR_SCAN_ACCOUNTS
  );

  const candidates = await Promise.all(
    sponsorWallets.map(async (wallet) => {
      const utxos = await bfMaybe(`/addresses/${wallet.baseAddress}/utxos`, blockfrostApiKey) as BlockfrostUtxo[] | null;
      const lovelace = (utxos ?? []).reduce((sum, utxo) => {
        const quantity = utxo.amount.find((amount) => amount.unit === "lovelace")?.quantity ?? "0";
        return sum + BigInt(quantity);
      }, BigInt(0));

      if (lovelace <= BigInt(0)) return null;

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
      };
    })
  );

  return candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((a, b) => (a.lovelace > b.lovelace ? -1 : a.lovelace < b.lovelace ? 1 : 0))
    .map(({ accountIndex, address, signingKeyHexes }) => ({
      accountIndex,
      address,
      signingKeyHexes,
    }));
}

export async function POST(req: NextRequest) {
  try {
    const {
      mnemonic,
      fromAccountIndex,
      fromAddressIndex = 0,
      blockfrostApiKey,
      sponsorAccountIndex,
    } = await req.json() as {
      mnemonic: string;
      fromAccountIndex: number;
      fromAddressIndex?: number;
      blockfrostApiKey?: string;
      sponsorAccountIndex?: number | null;
    };

    const effectiveBlockfrostKey =
      blockfrostApiKey?.trim() || process.env.BLOCKFROST_API_KEY?.trim() || "";

    if (!mnemonic || !validateMnemonic(mnemonic.trim())) {
      return NextResponse.json({ error: "Mnemonic inválido" }, { status: 400 });
    }
    if (!effectiveBlockfrostKey) {
      return NextResponse.json({ error: "Falta BLOCKFROST_API_KEY" }, { status: 400 });
    }

    const { signingKeyHex, baseAddressHex } = await deriveSigningKey(
      mnemonic.trim(),
      fromAccountIndex,
      fromAddressIndex
    );

    const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
    const senderBech32 = lib.Address.from_bytes(
      Buffer.from(baseAddressHex, "hex")
    ).to_bech32();

    const sponsorCandidates: SponsorCandidate[] = [];

    const senderUtxos = await bfMaybe(
      `/addresses/${senderBech32}/utxos`,
      effectiveBlockfrostKey
    ) as BlockfrostUtxo[] | null;
    if (senderUtxos?.length) {
      sponsorCandidates.push({
        accountIndex: null,
        address: senderBech32,
        signingKeyHexes: [signingKeyHex],
      });
    }

    if (typeof sponsorAccountIndex === "number") {
      const sponsorWallets = await deriveWalletsMultiAccount(
        mnemonic.trim(),
        1,
        sponsorAccountIndex + 1
      );
      const sponsorWallet = sponsorWallets.find(
        (wallet) => wallet.accountIndex === sponsorAccountIndex && wallet.index === 0
      );
      if (!sponsorWallet) {
        return NextResponse.json({ error: "Sponsor inválido" }, { status: 400 });
      }

      const { signingKeyHex: sponsorSigningKeyHex } = await deriveSigningKey(
        mnemonic.trim(),
        sponsorAccountIndex,
        0
      );
      sponsorCandidates.push({
        accountIndex: sponsorAccountIndex,
        address: sponsorWallet.baseAddress,
        signingKeyHexes: [sponsorSigningKeyHex, signingKeyHex],
      });
    } else {
      sponsorCandidates.push(...await deriveAutoSponsorCandidates(
        mnemonic.trim(),
        signingKeyHex,
        effectiveBlockfrostKey
      ));
    }

    const dedupedSponsorCandidates = sponsorCandidates.filter(
      (candidate, index, arr) =>
        arr.findIndex((other) => other.address === candidate.address) === index
    );

    let lastBuildError = "";
    let noRedeemableInfo: NoRedeemableThawsInfo | null = null;

    for (let submitAttempt = 0; submitAttempt < 3; submitAttempt++) {
      let build: MidnightBuildResponse | null = null;
      let signedTxHex = "";

      for (const candidate of dedupedSponsorCandidates) {
        const fundingUtxosRaw = await bfMaybe(
          `/addresses/${candidate.address}/utxos`,
          effectiveBlockfrostKey
        ) as BlockfrostUtxo[] | null;

        if (!fundingUtxosRaw?.length) continue;

        try {
          const fundingUtxos = await toCborFundingUtxos(candidate.address, fundingUtxosRaw);
          build = await buildClaimTx(senderBech32, candidate.address, fundingUtxos);
          signedTxHex = await signBuiltTransaction(
            build.transaction,
            build.require_thawing_extra_signature ? candidate.signingKeyHexes : [candidate.signingKeyHexes[0]]
          );
          break;
        } catch (err) {
          lastBuildError = String(err);
          noRedeemableInfo = parseNoRedeemableThaws(lastBuildError) ?? noRedeemableInfo;
        }
      }

      if (!build || !signedTxHex) {
        if (noRedeemableInfo) {
          return NextResponse.json({
            code: "NO_REDEEMABLE_THAWS",
            error: noRedeemableInfo.nextThawAt
              ? `Todavía no hay thaw reclamable. Próximo thaw: ${noRedeemableInfo.nextThawAt}`
              : "Todavía no hay thaw reclamable para esta wallet.",
            nextThawAt: noRedeemableInfo.nextThawAt,
            nowAt: noRedeemableInfo.nowAt,
          }, { status: 409 });
        }
        return NextResponse.json({
          error: lastBuildError || "No se encontró sponsor con ADA suficiente para reclamar",
        }, { status: 400 });
      }

      await waitForValidityWindow(signedTxHex, effectiveBlockfrostKey);

      const submitRes = await fetch(`${BF}/tx/submit`, {
        method: "POST",
        headers: {
          project_id: effectiveBlockfrostKey,
          "Content-Type": "application/cbor",
        },
        body: Buffer.from(signedTxHex, "hex"),
        signal: AbortSignal.timeout(30_000),
      });
      const submitText = await submitRes.text();
      if (submitRes.ok) {
        const txHash = submitText.replace(/"/g, "");
        return NextResponse.json({
          txHash,
          redeemedAmount: build.redeemed_amount,
          explorerUrl: `https://cardanoscan.io/transaction/${txHash}`,
        });
      }

      if (!isSpentInputsSubmitError(submitText) || submitAttempt === 2) {
        return NextResponse.json({
          error: `Submit falló: ${submitText}`,
        }, { status: 502 });
      }

      await sleep(4_000);
    }

    return NextResponse.json({
      error: "No se pudo enviar la claim después de reintentar con UTxOs frescos",
    }, { status: 502 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
