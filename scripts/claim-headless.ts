/**
 * Headless NIGHT claimer. Runs without the Next server and reuses src/lib/claim.ts, so a claim
 * built here is exactly what POST /api/claim would build, except that one paymaster wallet
 * (possibly from the other seed) funds every claim.
 *
 *   npm run claim:headless                 # dry-run report (default): builds + signs in memory, never submits
 *   npm run claim:headless -- --accounts 10
 *   npm run claim:headless -- --live       # submit the claims (needs Luciano's explicit OK)
 *
 * Secrets come only from the environment: MIDNIGHT_SEED_1, MIDNIGHT_SEED_2, BLOCKFROST_API_KEY.
 * They are read once, removed from process.env, never printed, and every error is scrubbed.
 * NIGHT is never moved out of the wallet that claimed it. ADA top-ups and NIGHT→ADA swaps are
 * only quoted, never submitted, in any mode.
 *
 * Exit codes: 0 = finished cleanly (including "nothing to claim"), 1 = something failed, 2 = bad usage.
 */
import { validateMnemonic } from "bip39";
import {
  addressVariants,
  AddressChain,
  AddressKind,
  BlockfrostUtxo,
  buildAdaTx,
  deriveSigningKey,
  deriveWalletsMultiAccount,
  NIGHT_NAME,
  NIGHT_POLICY,
} from "../src/lib/cardano";
import { BF, bf, MAX_FUNDING_UTXOS, MIN_FUNDING_LOVELACE, runClaim, sleep, txFeeLovelace } from "../src/lib/claim";
import { fetchWalletThaws, MidnightThaw } from "../src/lib/thaws";

const SEED_VARS = ["MIDNIGHT_SEED_1", "MIDNIGHT_SEED_2"] as const;
const NIGHT_UNIT = `${NIGHT_POLICY}${NIGHT_NAME}`;
const CONFIRM_TIMEOUT_MS = 5 * 60_000;
const MINSWAP_AGG = "https://agg-api.minswap.org/aggregator/estimate";

// ── Secrets (read once, then removed from process.env) ────────────────────────

const seeds = SEED_VARS.map((name, i) => ({ name, no: i + 1, value: (process.env[name] ?? "").trim() }));
const blockfrostKey = (process.env.BLOCKFROST_API_KEY ?? "").trim();
for (const name of [...SEED_VARS, "BLOCKFROST_API_KEY"]) delete process.env[name];

const secrets = [...seeds.map((s) => s.value), blockfrostKey].filter((s) => s.length >= 8);

/** Strip anything secret-looking from a message before it is printed. */
export function scrub(input: unknown): string {
  let text = input instanceof Error ? input.message : String(input);
  for (const secret of secrets) {
    text = text.split(secret).join("[redacted]");
    const collapsed = secret.replace(/\s+/g, " ");
    if (collapsed !== secret) text = text.split(collapsed).join("[redacted]");
  }
  return text
    .replace(/\b(?:mainnet|preprod|preview)[A-Za-z0-9]{20,}\b/g, "[redacted-key]")
    .replace(/\b(?:xprv|xsk|ed25519e?_sk|acct_xsk|root_xsk)1[0-9a-z]+\b/g, "[redacted-key]")
    .replace(/\b[0-9a-fA-F]{100,}\b/g, "[redacted-hex]")
    .replace(/\b((?:addr|stake)1[0-9a-z]{4})[0-9a-z]{20,}([0-9a-z]{6})\b/g, "$1…$2")
    .slice(0, 600);
}

const short = (a: string) => (a.length > 20 ? `${a.slice(0, 9)}…${a.slice(-6)}` : a);
const ada = (l: string | bigint | number) => `${(Number(l) / 1_000_000).toFixed(6)} ADA`;
const adaSigned = (l: bigint) => `${l >= BigInt(0) ? "+" : "-"}${ada(l >= BigInt(0) ? l : -l)}`;
const adaN = (l: string | bigint | number) => (Number(l) / 1_000_000).toFixed(2);
const nightN = (raw: string | bigint | number) => (Number(raw) / 1_000_000).toFixed(6);
const lovelaceOf = (u: BlockfrostUtxo) => BigInt(u.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
const nightOf = (u: BlockfrostUtxo) => BigInt(u.amount.find((a) => a.unit === NIGHT_UNIT)?.quantity ?? "0");
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, BigInt(0));

