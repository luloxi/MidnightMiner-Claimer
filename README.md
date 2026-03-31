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
