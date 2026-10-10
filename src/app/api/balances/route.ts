import { NextRequest, NextResponse } from "next/server";
import { BlockfrostUtxo, DerivedWallet } from "@/lib/cardano";
import { ClaimTarget, fetchWalletThaws, WalletThawSummary } from "@/lib/thaws";

const KOIOS_API    = "https://api.koios.rest/api/v1";
const BF_API       = "https://cardano-mainnet.blockfrost.io/api/v0";
const NIGHT_POLICY = "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa";
const NIGHT_NAME   = "4e49474854"; // hex of "NIGHT"
const NIGHT_DECIMALS = 1_000_000;

// ── Koios helpers ─────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
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
  claimTargets: ClaimTarget[];
  nextThawAt: string | null;
  upcomingNight: string;
  skippedNight: string;
  failedNight: string;
  lookupFailed: boolean;
}

async function bf(path: string, apiKey: string) {
  const res = await fetch(`${BF_API}${path}`, {
    headers: { project_id: apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * POST /api/balances
 * Checks ADA + on-chain NIGHT token via Koios in batches of 10.
 * Checks both base (addr1q) and enterprise (addr1v) addresses per wallet.
 * Thaw schedules are checked on all four addresses per wallet (external + change, base + enterprise).
 */
export async function POST(req: NextRequest) {
  const { wallets, blockfrostApiKey } = await req.json() as {
    wallets: DerivedWallet[];
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

  // Koios accepts up to 50 addresses. Missing rows mean 0, not "ask Blockfrost".
  const batches = chunk(allAddrs, 50);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
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
      for (const r of nightRes.data) {
        if (r.policy_id === NIGHT_POLICY && r.asset_name === NIGHT_NAME) {
          nightMap[r.address] = (nightMap[r.address] ?? BigInt(0)) + BigInt(r.quantity);
        }
      }
    }

    if (i < batches.length - 1) await new Promise(r => setTimeout(r, 50));
  }

  // Only hit Blockfrost when Koios itself is down — never for "address not in result".
  if (blockfrostKey && !koiosAlive) {
    for (const address of allAddrs) {
      const utxos = await bf(`/addresses/${address}/utxos`, blockfrostKey) as BlockfrostUtxo[] | null;
      if (!utxos) continue;

      const lovelace = utxos.reduce((sum, utxo) => {
        const quantity = utxo.amount.find((amount) => amount.unit === "lovelace")?.quantity ?? "0";
        return sum + BigInt(quantity);
      }, BigInt(0));
      adaMap[address] = lovelace.toString();

      const nightAmount = utxos.reduce((sum, utxo) => {
        const quantity = utxo.amount.find((amount) => amount.unit === `${NIGHT_POLICY}${NIGHT_NAME}`)?.quantity ?? "0";
        return sum + BigInt(quantity);
      }, BigInt(0));
      nightMap[address] = nightAmount;
    }
  }

  // Thaw lookups are independent of Blockfrost — a missing key must not zero out the claimable column.
  const thawEntries = await mapLimit(
    wallets,
    8,
    async (w) => [w.baseAddress, await fetchWalletThaws(w)] as const
  );
  const thawMap = Object.fromEntries(thawEntries) as Record<string, WalletThawSummary>;

  const balances: WalletBalance[] = wallets.map(w => {
    const baseLov  = BigInt(adaMap[w.baseAddress]      ?? "0");
    const entLov   = BigInt(adaMap[w.enterpriseAddress] ?? "0");
    const totalLov = baseLov + entLov;

    const baseNight  = nightMap[w.baseAddress]       ?? BigInt(0);
    const entNight   = nightMap[w.enterpriseAddress]  ?? BigInt(0);
    const totalNight = baseNight + entNight;
    const thaws = thawMap[w.baseAddress];
    const claimableNight = thaws.claimable;

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

    // "—" means the lookup failed: unknown, which is not the same as zero.
    const claimableDisplay = claimableNight > BigInt(0)
      ? (Number(claimableNight) / NIGHT_DECIMALS).toFixed(6) + " NIGHT"
      : thaws.lookupFailed
        ? "—"
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
      claimTargets: thaws.targets,
      nextThawAt: thaws.nextThawAt,
      upcomingNight: thaws.upcoming.toString(),
      skippedNight: thaws.skipped.toString(),
      failedNight: thaws.failed.toString(),
      lookupFailed: thaws.lookupFailed,
    };
  });

  return NextResponse.json({ balances });
}
