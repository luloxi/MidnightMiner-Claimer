import { NextRequest, NextResponse } from "next/server";

const BF = "https://cardano-mainnet.blockfrost.io/api/v0";

async function bf(path: string, apiKey: string) {
  const res = await fetch(`${BF}${path}`, {
    headers: { project_id: apiKey },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blockfrost ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

export async function POST(req: NextRequest) {
  try {
    const { txHash, blockfrostApiKey } = await req.json() as {
      txHash?: string;
      blockfrostApiKey?: string;
    };

    const effectiveBlockfrostKey =
      blockfrostApiKey?.trim() || process.env.BLOCKFROST_API_KEY?.trim() || "";

    if (!txHash?.trim()) {
      return NextResponse.json({ error: "Missing txHash" }, { status: 400 });
    }

    if (!effectiveBlockfrostKey) {
      return NextResponse.json({ error: "Missing BLOCKFROST_API_KEY" }, { status: 400 });
    }

    const tx = await bf(`/txs/${txHash.trim()}`, effectiveBlockfrostKey) as
      | { block?: string | null; confirmations?: number | null }
      | null;

    return NextResponse.json({
      confirmed: Boolean(tx?.block),
      confirmations: Number(tx?.confirmations ?? 0),
      explorerUrl: `https://cardanoscan.io/transaction/${txHash.trim()}`,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
