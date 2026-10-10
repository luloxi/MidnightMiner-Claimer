import { NextRequest, NextResponse } from "next/server";
import { validateMnemonic } from "bip39";
import { AddressChain, AddressKind } from "@/lib/cardano";
import { runClaim } from "@/lib/claim";

export async function POST(req: NextRequest) {
  try {
    const {
      mnemonic,
      fromAccountIndex,
      fromAddressIndex = 0,
      fromChain = 0,
      fromAddressKind = "base",
      blockfrostApiKey,
      sponsorAccountIndex,
      sponsorAccountIndexes,
    } = await req.json() as {
      mnemonic: string;
      fromAccountIndex: number;
      fromAddressIndex?: number;
      fromChain?: AddressChain;
      fromAddressKind?: AddressKind;
      blockfrostApiKey?: string;
      sponsorAccountIndex?: number | null;
      sponsorAccountIndexes?: number[];
    };

    const effectiveBlockfrostKey =
      blockfrostApiKey?.trim() || process.env.BLOCKFROST_API_KEY?.trim() || "";

    if (!mnemonic || !validateMnemonic(mnemonic.trim())) {
      return NextResponse.json({ error: "Invalid mnemonic" }, { status: 400 });
    }
    if (!effectiveBlockfrostKey) {
      return NextResponse.json({ error: "Missing BLOCKFROST_API_KEY" }, { status: 400 });
    }

    const result = await runClaim(
      {
        mnemonic,
        fromAccountIndex,
        fromAddressIndex,
        fromChain,
        fromAddressKind,
        blockfrostApiKey: effectiveBlockfrostKey,
        sponsorAccountIndex,
        sponsorAccountIndexes,
      },
      { submit: true }
    );

    switch (result.kind) {
      case "submitted":
        return NextResponse.json({
          txHash: result.txHash,
          redeemedAmount: result.redeemedAmount,
          explorerUrl: result.explorerUrl,
        });
      case "no_redeemable":
        return NextResponse.json({
          code: "NO_REDEEMABLE_THAWS",
          error: result.nextThawAt
            ? `There is no claimable thaw yet. Next thaw: ${result.nextThawAt}`
            : "There is no claimable thaw yet for this wallet.",
          nextThawAt: result.nextThawAt,
          nowAt: result.nowAt,
        }, { status: 409 });
      case "build_failed":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "submit_failed":
        return NextResponse.json({ error: result.error }, { status: 502 });
      case "built":
      case "retries_exhausted":
        return NextResponse.json({
          error: "Could not submit the claim after retrying with fresh UTxOs",
        }, { status: 502 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
