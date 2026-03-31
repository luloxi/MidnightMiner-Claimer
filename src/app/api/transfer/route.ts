import { NextRequest, NextResponse } from "next/server";
import { validateMnemonic } from "bip39";
import {
  deriveSigningKey,
  buildAdaTx,
  buildNightTx,
  BlockfrostUtxo,
  NIGHT_POLICY,
  NIGHT_NAME,
} from "@/lib/cardano";

const BF = "https://cardano-mainnet.blockfrost.io/api/v0";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSubmitError(errorText: string) {
  const normalized = errorText.toLowerCase();
  return (
    normalized.includes("all inputs are spent") ||
    normalized.includes("already been included") ||
    normalized.includes("badinputsutxo")
  );
}

async function bf(path: string, apiKey: string) {
  const res = await fetch(`${BF}${path}`, {
    headers: { project_id: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blockfrost ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function bfMaybe(path: string, apiKey: string) {
  const res = await fetch(`${BF}${path}`, {
    headers: { project_id: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blockfrost ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function normalizeAddressHex(input: string): Promise<string> {
  const value = input.trim();
  if (!value) throw new Error("Dirección destino vacía");

  const lib = await import("@emurgo/cardano-serialization-lib-nodejs");

  if (/^[0-9a-fA-F]+$/.test(value)) {
    const normalized = value.toLowerCase();
    try {
      lib.Address.from_bytes(Buffer.from(normalized, "hex"));
      return normalized;
    } catch {
      throw new Error("Dirección hex inválida");
    }
  }

  try {
    return Buffer.from(lib.Address.from_bech32(value).to_bytes()).toString("hex");
  } catch {
    throw new Error("Dirección bech32 inválida");
  }
}

/**
 * POST /api/transfer
 * Body: {
 *   mnemonic: string;
 *   fromAccountIndex: number;
 *   fromAddressIndex?: number;     // default 0
 *   toAddressHex: string;          // hex of recipient address bytes
 *   currency: "ADA" | "NIGHT";
 *   amount: string | "all";        // lovelace for ADA, raw units for NIGHT
 *   blockfrostApiKey?: string;
 *   reserveLovelace?: string;      // only used with ADA + amount="all"
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      mnemonic,
      fromAccountIndex,
      fromAddressIndex = 0,
      toAddressHex,
      currency,
      amount,
      blockfrostApiKey,
      reserveLovelace,
    } = body as {
      mnemonic: string;
      fromAccountIndex: number;
      fromAddressIndex?: number;
      toAddressHex: string;
      currency: "ADA" | "NIGHT";
      amount: string | "all";
      blockfrostApiKey?: string;
      reserveLovelace?: string;
    };
    const effectiveBlockfrostKey =
      blockfrostApiKey?.trim() || process.env.BLOCKFROST_API_KEY?.trim() || "";

    if (!mnemonic || !validateMnemonic(mnemonic.trim()))
      return NextResponse.json({ error: "Mnemonic inválido" }, { status: 400 });
    if (!toAddressHex || !effectiveBlockfrostKey)
      return NextResponse.json({ error: "Faltan parámetros" }, { status: 400 });

    const recipientAddressHex = await normalizeAddressHex(toAddressHex);

    // Derive signing key and sender address
    const { signingKeyHex, baseAddressHex } = await deriveSigningKey(
      mnemonic.trim(), fromAccountIndex, fromAddressIndex
    );
    const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
    const senderBech32 = lib.Address.from_bytes(
      Buffer.from(baseAddressHex, "hex")
    ).to_bech32();

    // Current slot for TTL
    const block = await bf("/blocks/latest", effectiveBlockfrostKey);
    const currentSlot: number = block.slot;

    for (let attempt = 0; attempt < 3; attempt++) {
      const utxos = await bfMaybe(
        `/addresses/${senderBech32}/utxos`,
        effectiveBlockfrostKey
      ) as BlockfrostUtxo[] | null;

      if (!utxos?.length) {
        return NextResponse.json({ error: "No hay UTXOs en la dirección origen" }, { status: 400 });
      }

      let txHex: string;

      if (currency === "ADA") {
        const sendAll = amount === "all";
        const amountLovelace = sendAll ? BigInt(0) : BigInt(amount);
        txHex = await buildAdaTx({
          utxos, senderAddrHex: baseAddressHex, recipientAddrHex: recipientAddressHex,
          sendAll,
          amountLovelace,
          reserveLovelace: reserveLovelace ? BigInt(reserveLovelace) : BigInt(0),
          signingKeyHex,
          currentSlot,
        });
      } else {
        let nightAmt: bigint;
        if (amount === "all") {
          nightAmt = utxos.reduce((s, u) => {
            const q = u.amount.find(a => a.unit === `${NIGHT_POLICY}${NIGHT_NAME}`)?.quantity ?? "0";
            return s + BigInt(q);
          }, BigInt(0));
        } else {
          nightAmt = BigInt(amount);
        }

        try {
          txHex = await buildNightTx({
            utxos, senderAddrHex: baseAddressHex, recipientAddrHex: recipientAddressHex,
            nightAmount: nightAmt, signingKeyHex, currentSlot,
          });
        } catch (err) {
          throw err;
        }
      }

      const submitRes = await fetch(`${BF}/tx/submit`, {
        method: "POST",
        headers: { project_id: effectiveBlockfrostKey, "Content-Type": "application/cbor" },
        body: Buffer.from(txHex, "hex"),
        signal: AbortSignal.timeout(30_000),
      });
      const submitText = await submitRes.text();
      if (submitRes.ok) {
        const txHash = submitText.replace(/"/g, "");
        return NextResponse.json({
          txHash,
          explorerUrl: `https://cardanoscan.io/transaction/${txHash}`,
        });
      }

      if (!isRetryableSubmitError(submitText) || attempt === 2) {
        return NextResponse.json({ error: `Submit falló: ${submitText}` }, { status: 502 });
      }

      await sleep(4_000);
    }

    return NextResponse.json({ error: "No se pudo enviar la transacción después de reintentar" }, { status: 502 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
