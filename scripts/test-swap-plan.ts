/** Offline tests for the NIGHT→ADA swap trigger and quote guards. */
import assert from "node:assert/strict";
import { DEFAULT_SWAP_RULES, pickBestQuote, planSwap, PoolReserves, SwapQuote, validateQuote } from "../src/lib/swap";

const ADA = (n: number) => BigInt(Math.round(n * 1_000_000));
const NIGHT = (n: number) => BigInt(Math.round(n * 1_000_000));
const price = 0.2; // ADA per NIGHT, so lovelace per raw unit is the same number

// 1. Paymaster covers pending claims: no swap.
let p = planSwap({ paymasterTop3: ADA(40), pendingClaimCost: ADA(30), topupCapacity: ADA(0), sellerNightRaw: NIGHT(1000), lovelacePerNightRaw: price });
assert.equal(p.trigger, false);

// 2. Short, but own addresses can top up: no swap.
p = planSwap({ paymasterTop3: ADA(10), pendingClaimCost: ADA(30), topupCapacity: ADA(25), sellerNightRaw: NIGHT(1000), lovelacePerNightRaw: price });
assert.equal(p.trigger, false);
assert.match(p.reason, /top/);

// 3. Short and top-ups can't cover it: sell shortfall - capacity + 5 ADA buffer, floored at 100 NIGHT.
p = planSwap({ paymasterTop3: ADA(10), pendingClaimCost: ADA(30), topupCapacity: ADA(0), sellerNightRaw: NIGHT(1000), lovelacePerNightRaw: price });
assert.equal(p.trigger, true);
// need 33, short 23, +5 buffer = 28 ADA → 140 NIGHT
assert.equal(p.trigger && p.nightIn, NIGHT(140));

// 4. Small shortfall still sells the 100 NIGHT minimum.
p = planSwap({ paymasterTop3: ADA(32), pendingClaimCost: ADA(30), topupCapacity: ADA(0), sellerNightRaw: NIGHT(1000), lovelacePerNightRaw: price });
assert.equal(p.trigger && p.nightIn, NIGHT(100));

// 5. Huge shortfall is capped at 300 NIGHT.
p = planSwap({ paymasterTop3: ADA(0), pendingClaimCost: ADA(500), topupCapacity: ADA(0), sellerNightRaw: NIGHT(10_000), lovelacePerNightRaw: price });
assert.equal(p.trigger && p.nightIn, DEFAULT_SWAP_RULES.capNightRaw);

// 6. Seller doesn't hold enough NIGHT: no swap.
p = planSwap({ paymasterTop3: ADA(10), pendingClaimCost: ADA(30), topupCapacity: ADA(0), sellerNightRaw: NIGHT(50), lovelacePerNightRaw: price });
assert.equal(p.trigger, false);

// 7. Partial top-up capacity reduces the NIGHT sold.
p = planSwap({ paymasterTop3: ADA(10), pendingClaimCost: ADA(60), topupCapacity: ADA(20), sellerNightRaw: NIGHT(1000), lovelacePerNightRaw: price });
// need 63, short 53, minus 20 capacity, +5 = 38 ADA → 190 NIGHT
assert.equal(p.trigger && p.nightIn, NIGHT(190));

// Quote guards
const now = 1_000_000;
const q: SwapQuote = {
  nightIn: NIGHT(100), adaOut: ADA(20), minAdaOut: ADA(19.8), lpFee: ADA(0.06), dexFee: ADA(0), aggregatorFee: ADA(0),
  deposits: ADA(0), priceImpactPct: 0.3, slippagePct: 1, route: "MinswapV2 100%", fetchedAt: now, request: {},
  hops: [{ protocol: "MinswapV2", poolOutRef: "deep#1", amountIn: NIGHT(100) }], netLovelace: ADA(20), label: "MinswapV2",
};
assert.equal(validateQuote(q, DEFAULT_SWAP_RULES, now + 1_000), null);
assert.match(validateQuote(q, DEFAULT_SWAP_RULES, now + 120_000) ?? "", /stale/);
assert.match(validateQuote({ ...q, priceImpactPct: 2.5 }, DEFAULT_SWAP_RULES, now) ?? "", /impact/);
assert.match(validateQuote({ ...q, slippagePct: 1.5 }, DEFAULT_SWAP_RULES, now) ?? "", /slippage/);

// Best net route wins, among quotes that pass the guards and the depth floor.
async function routeTests() {
  const pools: Record<string, PoolReserves> = {
    "deep#1": { lovelace: ADA(3_800_000), night: NIGHT(19_000_000) },
    "mid#4": { lovelace: ADA(4_600), night: NIGHT(14_900) },
    "tiny#0": { lovelace: ADA(400), night: NIGHT(2_000) },
  };
  const lookup = async (ref: string) => pools[ref] ?? null;
  const single = { ...q, adaOut: ADA(19.94), dexFee: ADA(2), netLovelace: ADA(17.94), label: "MinswapV2" };
  const best = { ...q, adaOut: ADA(20.1), dexFee: ADA(0.1), aggregatorFee: ADA(0.85), netLovelace: ADA(19.15), label: "best-route",
    hops: [{ protocol: "DanogoCLMMV1", poolOutRef: "mid#4", amountIn: NIGHT(100) }] };
  let r = await pickBestQuote([single, best], lookup, DEFAULT_SWAP_RULES, now);
  assert.equal(r.best?.label, "best-route", "higher net ADA wins");

  // Best route through a pool below the depth floor is rejected; the single pool wins.
  const shallow = { ...best, netLovelace: ADA(19.5), hops: [{ protocol: "X", poolOutRef: "tiny#0", amountIn: NIGHT(100) }] };
  r = await pickBestQuote([single, shallow], lookup, DEFAULT_SWAP_RULES, now);
  assert.equal(r.best?.label, "MinswapV2");
  assert.match(r.considered.find((c) => c.label === "best-route")?.rejected ?? "", /pool holds only/);

  // Trade larger than 5% of the pool's NIGHT is rejected.
  const big = { ...best, nightIn: NIGHT(1_000), hops: [{ protocol: "DanogoCLMMV1", poolOutRef: "mid#4", amountIn: NIGHT(1_000) }] };
  r = await pickBestQuote([big], lookup, DEFAULT_SWAP_RULES, now);
  assert.equal(r.best, null);

  // Impact over 2% loses even with the best net.
  r = await pickBestQuote([single, { ...best, priceImpactPct: 2.4 }], lookup, DEFAULT_SWAP_RULES, now);
  assert.equal(r.best?.label, "MinswapV2");

  // Unknown pool reserves are rejected.
  r = await pickBestQuote([{ ...best, hops: [{ protocol: "Y", poolOutRef: "nope#9", amountIn: NIGHT(100) }] }], lookup, DEFAULT_SWAP_RULES, now);
  assert.equal(r.best, null);
  console.log("ok - best-net route selection with depth floor (5 cases)");
}

console.log("ok - swap trigger rule and quote guards (11 cases)");
routeTests().catch((err) => { console.error("FAIL", err instanceof Error ? err.message : err); process.exit(1); });
