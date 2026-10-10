/**
 * NIGHT → ADA swap fallback through the Minswap aggregator (which routes to the deepest
 * NIGHT/ADA pools, Minswap V2 today). Only used when the paymaster cannot cover pending claims and
 * no own address can top it up. The planner is pure so the trigger rule is unit-tested.
 */
import { NIGHT_NAME, NIGHT_POLICY } from "./cardano";

export const NIGHT_UNIT = `${NIGHT_POLICY}${NIGHT_NAME}`;
export const MINSWAP_AGG = "https://agg-api.minswap.org/aggregator";

export interface SwapRules {
  /** Funding floor the thaw endpoint needs in the paymaster's 3 largest UTxOs. */
  floorLovelace: bigint;
  /** Extra ADA bought on top of the shortfall. */
  bufferLovelace: bigint;
  minNightRaw: bigint;
  capNightRaw: bigint;
  maxSlippagePct: number;
  maxPriceImpactPct: number;
  maxQuoteAgeMs: number;
}

export const DEFAULT_SWAP_RULES: SwapRules = {
  floorLovelace: BigInt(3_000_000),
  bufferLovelace: BigInt(5_000_000),
  minNightRaw: BigInt(100_000_000),
  capNightRaw: BigInt(300_000_000),
  maxSlippagePct: 1,
  maxPriceImpactPct: 2,
  maxQuoteAgeMs: 60_000,
};

export interface SwapQuote {
  nightIn: bigint;
  adaOut: bigint;
  minAdaOut: bigint;
  lpFee: bigint;
  dexFee: bigint;
  aggregatorFee: bigint;
  deposits: bigint;
  priceImpactPct: number;
  slippagePct: number;
  route: string;
  hops: { protocol: string; poolOutRef: string; amountIn: bigint }[];
  /** ADA actually received: amount out minus DEX/batcher and aggregator fees (deposits come back). */
  netLovelace: bigint;
  /** Which route request produced it: "best-route" or a single protocol. */
  label: string;
  fetchedAt: number;
  /** Request body that produced this quote, reused verbatim by /build-tx. */
  request: Record<string, unknown>;
}

export type SwapPlan =
  | { trigger: false; reason: string }
  | { trigger: true; shortfallLovelace: bigint; nightIn: bigint; reason: string };

/**
 * Trigger rule: swap only if the paymaster's 3 largest UTxOs are below pending claim cost + floor
 * AND the other own addresses cannot top it up. Sell just enough NIGHT for shortfall + buffer at
 * the given price, never below the minimum, never above the cap or the NIGHT the seller holds.
 */
export function planSwap(input: {
  paymasterTop3: bigint;
  pendingClaimCost: bigint;
  topupCapacity: bigint;
  sellerNightRaw: bigint;
  /** ADA (lovelace) received per 1 raw NIGHT unit at the current quote. */
  lovelacePerNightRaw: number;
  rules?: SwapRules;
}): SwapPlan {
  const rules = input.rules ?? DEFAULT_SWAP_RULES;
  const need = input.pendingClaimCost + rules.floorLovelace;
  if (input.paymasterTop3 >= need) return { trigger: false, reason: "paymaster covers pending claims" };
  const shortfall = need - input.paymasterTop3;
  if (input.topupCapacity >= shortfall) return { trigger: false, reason: "own addresses can top the paymaster up" };
  if (!(input.lovelacePerNightRaw > 0)) return { trigger: false, reason: "no usable price" };

  const target = shortfall - (input.topupCapacity > BigInt(0) ? input.topupCapacity : BigInt(0)) + rules.bufferLovelace;
  let nightIn = BigInt(Math.ceil(Number(target) / input.lovelacePerNightRaw));
  if (nightIn < rules.minNightRaw) nightIn = rules.minNightRaw;
  if (nightIn > rules.capNightRaw) nightIn = rules.capNightRaw;
  if (nightIn > input.sellerNightRaw) {
    return { trigger: false, reason: `seller holds ${input.sellerNightRaw} raw NIGHT, needs ${nightIn}` };
  }
  return { trigger: true, shortfallLovelace: shortfall, nightIn, reason: "paymaster short and top-ups cannot cover it" };
}

