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

Options: `--accounts N` (default 5, env `CLAIM_ACCOUNTS`), `--addresses N` (indexes per account,
default 1, env `CLAIM_ADDRESSES_PER_ACCOUNT`), `--paymaster SEED:ACCOUNT` (default: the address with
the most ADA).

`--live` submits the claims, one at a time, waiting for each confirmation. Top-ups and swaps are only
quoted, never submitted, in any mode. Exit code 0 means it finished cleanly (also when nothing was
claimable), 1 means something failed, 2 means bad usage.

`npm test` runs an offline test that proves a dry-run never reaches `/tx/submit`.
