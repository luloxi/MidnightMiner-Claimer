/**
 * Midnight thaw schedule lookups, shared by /api/balances and the headless claimer.
 * The schedule endpoint needs no Blockfrost key.
 */
import { addressVariants, AddressChain, AddressKind, DerivedWallet } from "./cardano";

export const MIDNIGHT_THAW_API = "https://mainnet.prod.gd.midnighttge.io";

/**
 * A thaw tranche. Observed statuses:
 *   upcoming   — not matured yet
 *   redeemable — matured and unclaimed: this is what "claimable" means
 *   confirmed  — already claimed on-chain
 *   skipped    — window passed unclaimed; the amount rolls into the next tranche
 *   failed     — a claim was attempted and did not land
 */
export interface MidnightThaw {
  amount?: number;
  status?: string;
  thawing_period_start?: string;
  transaction_id?: string | null;
}

export interface MidnightThawSchedule {
  thaws?: MidnightThaw[];
}

export type ScheduleResult =
  | { state: "ok"; thaws: MidnightThaw[] }
  | { state: "none" }              // address has no allocation — a real zero
  | { state: "error"; reason: string }; // lookup failed — NOT a zero

export function midnightHeaders() {
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
export async function fetchSchedule(address: string): Promise<ScheduleResult> {
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

export interface ClaimTarget {
  chain: AddressChain;
  kind: AddressKind;
  address: string;
  redeemable: string;
}

export interface WalletThawSummary {
  claimable: bigint;
  upcoming: bigint;
  skipped: bigint;
  failed: bigint;
  nextThawAt: string | null;
  targets: ClaimTarget[];
  lookupFailed: boolean;
}

/** Scan every address a wallet can produce — the thaw API is keyed per payment address. */
/** Optional observer for every thaw seen, used by the headless claimer to build a thaw calendar. */
export type ThawObserver = (
  variant: { chain: AddressChain; kind: AddressKind; address: string },
  thaw: MidnightThaw
) => void;

export async function fetchWalletThaws(
  wallet: DerivedWallet,
  onThaw?: ThawObserver
): Promise<WalletThawSummary> {
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
      onThaw?.(variant, thaw);
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