/** Reject quotes that are stale, too impactful, or looser than the slippage limit. */
export function validateQuote(q: SwapQuote, rules: SwapRules = DEFAULT_SWAP_RULES, now = Date.now()): string | null {
  if (now - q.fetchedAt > rules.maxQuoteAgeMs) return "quote is stale";
  if (q.priceImpactPct > rules.maxPriceImpactPct) return `price impact ${q.priceImpactPct.toFixed(2)}% > ${rules.maxPriceImpactPct}%`;
  if (q.slippagePct > rules.maxSlippagePct) return `slippage ${q.slippagePct}% > ${rules.maxSlippagePct}%`;
  if (q.minAdaOut <= BigInt(0) || q.adaOut <= BigInt(0)) return "quote returns no ADA";
  return null;
}

/**
 * Quote NIGHT → ADA. With `protocol` the route is pinned to that single DEX (direct pools only);
 * without it the aggregator picks its best route across DEXes, multi-hop allowed.
 */
export async function quoteNightToAda(
  nightRaw: bigint,
  slippagePct = 1,
  protocol?: string
): Promise<SwapQuote | null> {
  const request: Record<string, unknown> = {
    amount: nightRaw.toString(),
    token_in: NIGHT_UNIT,
    token_out: "lovelace",
    slippage: slippagePct,
    allow_multi_hops: !protocol,
    ...(protocol ? { include_protocols: [protocol] } : {}),
  };
  try {
    const res = await fetch(`${MINSWAP_AGG}/estimate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const d = await res.json() as {
      amount_out: string; min_amount_out: string; total_lp_fee: string; total_dex_fee: string;
      aggregator_fee?: string; deposits?: string; avg_price_impact: number;
      paths: { protocol: string; amount_in: string; pool_out_ref: string }[][];
    };
    const route = d.paths.flat()
      .map((p) => `${p.protocol} ${((Number(p.amount_in) / Number(nightRaw)) * 100).toFixed(0)}%`)
      .join(" + ");
    const adaOut = BigInt(d.amount_out);
    const dexFee = BigInt(d.total_dex_fee);
    const aggregatorFee = BigInt(d.aggregator_fee ?? "0");
    return {
      hops: d.paths.flat().map((h) => ({ protocol: h.protocol, poolOutRef: h.pool_out_ref, amountIn: BigInt(h.amount_in) })),
      netLovelace: adaOut - dexFee - aggregatorFee,
      label: protocol ?? "best-route",
      nightIn: nightRaw,
      adaOut,
      minAdaOut: BigInt(d.min_amount_out),
      lpFee: BigInt(d.total_lp_fee),
      dexFee: BigInt(d.total_dex_fee),
      aggregatorFee: BigInt(d.aggregator_fee ?? "0"),
      deposits: BigInt(d.deposits ?? "0"),
      priceImpactPct: d.avg_price_impact,
      slippagePct,
      route,
      fetchedAt: Date.now(),
      request,
    };
  } catch {
    return null;
  }
}

/** Ask the aggregator for the unsigned swap tx (no side effects, nothing is sent to the chain). */
export async function buildSwapTx(sender: string, q: SwapQuote): Promise<string> {
  const res = await fetch(`${MINSWAP_AGG}/build-tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender, min_amount_out: q.minAdaOut.toString(), estimate: q.request }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Minswap build-tx ${res.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { cbor: string }).cbor;
}

/** Sign the aggregator's unsigned tx and return the hex witness set it expects. */
export async function witnessSetFor(unsignedCbor: string, signingKeyHex: string): Promise<string> {
  const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
  const tx = lib.Transaction.from_bytes(Buffer.from(unsignedCbor, "hex"));
  const keyBytes = Buffer.from(signingKeyHex, "hex");
  const privKey = keyBytes.length === 32 ? lib.PrivateKey.from_normal_bytes(keyBytes) : lib.PrivateKey.from_extended_bytes(keyBytes);
  const vkeys = lib.Vkeywitnesses.new();
  vkeys.add(lib.make_vkey_witness(lib.hash_transaction(tx.body()), privKey));
  const ws = lib.TransactionWitnessSet.new();
  ws.set_vkeys(vkeys);
  return Buffer.from(ws.to_bytes()).toString("hex");
}

export async function txFeeOf(cbor: string): Promise<bigint> {
  const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
  return BigInt(lib.Transaction.from_bytes(Buffer.from(cbor, "hex")).body().fee().to_str());
}

/** Submit through the aggregator. Only called by the claimer with --live --allow-swap. */
export async function submitSwap(unsignedCbor: string, witnessSetHex: string): Promise<string> {
  const res = await fetch(`${MINSWAP_AGG}/finalize-and-submit-tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cbor: unsignedCbor, witness_set: witnessSetHex }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Minswap submit ${res.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { tx_id: string }).tx_id;
}

const GECKO_DEX_TO_PROTOCOL: Record<string, string> = {
  "minswap-cardano": "MinswapV2",
  "minswap-v2-cardano": "MinswapV2",
  "sundaeswap-v3": "SundaeSwapV3",
  "sundaeswap-v3-cardano": "SundaeSwapV3",
  "wingriders-v2": "WingRidersV2",
  "wingriders-v2-cardano": "WingRidersV2",
  "splash-cardano": "Splash",
  "cswap-cardano": "CswapV1",
};

/** The DEX with the deepest NIGHT/ADA pool right now (GeckoTerminal reserves), MinswapV2 if unknown. */
export async function deepestNightAdaProtocol(): Promise<{ protocol: string; reserveUsd: number | null }> {
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/cardano/tokens/${NIGHT_UNIT}/pools`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return { protocol: "MinswapV2", reserveUsd: null };
    const d = await res.json() as {
      data: { attributes: { name: string; reserve_in_usd: string }; relationships: { dex: { data: { id: string } } } }[];
    };
    const adaPools = d.data
      .filter((p) => /^NIGHT \/ ADA$|^ADA \/ NIGHT$/.test(p.attributes.name))
      .map((p) => ({ dex: p.relationships.dex.data.id, reserve: Number(p.attributes.reserve_in_usd) }))
      .sort((a, b) => b.reserve - a.reserve);
    const best = adaPools.find((p) => GECKO_DEX_TO_PROTOCOL[p.dex]);
    return best
      ? { protocol: GECKO_DEX_TO_PROTOCOL[best.dex], reserveUsd: best.reserve }
      : { protocol: "MinswapV2", reserveUsd: null };
  } catch {
    return { protocol: "MinswapV2", reserveUsd: null };
  }
}

export type PoolReserves = { lovelace: bigint; night: bigint };
export type ReserveLookup = (poolOutRef: string) => Promise<PoolReserves | null>;

/** Depth floor: every pool on the route must hold real liquidity relative to the trade. */
export const DEPTH_RULES = { minPoolLovelace: BigInt(1_000_000_000), maxShareOfPoolNight: 0.05 };

export async function checkRouteDepth(q: SwapQuote, lookup: ReserveLookup, rules = DEPTH_RULES): Promise<string | null> {
  for (const hop of q.hops) {
    const r = await lookup(hop.poolOutRef);
    if (!r) return `${hop.protocol}: pool reserves unknown`;
    if (r.lovelace < rules.minPoolLovelace) return `${hop.protocol}: pool holds only ${Number(r.lovelace) / 1e6} ADA`;
    if (r.night > BigInt(0) && Number(hop.amountIn) > Number(r.night) * rules.maxShareOfPoolNight) {
      return `${hop.protocol}: trade is over ${rules.maxShareOfPoolNight * 100}% of the pool's NIGHT`;
    }
  }
  return null;
}

/** Pick the valid, deep-enough quote that leaves the most ADA after fees. */
export async function pickBestQuote(
  quotes: (SwapQuote | null)[],
  lookup: ReserveLookup,
  rules: SwapRules = DEFAULT_SWAP_RULES,
  now = Date.now()
): Promise<{ best: SwapQuote | null; considered: { label: string; net: bigint | null; rejected: string | null }[] }> {
  const considered: { label: string; net: bigint | null; rejected: string | null }[] = [];
  let best: SwapQuote | null = null;
  for (const q of quotes) {
    if (!q) { considered.push({ label: "?", net: null, rejected: "no quote" }); continue; }
    const rejected = validateQuote(q, rules, now) ?? (await checkRouteDepth(q, lookup));
    considered.push({ label: q.label, net: q.netLovelace, rejected });
    if (!rejected && (!best || q.netLovelace > best.netLovelace)) best = q;
  }
  return { best, considered };
}

/** Reserves of a pool from its current UTxO, read on Blockfrost. */
export function blockfrostReserveLookup(blockfrostKey: string): ReserveLookup {
  return async (ref) => {
    const [hash, idx] = ref.split("#");
    try {
      const res = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0/txs/${hash}/utxos`, {
        headers: { project_id: blockfrostKey }, signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return null;
      const d = await res.json() as { outputs: { output_index: number; amount: { unit: string; quantity: string }[] }[] };
      const out = d.outputs.find((o) => o.output_index === Number(idx));
      if (!out) return null;
      return {
        lovelace: BigInt(out.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0"),
        night: BigInt(out.amount.find((a) => a.unit === NIGHT_UNIT)?.quantity ?? "0"),
      };
    } catch {
      return null;
    }
  };
}
