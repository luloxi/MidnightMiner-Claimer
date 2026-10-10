/**
 * Builds the NIGHT Claims Tracker workbook (Wallets / Thaws / Claims log / Summary) from the latest
 * wallet snapshot. It re-reads every address's thaw schedule and UTxOs, and looks up each claim tx
 * on Blockfrost for its date and fee. Needs only BLOCKFROST_API_KEY (no seeds). Writes
 * <outDir>/latest-tracker.xlsx plus one CSV per tab under <outDir>/latest/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { BlockfrostUtxo, NIGHT_NAME, NIGHT_POLICY } from "../src/lib/cardano";
import { fetchSchedule } from "../src/lib/thaws";

const NIGHT_UNIT = `${NIGHT_POLICY}${NIGHT_NAME}`;
const BF = "https://cardano-mainnet.blockfrost.io/api/v0";
const TZ = "America/Argentina/Buenos_Aires";
const LATE_AFTER_DAYS = 7;
export const FINAL_DEADLINE = "2027-03-04";

interface SnapshotWallet {
  seed: number; account: number; index: number; address: string; variantAddresses?: string[];
}

interface TxInfo { time: number; feeLovelace: string }

const localDate = (unixSec: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unixSec * 1000));
const short = (a: string) => (a.length > 20 ? `${a.slice(0, 9)}…${a.slice(-6)}` : a);

async function bfGet<T>(path: string, key: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BF}${path}`, { headers: { project_id: key }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (res.ok) return res.json() as Promise<T>;
    if (res.status !== 429 || attempt >= 4) throw new Error(`Blockfrost ${res.status}`);
    await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
  }
}

function latestSnapshot(outDir: string): { file: string; wallets: SnapshotWallet[] } {
  const files = readdirSync(outDir).filter((f) => /^snapshot-.*\.json$/.test(f)).sort();
  if (!files.length) throw new Error(`no snapshot-*.json in ${outDir}; run the claimer first`);
  const file = files[files.length - 1];
  return { file, wallets: JSON.parse(readFileSync(`${outDir}/${file}`, "utf8")) };
}

export interface TrackerResult {
  xlsxPath: string;
  summary: Record<string, string | number>;
}

export async function buildTracker(opts: {
  outDir: string;
  blockfrostKey: string;
  minClaimNight: number;
  lastRun?: string;
  extraXlsxPath?: string;
}): Promise<TrackerResult> {
  const { outDir, blockfrostKey, minClaimNight } = opts;
  const { wallets } = latestSnapshot(outDir);
  const cachePath = `${outDir}/tx-cache.json`;
  const txCache: Record<string, TxInfo> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const today = localDate(Date.now() / 1000);

  // Fee records from live runs (fallback when Blockfrost misses a tx)
  const liveFees = new Map<string, number>();
  for (const f of readdirSync(outDir).filter((x) => /^claims-live-.*\.json$/.test(x))) {
    const j = JSON.parse(readFileSync(`${outDir}/${f}`, "utf8")) as { claims: { txHash?: string; feeAda?: number }[] };
    for (const c of j.claims) if (c.txHash && c.feeAda) liveFees.set(c.txHash, c.feeAda);
  }

  type ThawRow = {
    seed: number; account: number; shortAddress: string; address: string; tranche: number;
    thawDate: string; night: number; status: string; claimedDate: string; txHash: string; feeAda: number | null;
  };
  type WalletOut = {
    seed: number; account: number; shortAddress: string; address: string; ada: number; nightHeld: number;
    claimable: number; claimed: number; skipped: number; remaining: number; nightLeft: number; nextThaw: string; status: string;
  };
  const thawRows: ThawRow[] = [];
  const walletRows: WalletOut[] = [];

  for (const w of wallets) {
    const addresses = w.variantAddresses?.length ? w.variantAddresses : [w.address];
    let lovelace = 0, night = 0, claimable = 0, claimed = 0, skipped = 0, remaining = 0, nightLeft = 0;
    let nextThaw = "";
    let hasBelowMin = false, hasAvailable = false, hasUpcoming = false;
    const myThaws: ThawRow[] = [];

    for (const address of addresses) {
      const utxos = await bfGet<BlockfrostUtxo[]>(`/addresses/${address}/utxos?count=100`, blockfrostKey) ?? [];
      for (const u of utxos) {
        lovelace += Number(u.amount.find((a) => a.unit === "lovelace")?.quantity ?? 0);
        night += Number(u.amount.find((a) => a.unit === NIGHT_UNIT)?.quantity ?? 0);
      }
      const sched = await fetchSchedule(address);
      if (sched.state !== "ok") continue;
      const sorted = [...sched.thaws].sort((a, b) => String(a.thawing_period_start).localeCompare(String(b.thawing_period_start)));
      sorted.forEach((t, i) => {
        const amount = (t.amount ?? 0) / 1e6;
        const thawDate = (t.thawing_period_start ?? "").slice(0, 10);
        const row: ThawRow = {
          seed: w.seed, account: w.account, shortAddress: short(address), address, tranche: i + 1,
          thawDate, night: amount, status: "", claimedDate: "", txHash: t.transaction_id ?? "", feeAda: null,
        };
        switch (t.status) {
          case "confirmed": claimed++; row.status = "Claimed"; break;
          case "skipped": skipped++; row.status = "Missed (rolled into next)"; break;
          case "redeemable":
            remaining++; nightLeft += amount; claimable += amount;
            if (amount > minClaimNight) { row.status = "Claim available"; hasAvailable = true; }
            else { row.status = "Skipped below min (rolls over)"; hasBelowMin = true; skipped++; }
            break;
          case "upcoming":
            remaining++; nightLeft += amount; hasUpcoming = true; row.status = "Upcoming";
            if (!nextThaw || thawDate < nextThaw) nextThaw = thawDate;
            break;
          case "failed": row.status = "Failed (retry)"; remaining++; nightLeft += amount; break;
          default: row.status = t.status ?? "unknown";
        }
        myThaws.push(row);
      });
    }

    for (const row of myThaws) {
      if (!row.txHash) continue;
      let info = txCache[row.txHash];
      if (!info) {
        const tx = await bfGet<{ block_time: number; fees: string }>(`/txs/${row.txHash}`, blockfrostKey);
        if (tx) { info = { time: tx.block_time, feeLovelace: tx.fees }; txCache[row.txHash] = info; }
      }
      if (info) {
        row.claimedDate = localDate(info.time);
        row.feeAda = Number(info.feeLovelace) / 1e6;
        const lateDays = (Date.parse(row.claimedDate) - Date.parse(row.thawDate)) / 86_400_000;
        if (row.status === "Claimed" && lateDays > LATE_AFTER_DAYS) row.status = "Claimed late";
      } else if (liveFees.has(row.txHash)) {
        row.feeAda = liveFees.get(row.txHash)!;
      }
    }

    if (!myThaws.length && lovelace === 0 && night === 0) continue;
    thawRows.push(...myThaws);
    walletRows.push({
      seed: w.seed, account: w.account, shortAddress: short(w.address), address: w.address,
      ada: lovelace / 1e6, nightHeld: night / 1e6, claimable, claimed, skipped, remaining, nightLeft,
      nextThaw,
      status: hasAvailable ? "Claim available" : hasBelowMin ? "Below min (waiting)" : hasUpcoming ? "Waiting" : "Done",
    });
  }
  writeFileSync(cachePath, JSON.stringify(txCache, null, 2));

  // Claims log: one row per on-chain claim tx
  const byTx = new Map<string, ThawRow[]>();
  for (const r of thawRows) if (r.txHash) byTx.set(r.txHash, [...(byTx.get(r.txHash) ?? []), r]);
  const claims = [...byTx.entries()].map(([tx, rs]) => ({
    date: rs[0].claimedDate, seed: rs[0].seed, account: rs[0].account, shortAddress: rs[0].shortAddress,
    night: rs.reduce((a, r) => a + r.night, 0), feeAda: rs[0].feeAda, tx,
  })).sort((a, b) => b.date.localeCompare(a.date) || a.seed - b.seed || a.account - b.account);

  const todayClaims = claims.filter((c) => c.date === today);
  const upcomingDates = [...new Set(thawRows.filter((r) => r.status === "Upcoming").map((r) => r.thawDate))].sort();
  const summary: Record<string, string | number> = {
    "Last run": opts.lastRun ?? new Date().toISOString(),
    "NIGHT claimed today": round(todayClaims.reduce((a, c) => a + c.night, 0)),
    "Claims today": todayClaims.length,
    "ADA spent on claim fees today": round(todayClaims.reduce((a, c) => a + (c.feeAda ?? 0), 0)),
    "NIGHT claimed all-time": round(claims.reduce((a, c) => a + c.night, 0)),
    "Claims all-time": claims.length,
    "ADA spent on claim fees all-time": round(claims.reduce((a, c) => a + (c.feeAda ?? 0), 0)),
    "NIGHT left to claim": round(walletRows.reduce((a, w) => a + w.nightLeft, 0)),
    "NIGHT claimable now": round(walletRows.reduce((a, w) => a + w.claimable, 0)),
    "Claims left to do (tranches)": thawRows.filter((r) => ["Upcoming", "Claim available", "Skipped below min (rolls over)", "Failed (retry)"].includes(r.status)).length,
    "Tranches below min waiting": thawRows.filter((r) => r.status.startsWith("Skipped below min")).length,
    "Wallets tracked": walletRows.length,
    "Next thaw dates": upcomingDates.join(", "),
    "Min claim (NIGHT)": minClaimNight,
    "Note: rollover": "A skipped tranche is added to the same address's next tranche (seen in the thaw API: e.g. 93.39 skipped, then 186.77 claimed).",
    "Note: deadline": `Thawing ends 2026-12-04. Claim everything before about ${FINAL_DEADLINE} (end of the 90-day grace period).`,
    "Note: claimed late": `"Claimed late" means claimed more than ${LATE_AFTER_DAYS} days after the thaw date.`,
  };

  // Workbook
  const wb = new ExcelJS.Workbook();
  wb.creator = "MidnightMiner-Claimer";
  const headerStyle = (ws: ExcelJS.Worksheet) => {
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: "FFFFFFFF" } };
    r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    r.alignment = { vertical: "middle" };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  };
  const statusFill: Record<string, string> = {
    "Claim available": "FFFDE68A", "Below min (waiting)": "FFFED7AA", Waiting: "FFDBEAFE", Done: "FFD1FAE5",
    Claimed: "FFD1FAE5", "Claimed late": "FFA7F3D0", "Missed (rolled into next)": "FFFECACA",
    "Skipped below min (rolls over)": "FFFED7AA", Upcoming: "FFDBEAFE", "Failed (retry)": "FFFCA5A5",
  };
  const paint = (cell: ExcelJS.Cell) => {
    const argb = statusFill[String(cell.value)];
    if (argb) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
  };
  const NIGHT_FMT = "#,##0.000000";
  const ADA_FMT = "#,##0.00";

  const ws4 = wb.addWorksheet("Summary");
  const ws1 = wb.addWorksheet("Wallets");
  ws1.columns = [
    { header: "Seed", key: "seed", width: 6 }, { header: "Account", key: "account", width: 9 },
    { header: "Short address", key: "shortAddress", width: 18 }, { header: "Full address", key: "address", width: 30 },
    { header: "ADA", key: "ada", width: 10, style: { numFmt: ADA_FMT } },
    { header: "NIGHT held", key: "nightHeld", width: 14, style: { numFmt: NIGHT_FMT } },
    { header: "Claimable now", key: "claimable", width: 14, style: { numFmt: NIGHT_FMT } },
    { header: "Tranches claimed", key: "claimed", width: 10 }, { header: "Tranches skipped/missed", key: "skipped", width: 12 },
    { header: "Tranches remaining", key: "remaining", width: 11 },
    { header: "NIGHT left to claim", key: "nightLeft", width: 14, style: { numFmt: NIGHT_FMT } },
    { header: "Next thaw", key: "nextThaw", width: 12 }, { header: "Status", key: "status", width: 20 },
  ];
  walletRows.sort((a, b) => a.seed - b.seed || a.account - b.account).forEach((r) => paint(ws1.addRow(r).getCell("status")));
  headerStyle(ws1);

  const ws2 = wb.addWorksheet("Thaws");
  ws2.columns = [
    { header: "Seed", key: "seed", width: 6 }, { header: "Account", key: "account", width: 9 },
    { header: "Short address", key: "shortAddress", width: 18 }, { header: "Tranche #", key: "tranche", width: 9 },
    { header: "Thaw date", key: "thawDate", width: 12 }, { header: "NIGHT amount", key: "night", width: 14, style: { numFmt: NIGHT_FMT } },
    { header: "Status", key: "status", width: 28 }, { header: "Claimed date", key: "claimedDate", width: 13 },
    { header: "Tx link", key: "txLink", width: 20 },
  ];
  thawRows.sort((a, b) => a.seed - b.seed || a.account - b.account || a.thawDate.localeCompare(b.thawDate)).forEach((r) => {
    const row = ws2.addRow({ ...r, txLink: "" });
    if (r.txHash) row.getCell("txLink").value = { text: `${r.txHash.slice(0, 10)}…`, hyperlink: `https://cardanoscan.io/transaction/${r.txHash}` };
    paint(row.getCell("status"));
  });
  headerStyle(ws2);

  const ws3 = wb.addWorksheet("Claims log");
  ws3.columns = [
    { header: "Date", key: "date", width: 12 }, { header: "Seed", key: "seed", width: 6 }, { header: "Account", key: "account", width: 9 },
    { header: "Short address", key: "shortAddress", width: 18 },
    { header: "NIGHT", key: "night", width: 14, style: { numFmt: NIGHT_FMT } },
    { header: "Fee ADA", key: "feeAda", width: 10, style: { numFmt: "0.000000" } }, { header: "Cardanoscan", key: "link", width: 20 },
  ];
  claims.forEach((c) => {
    const row = ws3.addRow({ ...c, link: "" });
    row.getCell("link").value = { text: `${c.tx.slice(0, 10)}…`, hyperlink: `https://cardanoscan.io/transaction/${c.tx}` };
    if (c.date === today) row.getCell("date").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE68A" } };
  });
  headerStyle(ws3);

  ws4.columns = [{ header: "Metric", key: "k", width: 34 }, { header: "Value", key: "v", width: 90 }];
  for (const [k, v] of Object.entries(summary)) {
    const row = ws4.addRow({ k, v });
    row.getCell("k").font = { bold: true };
    row.getCell("v").alignment = { wrapText: true, vertical: "top" };
  }
  headerStyle(ws4);
  ws4.autoFilter = undefined as unknown as ExcelJS.AutoFilter;

  mkdirSync(`${outDir}/latest`, { recursive: true });
  const xlsxPath = `${outDir}/latest-tracker.xlsx`;
  await wb.xlsx.writeFile(xlsxPath);
  if (opts.extraXlsxPath) await wb.xlsx.writeFile(opts.extraXlsxPath);
  const csv = (rows: Record<string, unknown>[]) =>
    rows.length ? [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).map((v) => JSON.stringify(v ?? "")).join(","))].join("\n") + "\n" : "";
  writeFileSync(`${outDir}/latest/wallets.csv`, csv(walletRows));
  writeFileSync(`${outDir}/latest/thaws.csv`, csv(thawRows));
  writeFileSync(`${outDir}/latest/claims.csv`, csv(claims));
  writeFileSync(`${outDir}/latest/summary.csv`, csv(Object.entries(summary).map(([metric, value]) => ({ metric, value }))));
  return { xlsxPath, summary };
}

function round(n: number) { return Math.round(n * 1e6) / 1e6; }

// Standalone: `npm run tracker`
if (process.argv[1]?.endsWith("tracker.ts")) {
  const key = (process.env.BLOCKFROST_API_KEY ?? "").trim();
  delete process.env.BLOCKFROST_API_KEY;
  if (!key) { console.error("BLOCKFROST_API_KEY is not set"); process.exit(1); }
  const outDir = process.env.CLAIM_OUT_DIR ?? "/workspace/midnight";
  const extra = process.argv.includes("--copy") ? process.argv[process.argv.indexOf("--copy") + 1] : undefined;
  buildTracker({ outDir, blockfrostKey: key, minClaimNight: Number(process.env.CLAIM_MIN_NIGHT ?? "5"), extraXlsxPath: extra })
    .then((r) => { console.log(`Tracker written: ${r.xlsxPath}`); for (const [k, v] of Object.entries(r.summary)) if (!k.startsWith("Note")) console.log(`  ${k}: ${v}`); })
    .catch((err) => { console.error(`Tracker failed: ${err instanceof Error ? err.message.slice(0, 300) : "error"}`); process.exit(1); });
}