// ── CLI ───────────────────────────────────────────────────────────────────────

function usage(code = 2): never {
  console.log(`Usage: npm run claim:headless -- [--report] [--live] [--accounts N] [--addresses N] [--paymaster SEED:ACCOUNT]

  --report             dry-run report (this is the default; the flag is accepted for clarity)
  --accounts N         accounts scanned per seed (env CLAIM_ACCOUNTS, default 5)
  --addresses N        address indexes per account (env CLAIM_ADDRESSES_PER_ACCOUNT, default 1)
  --paymaster S:A      force the fee payer to seed S, account A (external base address, index 0).
                       Default: the scanned address holding the most ADA.
  --live               submit the claim transactions. Top-ups and swaps are never submitted.`);
  process.exit(code);
}

function parseIntArg(value: string | undefined, label: string, max: number, min = 1): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`${label} must be an integer between ${min} and ${max}`);
    process.exit(2);
  }
  return n;
}

const argv = process.argv.slice(2);
let live = false;
let accounts = parseIntArg(process.env.CLAIM_ACCOUNTS ?? "5", "CLAIM_ACCOUNTS", 200);
let addressesPerAccount = parseIntArg(process.env.CLAIM_ADDRESSES_PER_ACCOUNT ?? "1", "CLAIM_ADDRESSES_PER_ACCOUNT", 50);
let forcedPaymaster: { seed: number; account: number } | null = null;
for (let i = 0; i < argv.length; i++) {
  const [arg, inline] = argv[i].split("=", 2);
  const next = () => inline ?? argv[++i];
  if (arg === "--live") live = true;
  else if (arg === "--report" || arg === "--dry-run") { /* default mode */ }
  else if (arg === "--accounts") accounts = parseIntArg(next(), "--accounts", 200);
  else if (arg === "--addresses") addressesPerAccount = parseIntArg(next(), "--addresses", 50);
  else if (arg === "--paymaster") {
    const [s, a] = String(next() ?? "").split(":");
    forcedPaymaster = { seed: parseIntArg(s, "--paymaster seed", 2), account: parseIntArg(a, "--paymaster account", 200, 0) };
  } else if (arg === "--help" || arg === "-h") usage(0);
  else {
    console.error(`Unknown argument: ${argv[i]}`);
    usage();
  }
}

// ── Chain helpers ─────────────────────────────────────────────────────────────

async function utxosOf(address: string): Promise<BlockfrostUtxo[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BF}/addresses/${address}/utxos?count=100`, {
      headers: { project_id: blockfrostKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) return [];
    if (res.ok) return res.json() as Promise<BlockfrostUtxo[]>;
    if (res.status !== 429 || attempt >= 4) {
      throw new Error(`Blockfrost ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(1_000 * 2 ** attempt);
  }
}

async function waitForConfirmation(txHash: string): Promise<boolean> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const res = await fetch(`${BF}/txs/${txHash}`, {
      headers: { project_id: blockfrostKey },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (res?.ok && ((await res.json()) as { block?: string | null }).block) return true;
  }
  return false;
}

interface SwapQuote {
  nightIn: bigint;
  adaOut: bigint;
  minAdaOut: bigint;
  lpFee: bigint;
  dexFee: bigint;
  aggregatorFee: bigint;
  deposits: bigint;
  priceImpactPct: number;
  route: string;
}

