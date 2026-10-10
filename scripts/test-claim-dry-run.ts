/**
 * Offline test: runClaim with submit:false must never call /tx/submit, and submit:true must.
 * fetch is mocked, the mnemonic is generated in memory for this run only, nothing touches the chain.
 */
import assert from "node:assert/strict";
import { generateMnemonic } from "bip39";
import { deriveWallets } from "../src/lib/cardano";
import { runClaim } from "../src/lib/claim";

async function fakeClaimTxHex(payTo: string): Promise<string> {
  const lib = await import("@emurgo/cardano-serialization-lib-nodejs");
  const inputs = lib.TransactionInputs.new();
  inputs.add(lib.TransactionInput.new(lib.TransactionHash.from_hex("11".repeat(32)), 0));
  const outputs = lib.TransactionOutputs.new();
  outputs.add(lib.TransactionOutput.new(lib.Address.from_bech32(payTo), lib.Value.new(lib.BigNum.from_str("8000000"))));
  const body = lib.TransactionBody.new_tx_body(inputs, outputs, lib.BigNum.from_str("190000"));
  return Buffer.from(lib.Transaction.new(body, lib.TransactionWitnessSet.new(), undefined).to_bytes()).toString("hex");
}

async function main() {
  const mnemonic = generateMnemonic(256); // throwaway, in memory only
  const [target, payer] = [...(await deriveWallets(mnemonic, 1, 0)), ...(await deriveWallets(mnemonic, 1, 1))];
  const txHex = await fakeClaimTxHex(payer.baseAddress);
  const calls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/tx/submit")) return new Response('"' + "ab".repeat(32) + '"', { status: 200 });
    if (url.includes("/utxos")) return json([{ tx_hash: "11".repeat(32), tx_index: 0, amount: [{ unit: "lovelace", quantity: "10000000" }] }]);
    if (url.includes("/transactions/build")) return json({ redeemed_amount: 5_000_000, require_thawing_extra_signature: true, transaction: txHex, transaction_id: "x" });
    if (url.endsWith("/blocks/latest")) return json({ slot: 999_999_999 });
    return json({}, 404);
  }) as typeof fetch;

  const params = {
    mnemonic, fromAccountIndex: 0, blockfrostApiKey: "test-key",
    paymaster: { address: payer.baseAddress, signingKeyHex: "00".repeat(64) },
  };

  const dry = await runClaim(params, { submit: false });
  assert.equal(dry.kind, "built");
  assert.ok(!calls.some((c) => c.includes("/tx/submit")), "dry-run must not submit");
  assert.equal(dry.kind === "built" && dry.feeLovelace, "190000");
  assert.equal(dry.kind === "built" && dry.sponsorOutflowLovelace, "2000000"); // 10 ADA in, 8 ADA back
  assert.ok(calls.some((c) => c.includes(`/thaws/${target.baseAddress}/transactions/build`)));
  assert.ok(calls.some((c) => c.includes(`/addresses/${payer.baseAddress}/utxos`)), "paymaster from params funds the claim");
  console.log("ok - submit:false builds and never calls /tx/submit");

  calls.length = 0;
  const wet = await runClaim(params, { submit: true });
  assert.equal(wet.kind, "submitted");
  assert.equal(calls.filter((c) => c.endsWith("/tx/submit")).length, 1);
  console.log("ok - submit:true calls /tx/submit exactly once");
}

main().catch((err) => {
  console.error("FAIL", err instanceof Error ? err.message : err);
  process.exit(1);
});
