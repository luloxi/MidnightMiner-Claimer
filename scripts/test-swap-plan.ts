/** Offline tests for the NIGHT→ADA swap trigger and quote guards. */
import assert from "node:assert/strict";
import { DEFAULT_SWAP_RULES, planSwap, SwapQuote, validateQuote } from "../src/lib/swap";

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
};
assert.equal(validateQuote(q, DEFAULT_SWAP_RULES, now + 1_000), null);
assert.match(validateQuote(q, DEFAULT_SWAP_RULES, now + 120_000) ?? "", /stale/);
assert.match(validateQuote({ ...q, priceImpactPct: 2.5 }, DEFAULT_SWAP_RULES, now) ?? "", /impact/);
assert.match(validateQuote({ ...q, slippagePct: 1.5 }, DEFAULT_SWAP_RULES, now) ?? "", /slippage/);

console.log("ok - swap trigger rule and quote guards (11 cases)");