async function quoteNightToAda(nightRaw: bigint): Promise<SwapQuote | null> {
  try {
    const res = await fetch(MINSWAP_AGG, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amount: nightRaw.toString(),
        token_in: NIGHT_UNIT,
        token_out: "lovelace",
        slippage: 0.5,
        allow_multi_hops: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const d = await res.json() as {
      amount_out: string; min_amount_out: string; total_lp_fee: string; total_dex_fee: string;
      aggregator_fee?: string; deposits?: string; avg_price_impact: number;
      paths: { protocol: string; amount_in: string }[][];
    };
    const legs = d.paths.flat().map((p) => `${p.protocol} ${((Number(p.amount_in) / Number(nightRaw)) * 100).toFixed(0)}%`);
    return {
      nightIn: nightRaw,
      adaOut: BigInt(d.amount_out),
      minAdaOut: BigInt(d.min_amount_out),
      lpFee: BigInt(d.total_lp_fee),
      dexFee: BigInt(d.total_dex_fee),
      aggregatorFee: BigInt(d.aggregator_fee ?? "0"),
      deposits: BigInt(d.deposits ?? "0"),
      priceImpactPct: d.avg_price_impact,
      route: legs.join(" + "),
    };
  } catch {
    return null;
  }
}

// ── Model ─────────────────────────────────────────────────────────────────────

interface AddrInfo {
  seedNo: number;
  mnemonic: string;
  accountIndex: number;
  index: number;
  chain: AddressChain;
  kind: AddressKind;
  address: string;
  utxos: BlockfrostUtxo[];
  lovelace: bigint;
  top3Lovelace: bigint;
  night: bigint;
}

interface WalletRow {
  seedNo: number;
  mnemonic: string;
  accountIndex: number;
  index: number;
  baseAddress: string;
  lovelace: bigint;
  night: bigint;
  claimable: bigint;
  nextThawAt: string | null;
  lookupFailed: boolean;
  targets: { chain: AddressChain; kind: AddressKind; address: string; redeemable: string }[];
}

function top3(utxos: BlockfrostUtxo[]) {
  const pure = utxos.filter((u) => u.amount.length === 1).map(lovelaceOf).sort((a, b) => (a > b ? -1 : 1));
  const tok = utxos.filter((u) => u.amount.length > 1).map(lovelaceOf).sort((a, b) => (a > b ? -1 : 1));
  return sum([...pure, ...tok].slice(0, MAX_FUNDING_UTXOS));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  console.log(`NIGHT headless claimer · ${live ? "LIVE (claims WILL be submitted)" : "DRY-RUN report (nothing is submitted)"}`);
  console.log(`Scan: ${accounts} account(s) × ${addressesPerAccount} index(es) per seed × 4 address variants`);
  for (const s of seeds) console.log(`${s.name}: ${s.value ? "set" : "not set"}`);
  console.log(`BLOCKFROST_API_KEY: ${blockfrostKey ? "set" : "not set"}`);

  let problems = 0;
  const addrs: AddrInfo[] = [];
  const rows: WalletRow[] = [];
  const calendar = new Map<string, Map<string, bigint>>(); // date -> status -> amount

  for (const seed of seeds) {
    if (!seed.value) { console.log(`${seed.name} is not set, skipping.`); continue; }
    if (!validateMnemonic(seed.value)) { console.log(`${seed.name} is not a valid BIP39 mnemonic, skipping.`); problems++; continue; }

    const wallets = await deriveWalletsMultiAccount(seed.value, addressesPerAccount, accounts);
    for (const wallet of wallets) {
      const thaws = await fetchWalletThaws(wallet, (_v, thaw: MidnightThaw) => {
        const date = (thaw.thawing_period_start ?? "unknown").slice(0, 10);
        const status = thaw.status ?? "unknown";
        const byStatus = calendar.get(date) ?? new Map<string, bigint>();
        byStatus.set(status, (byStatus.get(status) ?? BigInt(0)) + BigInt(thaw.amount ?? 0));
        calendar.set(date, byStatus);
      }).catch((err) => { console.log(`thaw lookup error: ${scrub(err)}`); return null; });

      const row: WalletRow = {
        seedNo: seed.no, mnemonic: seed.value, accountIndex: wallet.accountIndex, index: wallet.index,
        baseAddress: wallet.baseAddress, lovelace: BigInt(0), night: BigInt(0),
        claimable: thaws?.claimable ?? BigInt(0), nextThawAt: thaws?.nextThawAt ?? null,
        lookupFailed: !thaws || thaws.lookupFailed, targets: thaws?.targets ?? [],
      };
      if (row.lookupFailed) problems++;

      if (blockfrostKey) {
        for (const v of addressVariants(wallet)) {
          try {
            const utxos = await utxosOf(v.address);
            const info: AddrInfo = {
              seedNo: seed.no, mnemonic: seed.value, accountIndex: wallet.accountIndex, index: wallet.index,
              chain: v.chain, kind: v.kind, address: v.address, utxos,
              lovelace: sum(utxos.map(lovelaceOf)), top3Lovelace: top3(utxos), night: sum(utxos.map(nightOf)),
            };
            addrs.push(info);
            row.lovelace += info.lovelace;
            row.night += info.night;
          } catch (err) {
            console.log(`UTxO lookup failed for ${short(v.address)}: ${scrub(err)}`);
            problems++;
          }
        }
      }
      rows.push(row);
    }
  }

  // 1. Wallet table
  console.log(`\n## 1. Wallets`);
  console.log(`seed | acct/idx | address         | ADA        | NIGHT held      | claimable now   | next thaw`);
  for (const r of rows) {
    console.log(
      `${r.seedNo}    | ${r.accountIndex}/${r.index}      | ${short(r.baseAddress)} | ${adaN(r.lovelace).padStart(10)} | ` +
      `${nightN(r.night).padStart(15)} | ${(r.lookupFailed && r.claimable === BigInt(0) ? "lookup failed" : nightN(r.claimable)).padStart(15)} | ` +
      `${r.nextThawAt ?? "-"}`
    );
  }
  const totalClaimable = sum(rows.map((r) => r.claimable));
  console.log(`Totals: ADA ${adaN(sum(rows.map((r) => r.lovelace)))} · NIGHT held ${nightN(sum(rows.map((r) => r.night)))} · claimable ${nightN(totalClaimable)}`);

  if (!blockfrostKey) {
    console.log(`\nBLOCKFROST_API_KEY is not set: balances, paymaster and claim fees need it. Stopping after the thaw scan.`);
    printCalendar(calendar);
    return totalClaimable > BigInt(0) ? 1 : problems > 0 ? 1 : 0;
  }

  // 3a. Paymaster choice
  const ranked = [...addrs].sort((a, b) => (a.lovelace > b.lovelace ? -1 : a.lovelace < b.lovelace ? 1 : 0));
  const paymaster = forcedPaymaster
    ? addrs.find((a) => a.seedNo === forcedPaymaster!.seed && a.accountIndex === forcedPaymaster!.account && a.index === 0 && a.chain === 0 && a.kind === "base")
    : ranked[0];
  console.log(`\n## 3. Paymaster`);
  console.log(`Richest addresses: ${ranked.slice(0, 3).map((a) => `seed ${a.seedNo} acct ${a.accountIndex} ${a.kind}/${a.chain} ${short(a.address)} ${adaN(a.lovelace)} ADA (top-3 UTxOs ${adaN(a.top3Lovelace)})`).join(" · ") || "none"}`);
  if (!paymaster || paymaster.lovelace === BigInt(0)) {
    console.log(`No address with ADA found, so no paymaster is available.`);
    printCalendar(calendar);
    return totalClaimable > BigInt(0) ? 1 : problems > 0 ? 1 : 0;
  }
  console.log(`Paymaster: seed ${paymaster.seedNo} · acct ${paymaster.accountIndex} · ${paymaster.kind}/${paymaster.chain === 0 ? "external" : "change"} · ${short(paymaster.address)} · ${adaN(paymaster.lovelace)} ADA, ${adaN(paymaster.top3Lovelace)} in its 3 largest UTxOs`);
  const { signingKeyHex: paymasterKey } = await deriveSigningKey(
    paymaster.mnemonic, paymaster.accountIndex, paymaster.index, paymaster.chain, paymaster.kind
  );

  // 2. Claims
  console.log(`\n## 2. Claims (${live ? "submitting" : "built in memory, not submitted"})`);
  const claimFees: bigint[] = [];
  const outflows: bigint[] = [];
  let submitted = 0;
  for (const r of rows) {
    for (const t of r.targets) {
      const label = `seed ${r.seedNo} acct ${r.accountIndex}/${r.index} ${t.kind}/${t.chain === 0 ? "ext" : "chg"} ${short(t.address)} ${nightN(t.redeemable)} NIGHT`;
      try {
        const result = await runClaim(
          {
            mnemonic: r.mnemonic,
            fromAccountIndex: r.accountIndex,
            fromAddressIndex: r.index,
            fromChain: t.chain,
            fromAddressKind: t.kind,
            blockfrostApiKey: blockfrostKey,
            paymaster: { address: paymaster.address, signingKeyHex: paymasterKey },
          },
          { submit: live }
        );
        if (result.kind === "built") {
          claimFees.push(BigInt(result.feeLovelace));
          outflows.push(BigInt(result.sponsorOutflowLovelace));
          console.log(`${label}: fee ${ada(result.feeLovelace)} · paymaster net ADA change ${adaSigned(-BigInt(result.sponsorOutflowLovelace))} · NOT submitted`);
        } else if (result.kind === "submitted") {
          submitted++;
          claimFees.push(BigInt(result.feeLovelace));
          console.log(`${label}: SUBMITTED · fee ${ada(result.feeLovelace)}\n    tx ${result.txHash}\n    ${result.explorerUrl}`);
          const ok = await waitForConfirmation(result.txHash);
          console.log(ok ? `    confirmed` : `    not confirmed after 5 min, stopping so UTxOs are not double-spent`);
          if (!ok) return 1;
        } else if (result.kind === "no_redeemable") {
          console.log(`${label}: no redeemable thaw at build time${result.nextThawAt ? `, next ${result.nextThawAt}` : ""}`);
        } else {
          problems++;
          console.log(`${label}: ${result.kind}${"error" in result ? `: ${scrub(result.error)}` : ""}`);
        }
      } catch (err) {
        problems++;
        console.log(`${label}: error: ${scrub(err)}`);
      }
    }
  }
  if (!claimFees.length) console.log(`No claim was built (nothing claimable right now).`);

  // 3b. Paymaster budget
  // Claims run one after another, so the worst case is every costly claim landing before any refund.
  const positive = sum(outflows.filter((o) => o > BigInt(0)));
  const need = positive + MIN_FUNDING_LOVELACE;
  const shortfall = need > paymaster.top3Lovelace ? need - paymaster.top3Lovelace : BigInt(0);
  console.log(`\nPaymaster budget: ${outflows.length} claim(s) · fees ${ada(sum(claimFees))} · net paymaster ADA change ${adaSigned(-sum(outflows))}`);
  console.log(`Needed up front: ${ada(positive)} worst-case outflow + ${ada(MIN_FUNDING_LOVELACE)} the thaw endpoint requires in the 3 largest UTxOs = ${ada(need)}`);
  console.log(`Paymaster has ${ada(paymaster.top3Lovelace)} in its 3 largest UTxOs → ${shortfall > BigInt(0) ? `SHORT by ${ada(shortfall)}` : "covered"}`);
  console.log(`Note: claims are built one by one against the same UTxOs, so in --live each claim waits for the previous one to confirm.`);

  // 2b. Top-up fee (built in memory only, never submitted)
  console.log(`\n## 2b. ADA top-up (built in memory, never submitted)`);
  const pp = await bf("/epochs/latest/parameters", blockfrostKey) as { min_fee_a: number; min_fee_b: number };
  const latest = await bf("/blocks/latest", blockfrostKey) as { slot: number };
  const donor = ranked.find((a) => a.address !== paymaster.address && a.lovelace >= BigInt(5_000_000));
  const topupAmount = shortfall > BigInt(1_000_000) ? shortfall + BigInt(500_000) : BigInt(2_000_000);
  if (donor) {
    try {
      const { signingKeyHex, baseAddressHex } = await deriveSigningKey(donor.mnemonic, donor.accountIndex, donor.index, donor.chain, donor.kind);
      const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
      const txHex = await buildAdaTx({
        utxos: donor.utxos,
        senderAddrHex: baseAddressHex,
        recipientAddrHex: Buffer.from(lib.Address.from_bech32(paymaster.address).to_bytes()).toString("hex"),
        sendAll: false,
        amountLovelace: topupAmount,
        signingKeyHex,
        currentSlot: latest.slot,
      });
      const fee = await txFeeLovelace(txHex);
      const minFee = BigInt(pp.min_fee_a) * BigInt(txHex.length / 2) + BigInt(pp.min_fee_b);
      console.log(`Sample top-up ${ada(topupAmount)} from seed ${donor.seedNo} acct ${donor.accountIndex} ${short(donor.address)} → paymaster: fee set ${ada(fee)} (buildAdaTx fixed fee) · protocol minimum for its ${txHex.length / 2} bytes ${ada(minFee)} · NOT submitted`);
    } catch (err) {
      problems++;
      console.log(`Top-up build failed: ${scrub(err)}`);
    }
  } else {
    const minFee = BigInt(pp.min_fee_a) * BigInt(300) + BigInt(pp.min_fee_b);
    console.log(`No second address with ≥5 ADA to build a sample top-up. Estimate for a ~300-byte ADA transfer: ${ada(minFee)} protocol minimum, 0.25 ADA as buildAdaTx sets it.`);
  }
  if (shortfall > BigInt(0)) {
    const donors = ranked.filter((a) => a.address !== paymaster.address && a.lovelace > BigInt(3_000_000));
    const spare = sum(donors.map((d) => d.lovelace - BigInt(2_000_000)));
    console.log(`Other addresses could spare about ${ada(spare)} (keeping 2 ADA each) → ${spare >= shortfall ? "top-ups cover the shortfall" : "top-ups do NOT cover it, a NIGHT→ADA swap would be needed"}`);
  }

  // 4. Swap quotes
  console.log(`\n## 4. NIGHT → ADA quotes (Minswap aggregator, best route; quote only, nothing is built or sent)`);
  const sizes = [10, 100, 1_000, 10_000].map((n) => BigInt(n) * BigInt(1_000_000));
  const priceProbe = await quoteNightToAda(BigInt(1_000) * BigInt(1_000_000));
  if (shortfall > BigInt(0) && priceProbe) {
    const nightPerLovelace = Number(priceProbe.nightIn) / Number(priceProbe.adaOut);
    sizes.unshift(BigInt(Math.ceil(Number(shortfall + BigInt(5_000_000)) * nightPerLovelace)));
  }
  if (totalClaimable > BigInt(0)) sizes.push(totalClaimable);
  console.log(`NIGHT in      | ADA out      | min out (0.5%) | LP fee   | DEX/batcher | agg fee | refundable dep | impact | all-in cost | route`);
  for (const size of sizes) {
    const q = await quoteNightToAda(size);
    if (!q) { console.log(`${nightN(size)}: quote unavailable`); continue; }
    const spot = priceProbe ? Number(priceProbe.adaOut) / Number(priceProbe.nightIn) : 0;
    const ideal = spot * Number(size);
    const networkFee = 250_000; // approximate order + network fee
    const costPct = ideal > 0 ? ((ideal - (Number(q.adaOut) - Number(q.dexFee) - Number(q.aggregatorFee) - networkFee)) / ideal) * 100 : NaN;
    console.log(
      `${nightN(size).padStart(13)} | ${adaN(q.adaOut).padStart(12)} | ${adaN(q.minAdaOut).padStart(14)} | ${adaN(q.lpFee).padStart(8)} | ` +
      `${adaN(q.dexFee).padStart(11)} | ${adaN(q.aggregatorFee).padStart(7)} | ${adaN(q.deposits).padStart(14)} | ${q.priceImpactPct.toFixed(2)}% | ` +
      `${Number.isFinite(costPct) ? costPct.toFixed(2) + "%" : "-"} | ${q.route}`
    );
  }
  console.log(`Proposed trigger: swap only if the paymaster's 3 largest UTxOs < pending claim outflow + 3 ADA AND no other address can top it up; then sell just enough NIGHT for shortfall + 5 ADA, never less than ~100 NIGHT so fixed fees stay under ~3%.`);

  printCalendar(calendar);

  console.log(`\nSummary: ${rows.length} wallet(s) · claimable ${nightN(totalClaimable)} NIGHT · ${claimFees.length} claim(s) built · ${live ? `${submitted} submitted` : "0 submitted (dry-run)"} · ${problems} problem(s)`);
  return problems > 0 ? 1 : 0;
}

function printCalendar(calendar: Map<string, Map<string, bigint>>) {
  console.log(`\n## 5. Thaw calendar (all scanned addresses)`);
  const dates = [...calendar.keys()].sort();
  if (!dates.length) { console.log(`No thaw schedule found.`); return; }
  for (const date of dates) {
    const parts = [...calendar.get(date)!.entries()].map(([s, a]) => `${s} ${nightN(a)}`);
    console.log(`${date}: ${parts.join(" · ")}`);
  }
  const upcoming = dates.filter((d) => [...calendar.get(d)!.keys()].includes("upcoming"));
  const pending = dates.filter((d) => [...calendar.get(d)!.keys()].includes("redeemable"));
  if (pending.length) console.log(`Still redeemable from: ${pending.join(", ")}`);
  if (upcoming.length) {
    console.log(`Next thaw dates: ${upcoming.join(", ")}`);
    console.log(`Each address thaws on its own date roughly every 90 days, so across wallets a thaw lands every few days.`);
    console.log(`Suggested cadence: run daily (a run with nothing claimable spends nothing and exits 0), or at minimum on each date above.`);
  }
}

process.on("unhandledRejection", (err) => {
  console.error(`Fatal: ${scrub(err)}`);
  process.exit(1);
});

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`Fatal: ${scrub(err)}`);
    process.exit(1);
  });
