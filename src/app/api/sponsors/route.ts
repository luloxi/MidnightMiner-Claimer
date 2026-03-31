import { NextRequest, NextResponse } from "next/server";
import { validateMnemonic } from "bip39";
import { deriveWalletsMultiAccount } from "@/lib/cardano";

const BF_API = "https://cardano-mainnet.blockfrost.io/api/v0";
const GLOBAL_SPONSOR_SCAN_ACCOUNTS = 25;

interface BlockfrostUtxo {
  amount: { unit: string; quantity: string }[];
}

async function bf(path: string, apiKey: string) {
  const res = await fetch(`${BF_API}${path}`, {
    headers: { project_id: apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function POST(req: NextRequest) {
  try {
    const { mnemonic, blockfrostApiKey } = await req.json() as {
      mnemonic?: string;
      blockfrostApiKey?: string;
    };

    const cleanMnemonic = mnemonic?.trim() || "";
    if (!cleanMnemonic) {
      return NextResponse.json({ sponsors: [] });
    }

    if (!validateMnemonic(cleanMnemonic)) {
      return NextResponse.json({ error: "Invalid mnemonic" }, { status: 400 });
    }

    const blockfrostKey =
      blockfrostApiKey?.trim() || process.env.BLOCKFROST_API_KEY?.trim() || "";

    const wallets = await deriveWalletsMultiAccount(
      cleanMnemonic,
      1,
      GLOBAL_SPONSOR_SCAN_ACCOUNTS
    );

    const sponsors = await Promise.all(
      wallets.map(async (wallet) => {
        const utxos = blockfrostKey
          ? await bf(`/addresses/${wallet.baseAddress}/utxos`, blockfrostKey) as BlockfrostUtxo[] | null
          : null;

        const lovelace = (utxos ?? []).reduce((sum, utxo) => {
          const quantity = utxo.amount.find((amount) => amount.unit === "lovelace")?.quantity ?? "0";
          return sum + BigInt(quantity);
        }, BigInt(0));

        return {
          accountIndex: wallet.accountIndex,
          index: wallet.index,
          baseAddress: wallet.baseAddress,
          lovelace: lovelace.toString(),
          adaDisplay: `${(Number(lovelace) / 1_000_000).toFixed(2)} ADA`,
        };
      })
    );

    return NextResponse.json({ sponsors });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
