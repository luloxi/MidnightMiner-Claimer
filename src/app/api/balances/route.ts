import { NextRequest, NextResponse } from "next/server";
import {
  addressVariants,
  AddressChain,
  AddressKind,
  BlockfrostUtxo,
  DerivedWallet,
} from "@/lib/cardano";

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
 * A thaw tranche. Observed statuses:
 *   upcoming   — not matured yet
 *   redeemable — matured and unclaimed: this is what "claimable" means
 *   confirmed  — already claimed on-chain
 *   skipped    — window passed unclaimed; the amount rolls into the next tranche
 *   failed     — a claim was attempted and did not land
 */
interface MidnightThaw {
  amount?: number;
  status?: string;
  thawing_period_start?: string;
  transaction_id?: string | null;
}

interface MidnightThawSchedule {
  thaws?: MidnightThaw[];
}

type ScheduleResult =
  | { state: "ok"; thaws: MidnightThaw[] }
  | { state: "none" }              // address has no allocation — a real zero
  | { state: "error"; reason: string }; // lookup failed — NOT a zero

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

/**
 * The schedule endpoint is the authority on what is claimable, and it needs no Blockfrost key.
 * A transport failure must never be reported as "nothing to claim", so it is surfaced as an error.
 */
async function fetchSchedule(address: string): Promise<ScheduleResult> {
  let lastReason = "unknown";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${MIDNIGHT_THAW_API}/thaws/${address}/schedule`, {
        method: "GET",
        headers: midnightHeaders(),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.ok) {
        const data = await res.json() as MidnightThawSchedule;
        return { state: "ok", thaws: data.thaws ?? [] };
      }

      const body = await res.json().catch(() => null) as { type?: string } | null;
      // "no allocation for this address" is a definitive zero, not a failure.
      if (body?.type === "no_redeemable_thaws") return { state: "none" };

      lastReason = `HTTP ${res.status}${body?.type ? ` (${body.type})` : ""}`;
      if (res.status < 500 && res.status !== 429) return { state: "error", reason: lastReason };
    } catch (err) {
      lastReason = String(err);
    }

    await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
  }

  return { state: "error", reason: lastReason };
}

interface ClaimTarget {
  chain: AddressChain;
  kind: AddressKind;
  address: string;
  redeemable: string;
}

interface WalletThawSummary {
  claimable: bigint;
  upcoming: bigint;
  skipped: bigint;
  failed: bigint;
  nextThawAt: string | null;
  targets: ClaimTarget[];
  lookupFailed: boolean;
}

/** Scan every address a wallet can produce — the thaw API is keyed per payment address. */
async function fetchWalletThaws(wallet: DerivedWallet): Promise<WalletThawSummary> {
  const summary: WalletThawSummary = {
    claimable: BigInt(0),
    upcoming: BigInt(0),
    skipped: BigInt(0),
    failed: BigInt(0),
    nextThawAt: null,
    targets: [],
    lookupFailed: false,
  };

  for (const variant of addressVariants(wallet)) {
    const result = await fetchSchedule(variant.address);
    if (result.state === "error") {
      summary.lookupFailed = true;
      continue;
    }
    if (result.state === "none") continue;

    let redeemableHere = BigInt(0);
    for (const thaw of result.thaws) {
      const amount = BigInt(thaw.amount ?? 0);
      switch (thaw.status) {
        case "redeemable":
          redeemableHere += amount;
          break;
        case "upcoming":
          summary.upcoming += amount;
          if (
            thaw.thawing_period_start &&
            (!summary.nextThawAt || thaw.thawing_period_start < summary.nextThawAt)
          ) {
            summary.nextThawAt = thaw.thawing_period_start;
          }
          break;
        case "skipped":
          summary.skipped += amount;
          break;
        case "failed":
          summary.failed += amount;
          break;
      }
    }

    if (redeemableHere > BigInt(0)) {
      summary.claimable += redeemableHere;
      summary.targets.push({
        chain: variant.chain,
        kind: variant.kind,
        address: variant.address,
        redeemable: redeemableHere.toString(),
      });
    }
  }

  return summary;
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

  // Thaw lookups are independent of Blockfrost — a missing key must not zero out the claimable column.
  const thawEntries = await Promise.all(
    wallets.map(async (w) => [w.baseAddress, await fetchWalletThaws(w)] as const)
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
