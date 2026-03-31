import { NextRequest, NextResponse } from "next/server";
import { BlockfrostUtxo } from "@/lib/cardano";

const KOIOS_API    = "https://api.koios.rest/api/v1";
const BF_API       = "https://cardano-mainnet.blockfrost.io/api/v0";
const MIDNIGHT_THAW_API = "https://mainnet.prod.gd.midnighttge.io";
const NIGHT_POLICY = "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa";
const NIGHT_NAME   = "4e49474854"; // hex of "NIGHT"
const NIGHT_DECIMALS = 1_000_000;

// ── Koios helpers ─────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function koiosPost<T>(path: string, body: object): Promise<{ ok: boolean; data: T[] }> {
  try {
    const res = await fetch(`${KOIOS_API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, data: [] };
    return { ok: true, data: (await res.json()) as T[] };
  } catch {
    return { ok: false, data: [] };
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface KoiosAddressInfo { address: string; balance: string; }
// Koios /address_assets returns one flat row per asset (NOT nested asset_list)
interface KoiosAddressAssetRow {
  address: string;
  policy_id: string;
  asset_name: string;
  quantity: string;
  decimals: number;
}

export interface WalletBalance {
  index: number;
  baseAddress: string;
  enterpriseAddress: string;
  lovelace: string;
  nightAmount: string;
  claimableNight: string;
  adaDisplay: string;
  nightDisplay: string;
  claimableDisplay: string;
}

async function bf(path: string, apiKey: string) {
  const res = await fetch(`${BF_API}${path}`, {
    headers: { project_id: apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  return res.json();
}

interface MidnightBuildResponse {
  redeemed_amount?: number;
  message?: string;
  type?: string;
}

interface MidnightThawSchedule {
  thaws?: Array<{
    amount?: number;
    status?: string;
    transaction_id?: string | null;
  }>;
}

interface FundingSource {
  address: string;
  utxos: BlockfrostUtxo[];
  fundingUtxos: string[];
}

function midnightHeaders() {
  return {
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
  };
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

    const byPolicy = new Map<string, { unit: string; quantity: string }[]>();
    for (const amount of utxo.amount) {
      if (amount.unit === "lovelace") continue;
      const policy = amount.unit.slice(0, 56);
      const list = byPolicy.get(policy) ?? [];
      list.push(amount);
      byPolicy.set(policy, list);
    }

    if (byPolicy.size > 0) {
      const multiAsset = lib.MultiAsset.new();
      for (const [policy, assetsForPolicy] of byPolicy.entries()) {
        const scriptHash = lib.ScriptHash.from_bytes(Buffer.from(policy, "hex"));
        const assets = lib.Assets.new();
        for (const asset of assetsForPolicy) {
          const assetHex = asset.unit.slice(56);
          const assetName = lib.AssetName.new(Buffer.from(assetHex, "hex"));
          assets.insert(assetName, lib.BigNum.from_str(asset.quantity));
        }
        multiAsset.insert(scriptHash, assets);
      }
      value.set_multiasset(multiAsset);
    }

    const txInput = lib.TransactionInput.new(
      lib.TransactionHash.from_hex(utxo.tx_hash),
      utxo.tx_index
    );
    const txOutput = lib.TransactionOutput.new(outputAddr, value);
    const txUnspent = lib.TransactionUnspentOutput.new(txInput, txOutput);
    return Buffer.from(txUnspent.to_bytes()).toString("hex");
  });
}

async function buildMidnightClaimPreview(
  thawAddress: string,
  fundingSource: FundingSource
): Promise<{ ok: true; redeemedAmount: bigint } | { ok: false; retryable: boolean }> {
  const res = await fetch(`${MIDNIGHT_THAW_API}/thaws/${thawAddress}/transactions/build`, {
    method: "POST",
    headers: midnightHeaders(),
    body: JSON.stringify({
      change_address: fundingSource.address,
      collateral_utxos: [],
      funding_utxos: fundingSource.fundingUtxos,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  let data: MidnightBuildResponse | null = null;
  try {
    data = await res.json() as MidnightBuildResponse;
  } catch {
    data = null;
  }

  if (res.ok) {
    return { ok: true, redeemedAmount: BigInt(data?.redeemed_amount ?? 0) };
  }

  const message = `${data?.message ?? ""} ${data?.type ?? ""}`.toLowerCase();
  const retryable =
    message.includes("not enough funds") ||
    message.includes("missing amount");

  return { ok: false, retryable };
}

async function fetchClaimableFromSchedule(address: string): Promise<bigint | null> {
  const res = await fetch(`${MIDNIGHT_THAW_API}/thaws/${address}/schedule`, {
    method: "GET",
    headers: midnightHeaders(),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) return null;

  const data = await res.json() as MidnightThawSchedule;
  const redeemable = (data.thaws ?? []).reduce((sum, thaw) => {
    if (thaw.status !== "redeemable") return sum;
    return sum + BigInt(thaw.amount ?? 0);
  }, BigInt(0));

  return redeemable;
}

async function loadFundingSource(
  address: string,
  blockfrostKey: string,
  cache: Map<string, Promise<FundingSource | null>>
): Promise<FundingSource | null> {
  let existing = cache.get(address);
  if (!existing) {
    existing = (async () => {
      const utxos = await bf(`/addresses/${address}/utxos`, blockfrostKey) as BlockfrostUtxo[] | null;
      if (!utxos?.length) return null;
      return {
        address,
        utxos,
        fundingUtxos: await toCborFundingUtxos(address, utxos),
      };
    })();
    cache.set(address, existing);
  }
  return existing;
}

async function fetchClaimableNight(
  address: string,
  blockfrostKey: string,
  sponsorAddresses: string[],
  fundingCache: Map<string, Promise<FundingSource | null>>
): Promise<bigint> {
  const scheduledClaimable = await fetchClaimableFromSchedule(address);
  if (scheduledClaimable !== null) return scheduledClaimable;

  const candidates = [address, ...sponsorAddresses.filter((candidate) => candidate !== address)];

  for (const candidateAddress of candidates) {
    const fundingSource = await loadFundingSource(candidateAddress, blockfrostKey, fundingCache);
    if (!fundingSource) continue;

    const preview = await buildMidnightClaimPreview(address, fundingSource);
    if (preview.ok) return preview.redeemedAmount;
    if (!preview.retryable) return BigInt(0);
  }

  return BigInt(0);
}

/**
 * POST /api/balances
 * Checks ADA + on-chain NIGHT token via Koios in batches of 10.
 * Checks both base (addr1q) and enterprise (addr1v) addresses per wallet.
 */
export async function POST(req: NextRequest) {
  const { wallets, sponsorAddress, blockfrostApiKey } = await req.json() as {
    wallets: {
      index: number;
      baseAddress: string;
      baseAddressHex: string;
      enterpriseAddress: string;
      enterpriseAddressHex: string;
    }[];
    sponsorAddress?: string;
    blockfrostApiKey?: string;
  };

  if (!wallets?.length)
    return NextResponse.json({ error: "No wallets" }, { status: 400 });

  const baseAddrs = wallets.map(w => w.baseAddress);
  const entAddrs  = wallets.map(w => w.enterpriseAddress);
  const allAddrs  = [...baseAddrs, ...entAddrs];

  // Maps to fill
  const adaMap: Record<string, string>  = {};   // address → lovelace string
  const nightMap: Record<string, bigint> = {};  // address → raw NIGHT quantity
  let koiosAlive = false;  // track if Koios responded at all
  const blockfrostKey =
    blockfrostApiKey?.trim() || process.env.BLOCKFROST_API_KEY?.trim() || "";

  // Process in chunks of 10 — await each to avoid concurrent Object.assign races
  const batches = chunk(allAddrs, 10);
  for (const batch of batches) {
    const [adaRes, nightRes] = await Promise.all([
      koiosPost<KoiosAddressInfo>("/address_info", { _addresses: batch }),
      koiosPost<KoiosAddressAssetRow>("/address_assets", { _addresses: batch }),
    ]);

    if (adaRes.ok) {
      koiosAlive = true;
      for (const r of adaRes.data) adaMap[r.address] = r.balance ?? "0";
    }
    if (nightRes.ok) {
      koiosAlive = true;
      // Each row is one flat asset entry — filter for NIGHT rows only
      for (const r of nightRes.data) {
        if (r.policy_id === NIGHT_POLICY && r.asset_name === NIGHT_NAME) {
          nightMap[r.address] = (nightMap[r.address] ?? BigInt(0)) + BigInt(r.quantity);
        }
      }
    }

    // Small delay between chunks to respect rate limits
    if (batches.length > 1) await new Promise(r => setTimeout(r, 200));
  }

  if (blockfrostKey) {
    for (const address of allAddrs) {
      const needsAdaFallback = !koiosAlive || !(address in adaMap);
      const needsNightFallback = !koiosAlive || !(address in nightMap);
      if (!needsAdaFallback && !needsNightFallback) continue;

      const utxos = await bf(`/addresses/${address}/utxos`, blockfrostKey) as BlockfrostUtxo[] | null;
      if (!utxos) continue;

      if (needsAdaFallback) {
        const lovelace = utxos.reduce((sum, utxo) => {
          const quantity = utxo.amount.find((amount) => amount.unit === "lovelace")?.quantity ?? "0";
          return sum + BigInt(quantity);
        }, BigInt(0));
        adaMap[address] = lovelace.toString();
      }

      if (needsNightFallback) {
        const nightAmount = utxos.reduce((sum, utxo) => {
          const quantity = utxo.amount.find((amount) => amount.unit === `${NIGHT_POLICY}${NIGHT_NAME}`)?.quantity ?? "0";
          return sum + BigInt(quantity);
        }, BigInt(0));
        nightMap[address] = nightAmount;
      }
    }
  }

  const claimableEntries = await (async () => {
      const autoSponsorAddresses = [
        ...wallets
        .map((w) => ({
          address: w.baseAddress,
          baseLovelace: BigInt(adaMap[w.baseAddress] ?? "0"),
        }))
        .filter((entry) => entry.baseLovelace > BigInt(0))
        .sort((a, b) => (a.baseLovelace > b.baseLovelace ? -1 : a.baseLovelace < b.baseLovelace ? 1 : 0))
        .map((entry) => entry.address),
      ].filter((address, index, arr) => arr.indexOf(address) === index);

      const sponsorAddresses = sponsorAddress
        ? [sponsorAddress]
        : autoSponsorAddresses;

      const fundingCache = new Map<string, Promise<FundingSource | null>>();

      return Promise.all(wallets.map(async (w) => {
        if (!blockfrostKey) return [w.baseAddress, BigInt(0)] as const;
        try {
          const claimable = await fetchClaimableNight(
            w.baseAddress,
            blockfrostKey,
            sponsorAddresses,
            fundingCache
          );
          return [w.baseAddress, claimable] as const;
        } catch {
          return [w.baseAddress, BigInt(0)] as const;
        }
      }));
    })();
  const claimableMap = Object.fromEntries(claimableEntries);

  const balances: WalletBalance[] = wallets.map(w => {
    const baseLov  = BigInt(adaMap[w.baseAddress]      ?? "0");
    const entLov   = BigInt(adaMap[w.enterpriseAddress] ?? "0");
    const totalLov = baseLov + entLov;

    const baseNight  = nightMap[w.baseAddress]       ?? BigInt(0);
    const entNight   = nightMap[w.enterpriseAddress]  ?? BigInt(0);
    const totalNight = baseNight + entNight;
    const claimableNight = claimableMap[w.baseAddress] ?? BigInt(0);

    // ADA display:
    //   "—"          → Koios API not reachable at all
    //   "0.00 ADA"   → Address exists but unused / empty (not returned by Koios, or balance=0)
    //   "X.XX ADA"   → Real balance
    const adaDisplay =
      koiosAlive || blockfrostKey
        ? (Number(totalLov) / 1_000_000).toFixed(2) + " ADA"
        : "—";

    const nightDisplay = totalNight > BigInt(0)
      ? (Number(totalNight) / NIGHT_DECIMALS).toFixed(4) + " NIGHT"
      : "0 NIGHT";
    const claimableDisplay = claimableNight > BigInt(0)
      ? (Number(claimableNight) / NIGHT_DECIMALS).toFixed(6) + " NIGHT"
      : "0 NIGHT";

    return {
      index: w.index,
      baseAddress: w.baseAddress,
      enterpriseAddress: w.enterpriseAddress,
      lovelace: totalLov.toString(),
      nightAmount: totalNight.toString(),
      claimableNight: claimableNight.toString(),
      adaDisplay,
      nightDisplay,
      claimableDisplay,
    };
  });

  return NextResponse.json({ balances });
}
