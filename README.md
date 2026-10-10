# MidnightMiner-Claimer

Small local Next.js app to:

- derive Cardano wallets from a seed phrase
- inspect ADA, NIGHT, and claimable NIGHT
- claim NIGHT
- transfer ADA or NIGHT
- consolidate NIGHT to a custom address

## Requirements

- Node.js 20+
- a Blockfrost mainnet API key

## Setup

Create `.env.local`:

```bash
BLOCKFROST_API_KEY=your_blockfrost_key
```

You can also paste the Blockfrost key in the UI instead of using `.env.local`.

## Run

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## How to use

1. Paste your seed phrase.
2. Optionally paste your Blockfrost API key.
3. Choose how many wallets and accounts to scan.
4. Click `Derive and Load Balances`.

Main actions:

- `Claim NIGHT`: claims NIGHT for one wallet
- `Play mode`: runs claims sequentially
- `Transfer`: sends ADA or NIGHT
- `Consolidate NIGHT`: sends all NIGHT from all wallets with NIGHT to one custom address
- `Move ADA`: sends almost all ADA to the next account, keeping a small reserve

## Notes

- This app is meant to run locally.
- Private keys are derived server-side inside the local app.
- Be careful with custom destination addresses. Consolidation can move both NIGHT and the minimum ADA required for token outputs.

## Headless claimer (no Next server)

`scripts/claim-headless.ts` scans both seeds, picks one paymaster wallet that pays the fees of every
claim (it can belong to the other seed), and builds each claim with the same code as `/api/claim`.
NIGHT stays in the wallet that claimed it. There is no consolidation.

Secrets are read only from the environment and are never printed or written anywhere:

```bash
export MIDNIGHT_SEED_1="..."      # 24 words, set in the shell or the process env, never in a file in the repo
export MIDNIGHT_SEED_2="..."      # optional, a missing seed is skipped
export BLOCKFROST_API_KEY="..."   # mainnet key
```

Dry-run report (default, nothing is submitted):

```bash
npm run claim:headless:guarded -- --report   # same as claim:headless, plus a preload that aborts on any submit
```

It prints, per wallet, ADA, NIGHT held, NIGHT claimable now and the next thaw, then the real fee of
each built claim, the paymaster and its budget, a sample ADA top-up fee, NIGHT→ADA swap quotes from
the Minswap aggregator, and the thaw calendar.

Options: `--accounts N` (default 30, env `CLAIM_ACCOUNTS`), `--addresses N` (indexes per account,
default 1, env `CLAIM_ADDRESSES_PER_ACCOUNT`), `--min-claim X` (only tranches above X NIGHT are
claimed, default 5, env `CLAIM_MIN_NIGHT`; smaller ones are reported as skipped and roll into the
next thaw), `--paymaster SEED:ACCOUNT` (default: the address with the most ADA), and `--test-one`
(exactly one claim, the smallest tranche above the minimum, paid by the richest address of the other
seed).

`--live` submits the claims one at a time and waits for each confirmation. A claim that times out is
logged and the run continues; failures are retried once at the end. When the paymaster drops below
the funding floor, an ADA top-up from another own address is built (dry-run) or submitted (`--live`).
Swaps are never built or submitted. Every run writes a per-claim record (JSON and CSV) and a wallet
snapshot under `/workspace/midnight/` (env `CLAIM_OUT_DIR`), with addresses, amounts and hashes only.
Exit code 0 means it finished cleanly (also when nothing was claimable), 1 means something failed,
2 means bad usage.

`npm test` runs an offline test that proves a dry-run never reaches `/tx/submit`.

## Weekly protocol

```bash
npm run weekly        # dry-run under the submit guard: scan, top-up/swap check, claims > 5 NIGHT built, tracker rebuilt
npm run weekly:live   # same, but submits claims and any needed ADA top-ups between own addresses
npm run weekly:live -- --allow-swap   # additionally lets the NIGHT→ADA swap fallback be submitted
```

One run does, in order:

1. Scans 30 accounts per seed (thaw schedules, UTxOs) and picks the paymaster (most ADA).
2. Swap check: only if the paymaster's 3 largest UTxOs are below the pending claim cost + 3 ADA and
   no own address can top it up. It then sells just enough NIGHT for the shortfall + 5 ADA (min 100,
   max `--swap-cap`, default 300 NIGHT) on whichever route leaves the most ADA after fees: the Minswap
   aggregator's best route or the deepest single NIGHT/ADA pool (checked at run time, Minswap V2
   today). Every pool on the route must hold at least 1,000 ADA and the trade must be under 5% of its
   NIGHT, with 1% max slippage, and aborts if price
   impact is over 2% or the quote is older than 60 s. Submitting needs `--live --allow-swap`.
3. Claims every tranche above 5 NIGHT (plus a final sweep of any address with no upcoming thaw
   left, whatever its size; `--min-claim 0` claims everything), one at a time, topping the paymaster up from another own
   address when it would drop below the funding floor. Smaller tranches wait; the thaw API adds a
   skipped tranche to the address's next one. Claim everything before about 2027-03-04.
4. Writes per-claim records and a snapshot to `/workspace/midnight/`, then rebuilds the tracker
   workbook `/workspace/midnight/latest-tracker.xlsx` (tabs Summary, Wallets, Thaws, Claims log) and
   CSVs under `/workspace/midnight/latest/`. `npm run tracker` rebuilds it on its own.

A run with nothing to do spends nothing and exits 0.

### Google Sheet

Node can't reach the Drive connector, so the Drive part is done by the agent running the routine.
The connector can't overwrite a Sheet's content, so every run produces a new dated Sheet and the
previous one is archived, never deleted. `/workspace/midnight/config.json` (no secrets) holds
`sheetFileId`, `archiveFolderId` and, after each run, `pendingUpload`. `npm run tracker:plan`
prints the exact steps for the current state:

1. Upload `/workspace/midnight/YYYY.MM.DD NIGHT Claims Tracker.xlsx` to the personal Drive as a
   Google Sheet named `YYYY.MM.DD NIGHT Claims Tracker`.
2. Move the previous Sheet (`sheetFileId`) into the `NIGHT Claims Archive` folder
   (`archiveFolderId`; create the folder once if it is missing).
3. Save the new Sheet's id and link as `sheetFileId` / `sheetUrl` and clear `pendingUpload`.

Never share the Sheet and never delete old ones.
