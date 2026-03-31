import { NextRequest, NextResponse } from "next/server";
import { deriveWallets, deriveWalletsMultiAccount } from "@/lib/cardano";
import { validateMnemonic } from "bip39";

export async function POST(req: NextRequest) {
  try {
    const { mnemonic, count = 20, accountIndex = 0, maxAccounts = 1 } = await req.json();

    if (!mnemonic || !validateMnemonic(mnemonic.trim())) {
      return NextResponse.json({ error: "Invalid mnemonic" }, { status: 400 });
    }

    const n   = Math.min(Math.max(Number(count), 1), 50);
    const acc = Math.min(Math.max(Number(accountIndex), 0), 200);
    const ma  = Math.min(Math.max(Number(maxAccounts), 1), 200);

    const wallets = ma > 1
      ? await deriveWalletsMultiAccount(mnemonic.trim(), n, ma)
      : await deriveWallets(mnemonic.trim(), n, acc);

    return NextResponse.json({ wallets });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
