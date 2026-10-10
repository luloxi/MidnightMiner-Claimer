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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import {
  buildSwapTx, deepestNightAdaProtocol, DEFAULT_SWAP_RULES, planSwap, quoteNightToAda as quoteSwap,
  submitSwap, txFeeOf, validateQuote, witnessSetFor,
} from "../src/lib/swap";
import { buildTracker } from "./tracker";

const SEED_VARS = ["MIDNIGHT_SEED_1", "MIDNIGHT_SEED_2"] as const;
const NIGHT_UNIT = `${NIGHT_POLICY}${NIGHT_NAME}`;
const CONFIRM_TIMEOUT_MS = 5 * 60_000;
const OUT_DIR = process.env.CLAIM_OUT_DIR ?? "/workspace/midnight";
/** Largest paymaster outflow seen for one claim (~3.27 ADA) plus margin. */
const WORST_CLAIM_OUTFLOW = BigInt(3_600_000);
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
  --accounts N         accounts scanned per seed (env CLAIM_ACCOUNTS, default 30)
  --min-claim X        only claim tranches above X NIGHT (env CLAIM_MIN_NIGHT, default 5); smaller ones
                       are reported as skipped and roll into the next thaw
  --weekly             weekly protocol: claims, top-ups and (if triggered) a swap, then rebuild the
                       tracker workbook at /workspace/midnight/latest-tracker.xlsx
  --allow-swap         with --live, allow the NIGHT→ADA swap fallback to be submitted
  --swap-cap N         most NIGHT one run may sell (env SWAP_CAP_NIGHT, default 300)
  --test-one           exactly one claim: the smallest tranche above the minimum, paid by the
                       richest address of the OTHER seed
  --addresses N        address indexes per account (env CLAIM_ADDRESSES_PER_ACCOUNT, default 1)
  --paymaster S:A      force the fee payer to seed S, account A (external base address, index 0).
                       Default: the scanned address holding the most ADA.
  --live               submit claims, and ADA top-ups between own addresses when a claim needs one.
                       Swaps are never built or submitted.`);
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
let accounts = parseIntArg(process.env.CLAIM_ACCOUNTS ?? "30", "CLAIM_ACCOUNTS", 200);
let addressesPerAccount = parseIntArg(process.env.CLAIM_ADDRESSES_PER_ACCOUNT ?? "1", "CLAIM_ADDRESSES_PER_ACCOUNT", 50);
let testOne = false;
let weekly = false;
let allowSwap = false;
let swapCapNight = Number(process.env.SWAP_CAP_NIGHT ?? "300");
let minClaimNight = Number(process.env.CLAIM_MIN_NIGHT ?? "5");
let forcedPaymaster: { seed: number; account: number } | null = null;
for (let i = 0; i < argv.length; i++) {
  const [arg, inline] = argv[i].split("=", 2);
  const next = () => inline ?? argv[++i];
  if (arg === "--live") live = true;
  else if (arg === "--report" || arg === "--dry-run") { /* default mode */ }
  else if (arg === "--test-one") testOne = true;
  else if (arg === "--weekly") weekly = true;
  else if (arg === "--allow-swap") allowSwap = true;
  else if (arg === "--swap-cap") {
    swapCapNight = Number(next());
    if (!Number.isFinite(swapCapNight) || swapCapNight < 0) { console.error("--swap-cap must be a number ≥ 0"); process.exit(2); }
  }
  else if (arg === "--min-claim") {
    minClaimNight = Number(next());
    if (!Number.isFinite(minClaimNight) || minClaimNight < 0) { console.error("--min-claim must be a number ≥ 0"); process.exit(2); }
  }
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
  variantAddresses: string[];
  thaws: { address: string; kind: AddressKind; chain: AddressChain; amount: number; status: string; date: string | null; txId: string | null }[];
}

interface ClaimRecord {
  seed: number; account: number; index: number; kind: AddressKind; chain: AddressChain;
  shortAddress: string; address: string; night: number;
  status: "dry-run" | "confirmed" | "unconfirmed" | "failed" | "skipped-below-min" | "no-redeemable";
  paymaster: string; txHash?: string; cardanoscan?: string; feeAda?: number; paymasterNetAda?: number;
  timestamp: string; attempt?: number; error?: string;
}

interface TopupRecord {
  from: string; to: string; ada: number; status: "dry-run" | "confirmed" | "unconfirmed" | "failed";
  txHash?: string; feeAda?: number; timestamp: string; error?: string;
}

function baseRecord(
  job: { row: WalletRow; target: WalletRow["targets"][number] },
  pm: { seedNo: number; accountIndex: number; address: string },
  status: ClaimRecord["status"],
  _stamp: string
): ClaimRecord {
  return {
    seed: job.row.seedNo, account: job.row.accountIndex, index: job.row.index,
    kind: job.target.kind, chain: job.target.chain,
    shortAddress: short(job.target.address), address: job.target.address,
    night: Number(job.target.redeemable) / 1e6, status,
    paymaster: `seed ${pm.seedNo} acct ${pm.accountIndex} ${short(pm.address)}`,
    timestamp: new Date().toISOString(),
  };
}

/** After a live test claim: show who funded the tx and where the NIGHT went. */
async function verifyTx(txHash: string, claimer: string, payer: string) {
  const tx = await bf(`/txs/${txHash}/utxos`, blockfrostKey) as {
    inputs: { address: string; amount: { unit: string; quantity: string }[] }[];
    outputs: { address: string; amount: { unit: string; quantity: string }[] }[];
  };
  const net = new Map<string, { lovelace: bigint; night: bigint }>();
  const add = (addr: string, amt: { unit: string; quantity: string }[], sign: bigint) => {
    const cur = net.get(addr) ?? { lovelace: BigInt(0), night: BigInt(0) };
    for (const a of amt) {
      if (a.unit === "lovelace") cur.lovelace += sign * BigInt(a.quantity);
      if (a.unit === NIGHT_UNIT) cur.night += sign * BigInt(a.quantity);
    }
    net.set(addr, cur);
  };
  for (const i of tx.inputs) add(i.address, i.amount, BigInt(-1));
  for (const o of tx.outputs) add(o.address, o.amount, BigInt(1));
  console.log(`
## TEST-ONE verification (on-chain, ${txHash.slice(0, 12)}…)`);
  for (const [addr, v] of net) {
    const who = addr === claimer ? "claiming wallet" : addr === payer ? "paymaster" : "script/other";
    console.log(`  ${who.padEnd(15)} ${short(addr)} ADA ${adaSigned(v.lovelace)} · NIGHT ${v.night >= BigInt(0) ? "+" : ""}${nightN(v.night)}`);
  }
  const c = net.get(claimer); const p = net.get(payer);
  console.log(`  NIGHT landed in claiming wallet: ${c && c.night > BigInt(0) ? "YES" : "NO"} · paymaster paid ADA: ${p && p.lovelace < BigInt(0) ? "YES" : p ? "net positive (refund > fee)" : "NOT an input"}`);
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
      const thawList: WalletRow["thaws"] = [];
      const thaws = await fetchWalletThaws(wallet, (v, thaw: MidnightThaw) => {
        thawList.push({
          address: v.address, kind: v.kind, chain: v.chain, amount: (thaw.amount ?? 0) / 1e6,
          status: thaw.status ?? "unknown", date: thaw.thawing_period_start ?? null, txId: thaw.transaction_id ?? null,
        });
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
        thaws: thawList,
        variantAddresses: addressVariants(wallet).map((v) => v.address),
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
  console.log(`seed | acct/idx | address          | ADA        | NIGHT held      | claimable now   | next thaw`);
  for (const r of rows) {
    console.log(
      `${String(r.seedNo).padEnd(4)} | ${`${r.accountIndex}/${r.index}`.padEnd(8)} | ${short(r.baseAddress).padEnd(16)} | ${adaN(r.lovelace).padStart(10)} | ` +
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

  // 2. Claims
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const records: ClaimRecord[] = [];
  const topups: TopupRecord[] = [];
  const swaps: Record<string, unknown>[] = [];
  const minRaw = BigInt(Math.round(minClaimNight * 1_000_000));

  type Job = { row: WalletRow; target: WalletRow["targets"][number] };
  const allJobs: Job[] = rows.flatMap((row) => row.targets.map((target) => ({ row, target })));
  const eligible = allJobs.filter((j) => BigInt(j.target.redeemable) > minRaw);
  for (const j of allJobs.filter((x) => BigInt(x.target.redeemable) <= minRaw)) {
    records.push(baseRecord(j, paymaster, "skipped-below-min", runStamp));
  }

  let jobs = eligible;
  let pm = paymaster;
  if (testOne) {
    const pick = [...eligible].sort((a, b) => (BigInt(a.target.redeemable) < BigInt(b.target.redeemable) ? -1 : 1))[0];
    if (!pick) {
      console.log(`\n--test-one: no tranche above ${minClaimNight} NIGHT is claimable, nothing to test.`);
      return problems > 0 ? 1 : 0;
    }
    const otherSeed = ranked.find((a) => a.seedNo !== pick.row.seedNo && a.lovelace >= BigInt(10_000_000));
    if (!otherSeed) {
      console.log(`\n--test-one: no address on the other seed has ≥10 ADA to act as paymaster.`);
      return 1;
    }
    jobs = [pick];
    pm = otherSeed;
    console.log(`\n## TEST-ONE plan: claim seed ${pick.row.seedNo} acct ${pick.row.accountIndex} ${short(pick.target.address)} ${nightN(pick.target.redeemable)} NIGHT, paid by seed ${pm.seedNo} acct ${pm.accountIndex} ${short(pm.address)} (${adaN(pm.lovelace)} ADA)`);
  }

  const { signingKeyHex: pmKey } = await deriveSigningKey(pm.mnemonic, pm.accountIndex, pm.index, pm.chain, pm.kind);
  let pmTop3 = pm.top3Lovelace;
  const latestForTopup = await bf("/blocks/latest", blockfrostKey) as { slot: number };
  const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
  const pmHex = Buffer.from(lib.Address.from_bech32(pm.address).to_bytes()).toString("hex");

  /** Keep the paymaster above the thaw endpoint's floor plus the worst claim seen so far. */
  async function ensureFunding(): Promise<boolean> {
    const required = MIN_FUNDING_LOVELACE + WORST_CLAIM_OUTFLOW;
    if (pmTop3 >= required) return true;
    const amount = required - pmTop3 + BigInt(2_000_000);
    const donor = ranked.find((a) => a.address !== pm.address && a.seedNo > 0 && a.lovelace >= amount + BigInt(2_500_000));
    const rec: TopupRecord = {
      from: donor ? `seed ${donor.seedNo} acct ${donor.accountIndex} ${short(donor.address)}` : "none",
      to: `seed ${pm.seedNo} acct ${pm.accountIndex} ${short(pm.address)}`,
      ada: Number(amount) / 1e6, status: "failed", timestamp: new Date().toISOString(),
    };
    topups.push(rec);
    if (!donor) { rec.error = "no own address can cover the top-up"; console.log(`  top-up needed (${ada(amount)}) but no donor has enough ADA`); return false; }
    try {
      const { signingKeyHex, baseAddressHex } = await deriveSigningKey(donor.mnemonic, donor.accountIndex, donor.index, donor.chain, donor.kind);
      const donorUtxos = live ? await utxosOf(donor.address) : donor.utxos;
      const txHex = await buildAdaTx({
        utxos: donorUtxos, senderAddrHex: baseAddressHex, recipientAddrHex: pmHex,
        sendAll: false, amountLovelace: amount, signingKeyHex, currentSlot: latestForTopup.slot,
      });
      rec.feeAda = Number(await txFeeLovelace(txHex)) / 1e6;
      if (!live) {
        rec.status = "dry-run";
        console.log(`  TOP-UP (dry-run) ${ada(amount)} ${rec.from} → paymaster · fee ${rec.feeAda} ADA · not submitted`);
        pmTop3 += amount; donor.lovelace -= amount;
        return true;
      }
      const res = await fetch(`${BF}/tx/submit`, {
        method: "POST", headers: { project_id: blockfrostKey, "Content-Type": "application/cbor" },
        body: Buffer.from(txHex, "hex"), signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Submit failed: ${text.slice(0, 300)}`);
      rec.txHash = text.replace(/"/g, "");
      rec.status = (await waitForConfirmation(rec.txHash)) ? "confirmed" : "unconfirmed";
      console.log(`  TOP-UP ${ada(amount)} ${rec.from} → paymaster · ${rec.status} · https://cardanoscan.io/transaction/${rec.txHash}`);
      donor.lovelace -= amount;
      await refreshPaymaster();
      return rec.status === "confirmed";
    } catch (err) {
      rec.error = scrub(err);
      console.log(`  top-up failed: ${rec.error}`);
      return false;
    }
  }

  async function refreshPaymaster() {
    try {
      const utxos = await utxosOf(pm.address);
      pmTop3 = top3(utxos);
      console.log(`    paymaster now ${adaN(sum(utxos.map(lovelaceOf)))} ADA (${adaN(pmTop3)} in 3 largest UTxOs)`);
    } catch (err) {
      console.log(`    paymaster balance check failed: ${scrub(err)}`);
    }
  }

  async function doClaim(job: Job, attempt: number): Promise<ClaimRecord> {
    const rec = baseRecord(job, pm, "failed", runStamp);
    rec.attempt = attempt;
    const label = `seed ${rec.seed} acct ${String(rec.account).padStart(2)} ${rec.kind}/${rec.chain} ${rec.shortAddress} ${rec.night.toFixed(6)} NIGHT`;
    if (!(await ensureFunding())) {
      rec.error = "paymaster below the funding floor and no top-up possible";
      console.log(`${label}: ${rec.error}`);
      return rec;
    }
    try {
      const result = await runClaim(
        {
          mnemonic: job.row.mnemonic,
          fromAccountIndex: job.row.accountIndex,
          fromAddressIndex: job.row.index,
          fromChain: job.target.chain,
          fromAddressKind: job.target.kind,
          blockfrostApiKey: blockfrostKey,
          paymaster: { address: pm.address, signingKeyHex: pmKey },
        },
        { submit: live }
      );
      rec.timestamp = new Date().toISOString();
      if (result.kind === "built") {
        rec.status = "dry-run";
        rec.feeAda = Number(result.feeLovelace) / 1e6;
        rec.paymasterNetAda = -Number(result.sponsorOutflowLovelace) / 1e6;
        const outflow = BigInt(result.sponsorOutflowLovelace);
        if (outflow > BigInt(0)) pmTop3 -= outflow;
        console.log(`${label}: fee ${ada(result.feeLovelace)} · paymaster net ${adaSigned(-outflow)} · NOT submitted`);
      } else if (result.kind === "submitted") {
        rec.txHash = result.txHash;
        rec.cardanoscan = result.explorerUrl;
        rec.feeAda = Number(result.feeLovelace) / 1e6;
        rec.night = result.redeemedAmount / 1e6;
        console.log(`${label}: SUBMITTED · fee ${ada(result.feeLovelace)} · ${result.explorerUrl}`);
        const ok = await waitForConfirmation(result.txHash);
        rec.status = ok ? "confirmed" : "unconfirmed";
        console.log(ok ? `    confirmed` : `    not confirmed after 5 min, continuing (will show up on the next scan)`);
        await refreshPaymaster();
      } else if (result.kind === "no_redeemable") {
        rec.status = "no-redeemable";
        rec.error = result.nextThawAt ? `next thaw ${result.nextThawAt}` : "no redeemable thaw at build time";
        console.log(`${label}: ${rec.error}`);
      } else {
        rec.error = scrub("error" in result ? `${result.kind}: ${result.error}` : result.kind);
        console.log(`${label}: ${rec.error}`);
      }
    } catch (err) {
      rec.error = scrub(err);
      console.log(`${label}: error: ${rec.error}`);
    }
    return rec;
  }

  // Swap fallback: only when the paymaster can't cover the pending claims and top-ups can't either.
  if (!testOne && jobs.length) {
    const pending = BigInt(jobs.length) * WORST_CLAIM_OUTFLOW;
    const capacity = sum(ranked.filter((a) => a.address !== pm.address && a.lovelace > BigInt(5_000_000)).map((a) => a.lovelace - BigInt(2_500_000)));
    const seller = [...addrs].sort((a, b) => (a.night > b.night ? -1 : 1))[0];
    const venue = await deepestNightAdaProtocol();
    const probe = await quoteSwap(BigInt(100_000_000), 1, venue.protocol);
    const rules = { ...DEFAULT_SWAP_RULES, capNightRaw: BigInt(Math.round(swapCapNight * 1e6)) };
    const plan = planSwap({
      paymasterTop3: pmTop3, pendingClaimCost: pending, topupCapacity: capacity,
      sellerNightRaw: seller?.night ?? BigInt(0),
      lovelacePerNightRaw: probe ? Number(probe.adaOut) / Number(probe.nightIn) : 0, rules,
    });
    console.log(`\n## Swap check · venue ${venue.protocol}${venue.reserveUsd ? ` ($${Math.round(venue.reserveUsd).toLocaleString()} NIGHT/ADA liquidity)` : ""} · pending claims need ≈${ada(pending + MIN_FUNDING_LOVELACE)}, paymaster has ${ada(pmTop3)}, top-up capacity ${ada(capacity)} → ${plan.trigger ? "SWAP TRIGGERED" : `no swap (${plan.reason})`}`);
    if (plan.trigger && seller) {
      const rec: Record<string, unknown> = { seller: `seed ${seller.seedNo} acct ${seller.accountIndex} ${short(seller.address)}`, venue: venue.protocol, nightIn: Number(plan.nightIn) / 1e6, status: "failed", timestamp: new Date().toISOString() };
      swaps.push(rec);
      try {
        const q = await quoteSwap(plan.nightIn, rules.maxSlippagePct, venue.protocol);
        const bad = q ? validateQuote(q, rules) : "no quote";
        if (bad || !q) throw new Error(`quote rejected: ${bad}`);
        rec.adaOut = Number(q.adaOut) / 1e6; rec.minAdaOut = Number(q.minAdaOut) / 1e6; rec.priceImpactPct = q.priceImpactPct; rec.route = q.route;
        const unsigned = await buildSwapTx(seller.address, q);
        rec.networkFeeAda = Number(await txFeeOf(unsigned)) / 1e6;
        console.log(`  swap ${nightN(plan.nightIn)} NIGHT from ${rec.seller} → ≈${adaN(q.adaOut)} ADA (min ${adaN(q.minAdaOut)}), impact ${q.priceImpactPct.toFixed(2)}%, DEX fee ${adaN(q.dexFee)}, network fee ${rec.networkFeeAda} ADA`);
        if (!live || !allowSwap) {
          rec.status = live ? "blocked (no --allow-swap)" : "dry-run";
          console.log(`  ${live ? "NOT submitted: --allow-swap not set" : "dry-run: built, not submitted"}`);
        } else {
          if (validateQuote(q, rules)) throw new Error("quote went stale before submit");
          const { signingKeyHex } = await deriveSigningKey(seller.mnemonic, seller.accountIndex, seller.index, seller.chain, seller.kind);
          const txId = await submitSwap(unsigned, await witnessSetFor(unsigned, signingKeyHex));
          rec.txHash = txId;
          rec.status = (await waitForConfirmation(txId)) ? "order confirmed" : "order unconfirmed";
          console.log(`  SWAP order ${rec.status} · https://cardanoscan.io/transaction/${txId}`);
          await sleep(60_000); // let the batcher fill the order before re-reading balances
          seller.utxos = await utxosOf(seller.address);
          seller.lovelace = sum(seller.utxos.map(lovelaceOf));
          if (seller.address === pm.address) await refreshPaymaster();
        }
      } catch (err) {
        rec.error = scrub(err);
        console.log(`  swap aborted: ${rec.error}`);
      }
    }
  }

  console.log(`\n## 2. Claims (${live ? "SUBMITTING" : "built in memory, not submitted"}) · min claim > ${minClaimNight} NIGHT · paymaster seed ${pm.seedNo} acct ${pm.accountIndex} ${short(pm.address)}`);
  const done: ClaimRecord[] = [];
  for (const job of jobs) done.push(await doClaim(job, 1));
  const failed = done.filter((r) => r.status === "failed");
  if (failed.length && !testOne) {
    console.log(`\nRetrying ${failed.length} failed claim(s) once…`);
    await sleep(20_000);
    if (live) await refreshPaymaster();
    for (const rec of failed) {
      const job = jobs.find((j) => j.target.address === rec.address)!;
      const retry = await doClaim(job, 2);
      done[done.indexOf(rec)] = retry;
    }
  }
  records.push(...done);
  for (const r of done) if (r.status === "failed" || r.status === "unconfirmed") problems++;

  const skipped = records.filter((r) => r.status === "skipped-below-min");
  const claimedOrBuilt = done.filter((r) => ["dry-run", "confirmed", "unconfirmed"].includes(r.status));
  const fees = claimedOrBuilt.reduce((a, r) => a + (r.feeAda ?? 0), 0);
  console.log(`\nClaims: ${claimedOrBuilt.length} ${live ? "submitted" : "built"} · ${claimedOrBuilt.reduce((a, r) => a + r.night, 0).toFixed(6)} NIGHT · fees ${fees.toFixed(6)} ADA · ${done.filter((r) => r.status === "failed").length} failed`);
  console.log(`Skipped (≤ ${minClaimNight} NIGHT): ${skipped.length} tranche(s), ${skipped.reduce((a, r) => a + r.night, 0).toFixed(6)} NIGHT: ${skipped.map((r) => `seed ${r.seed} acct ${r.account} ${r.night.toFixed(3)}`).join(", ") || "none"}`);
  console.log(`Top-ups: ${topups.length ? topups.map((t) => `${t.ada} ADA ${t.from} (${t.status})`).join(", ") : "none needed"}`);

  if (testOne && live) {
    const rec = done[0];
    if (rec?.txHash && rec.status === "confirmed") await verifyTx(rec.txHash, rec.address, pm.address);
  }

  // Records (no secrets: addresses, amounts, hashes only)
  mkdirSync(OUT_DIR, { recursive: true });
  const base = `${OUT_DIR}/claims-${live ? "live" : "dryrun"}${testOne ? "-test-one" : ""}-${runStamp}`;
  writeFileSync(`${base}.json`, JSON.stringify({ live, testOne, minClaimNight, paymaster: { seed: pm.seedNo, account: pm.accountIndex, address: pm.address }, claims: records, topups, swaps }, null, 2));
  const cols = ["seed", "account", "index", "kind", "chain", "shortAddress", "address", "night", "status", "txHash", "cardanoscan", "feeAda", "paymasterNetAda", "timestamp", "attempt", "error"] as const;
  writeFileSync(`${base}.csv`, [cols.join(","), ...records.map((r) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))].join("\n") + "\n");
  writeFileSync(`${OUT_DIR}/snapshot-${runStamp}.json`, JSON.stringify(rows.map((r) => ({
    seed: r.seedNo, account: r.accountIndex, index: r.index, address: r.baseAddress,
    ada: Number(r.lovelace) / 1e6, nightHeld: Number(r.night) / 1e6, claimable: Number(r.claimable) / 1e6,
    nextThawAt: r.nextThawAt, variantAddresses: r.variantAddresses, thaws: r.thaws,
  })), null, 2));
  console.log(`Records: ${base}.json / .csv · snapshot ${OUT_DIR}/snapshot-${runStamp}.json`);

  const shortfall = pmTop3 < MIN_FUNDING_LOVELACE ? MIN_FUNDING_LOVELACE - pmTop3 : BigInt(0);
  if (testOne) return problems > 0 ? 1 : 0;

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

  console.log(`\nSummary: ${rows.length} wallet(s) · claimable ${nightN(totalClaimable)} NIGHT · ${claimedOrBuilt.length} claim(s) ${live ? "submitted" : "built, 0 submitted (dry-run)"} · ${skipped.length} skipped below min · ${problems} problem(s)`);

  if (weekly) {
    try {
      const cfgPath = `${OUT_DIR}/config.json`;
      const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
      const result = await buildTracker({ outDir: OUT_DIR, blockfrostKey, minClaimNight, lastRun: new Date().toISOString() });
      cfg.lastRun = new Date().toISOString();
      cfg.lastRunMode = live ? "live" : "dry-run";
      cfg.latestXlsx = result.xlsxPath;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log(`\n## Tracker`);
      for (const [k, v] of Object.entries(result.summary)) if (!k.startsWith("Note")) console.log(`${k}: ${v}`);
      console.log(`Workbook: ${result.xlsxPath}${cfg.sheetFileId ? ` · Sheet to refresh: ${cfg.sheetFileId}` : " · no sheetFileId in config.json yet"}`);
    } catch (err) {
      problems++;
      console.log(`Tracker build failed: ${scrub(err)}`);
    }
  }
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
