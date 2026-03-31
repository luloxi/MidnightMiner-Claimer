/**
 * Server-side only — Cardano wallet derivation + transaction building.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _csl: any = null;
async function csl() {
  if (!_csl) _csl = await import("@emurgo/cardano-serialization-lib-nodejs");
  return _csl;
}

const harden = (n: number) => 0x80000000 + n;

// ── Token constants ────────────────────────────────────────────────────────
export const NIGHT_POLICY = "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa";
export const NIGHT_NAME   = "4e49474854"; // hex of "NIGHT"

// ── Derivation types ───────────────────────────────────────────────────────

export interface DerivedWallet {
  index: number;
  accountIndex: number;
  baseAddress: string;
  baseAddressHex: string;
  enterpriseAddress: string;
  enterpriseAddressHex: string;
  pubkeyHex: string;
  stakeAddress: string;
}

export async function deriveWalletsMultiAccount(
  mnemonic: string,
  countPerAccount: number,
  maxAccounts: number
): Promise<DerivedWallet[]> {
  const all: DerivedWallet[] = [];
  for (let acc = 0; acc < maxAccounts; acc++) {
    const wallets = await deriveWallets(mnemonic, countPerAccount, acc);
    all.push(...wallets);
  }
  return all;
}

export async function deriveWallets(
  mnemonic: string,
  count: number,
  accountIndex = 0
): Promise<DerivedWallet[]> {
  const { mnemonicToEntropy } = await import("bip39");
  const lib = await csl();

  const entropy = mnemonicToEntropy(mnemonic.trim());
  const rootKey = lib.Bip32PrivateKey.from_bip39_entropy(
    Buffer.from(entropy, "hex"),
    Buffer.from("")
  );

  const accountKey = rootKey
    .derive(harden(1852))
    .derive(harden(1815))
    .derive(harden(accountIndex));

  const stakeKey     = accountKey.derive(2).derive(0).to_public().to_raw_key();
  const stakeKeyHash = stakeKey.hash();
  const CredCls      = lib.Credential ?? lib.StakeCredential;

  const stakeAddr = lib.RewardAddress.new(1, CredCls.from_keyhash(stakeKeyHash))
    .to_address().to_bech32();

  const results: DerivedWallet[] = [];
  for (let i = 0; i < count; i++) {
    const paymentKey     = accountKey.derive(0).derive(i);
    const pubKey         = paymentKey.to_public().to_raw_key();
    const paymentKeyHash = pubKey.hash();
    const paymentCred    = CredCls.from_keyhash(paymentKeyHash);
    const stakeCred      = CredCls.from_keyhash(stakeKeyHash);
    const baseAddr       = lib.BaseAddress.new(1, paymentCred, stakeCred).to_address();
    const entAddr        = lib.EnterpriseAddress.new(1, paymentCred).to_address();

    results.push({
      index: i,
      accountIndex,
      baseAddress:       baseAddr.to_bech32(),
      baseAddressHex:    Buffer.from(baseAddr.to_bytes()).toString("hex"),
      enterpriseAddress: entAddr.to_bech32(),
      enterpriseAddressHex: Buffer.from(entAddr.to_bytes()).toString("hex"),
      pubkeyHex: Buffer.from(pubKey.as_bytes()).toString("hex"),
      stakeAddress: stakeAddr,
    });
  }
  return results;
}

/** Derive the raw signing key (hex) for a specific account/index — used for transactions. */
export async function deriveSigningKey(
  mnemonic: string,
  accountIndex: number,
  addressIndex = 0
): Promise<{ signingKeyHex: string; baseAddressHex: string }> {
  const { mnemonicToEntropy } = await import("bip39");
  const lib = await csl();

  const entropy  = mnemonicToEntropy(mnemonic.trim());
  const rootKey  = lib.Bip32PrivateKey.from_bip39_entropy(
    Buffer.from(entropy, "hex"), Buffer.from("")
  );
  const accountKey = rootKey
    .derive(harden(1852)).derive(harden(1815)).derive(harden(accountIndex));

  const paymentKey     = accountKey.derive(0).derive(addressIndex);
  const stakeKey       = accountKey.derive(2).derive(0);
  const CredCls        = lib.Credential ?? lib.StakeCredential;
  const paymentKeyHash = paymentKey.to_public().to_raw_key().hash();
  const stakeKeyHash   = stakeKey.to_public().to_raw_key().hash();
  const baseAddr       = lib.BaseAddress.new(
    1, CredCls.from_keyhash(paymentKeyHash), CredCls.from_keyhash(stakeKeyHash)
  ).to_address();

  return {
    signingKeyHex:   Buffer.from(paymentKey.to_raw_key().as_bytes()).toString("hex"),
    baseAddressHex:  Buffer.from(baseAddr.to_bytes()).toString("hex"),
  };
}

// ── Transaction types ──────────────────────────────────────────────────────

export interface BlockfrostUtxo {
  tx_hash: string;
  tx_index: number;
  amount: { unit: string; quantity: string }[];
}

// Min ADA for a token-carrying output (~1.5 ADA is safe)
const MIN_TOKEN_LOVELACE = BigInt(1_500_000);
const FEE_ESTIMATE       = BigInt(250_000); // 0.25 ADA

/** Build and sign an ADA-only transfer. Returns signed tx hex. */
export async function buildAdaTx(params: {
  utxos: BlockfrostUtxo[];
  senderAddrHex: string;
  recipientAddrHex: string;
  sendAll: boolean;
  amountLovelace: bigint;
  reserveLovelace?: bigint;
  signingKeyHex: string;
  currentSlot: number;
}): Promise<string> {
  const lib = await csl();
  const {
    utxos,
    senderAddrHex,
    recipientAddrHex,
    sendAll,
    signingKeyHex,
    currentSlot,
    reserveLovelace = BigInt(0),
  } = params;

  // Prefer pure ADA UTXOs, but fall back to token-carrying UTXOs when needed.
  const adaOnly = utxos.filter(u => u.amount.length === 1);
  const tokenUtxos = utxos.filter(u => u.amount.length > 1);
  const chosen = sendAll ? [...utxos] : [...adaOnly];

  let chosenAda = chosen.reduce((sum, utxo) => {
    const quantity = utxo.amount.find((amount) => amount.unit === "lovelace")?.quantity ?? "0";
    return sum + BigInt(quantity);
  }, BigInt(0));

  const minimumNeeded = sendAll
    ? BigInt(0)
    : params.amountLovelace + reserveLovelace + FEE_ESTIMATE;

  if (!sendAll && chosenAda < minimumNeeded) {
    for (const utxo of tokenUtxos) {
      chosen.push(utxo);
      const quantity = utxo.amount.find((amount) => amount.unit === "lovelace")?.quantity ?? "0";
      chosenAda += BigInt(quantity);
      if (chosenAda >= minimumNeeded) break;
    }
  }

  let totalIn = BigInt(0);
  const tokenBalances = new Map<string, bigint>();
  for (const u of chosen) {
    const q = u.amount.find(a => a.unit === "lovelace")?.quantity ?? "0";
    totalIn += BigInt(q);
    for (const amount of u.amount) {
      if (amount.unit === "lovelace") continue;
      tokenBalances.set(
        amount.unit,
        (tokenBalances.get(amount.unit) ?? BigInt(0)) + BigInt(amount.quantity)
      );
    }
  }

  const tokenChangeRequired = tokenBalances.size > 0;
  const reservedForChange = tokenChangeRequired
    ? reserveLovelace > MIN_TOKEN_LOVELACE ? reserveLovelace : MIN_TOKEN_LOVELACE
    : reserveLovelace;

  const sendAmt = sendAll
    ? totalIn - reservedForChange - FEE_ESTIMATE
    : params.amountLovelace;
  const change  = totalIn - sendAmt - FEE_ESTIMATE;
  if (sendAmt <= 0n) throw new Error("Insufficient funds");
  if (!sendAll && tokenChangeRequired && change < MIN_TOKEN_LOVELACE) {
    throw new Error("Not enough ADA to return token change");
  }

  const inputs = lib.TransactionInputs.new();
  for (const u of chosen) {
    inputs.add(lib.TransactionInput.new(
      lib.TransactionHash.from_hex(u.tx_hash), u.tx_index
    ));
  }

  const outputs = lib.TransactionOutputs.new();
  const recipAddr = lib.Address.from_bytes(Buffer.from(recipientAddrHex, "hex"));
  outputs.add(lib.TransactionOutput.new(
    recipAddr, lib.Value.new(lib.BigNum.from_str(sendAmt.toString()))
  ));

  if (change >= BigInt(1_000_000) || tokenChangeRequired) {
    const senderAddr = lib.Address.from_bytes(Buffer.from(senderAddrHex, "hex"));
    const changeValue = lib.Value.new(
      lib.BigNum.from_str(
        (change > 0n ? change : MIN_TOKEN_LOVELACE).toString()
      )
    );

    if (tokenChangeRequired) {
      const multiAsset = lib.MultiAsset.new();
      for (const [unit, quantity] of tokenBalances.entries()) {
        const policy = unit.slice(0, 56);
        const assetHex = unit.slice(56);
        const scriptHash = lib.ScriptHash.from_bytes(Buffer.from(policy, "hex"));
        const currentAssets = multiAsset.get(scriptHash) ?? lib.Assets.new();
        const assetName = lib.AssetName.new(Buffer.from(assetHex, "hex"));
        currentAssets.insert(assetName, lib.BigNum.from_str(quantity.toString()));
        multiAsset.insert(scriptHash, currentAssets);
      }
      changeValue.set_multiasset(multiAsset);
    }

    outputs.add(lib.TransactionOutput.new(
      senderAddr,
      changeValue
    ));
  }

  return signAndSerialize(lib, inputs, outputs, FEE_ESTIMATE, currentSlot, signingKeyHex);
}

/** Build and sign a NIGHT token transfer. Returns signed tx hex. */
export async function buildNightTx(params: {
  utxos: BlockfrostUtxo[];
  senderAddrHex: string;
  recipientAddrHex: string;
  nightAmount: bigint;   // raw units (multiply display by 1_000_000)
  signingKeyHex: string;
  currentSlot: number;
}): Promise<string> {
  const lib = await csl();
  const { utxos, senderAddrHex, recipientAddrHex, nightAmount, signingKeyHex, currentSlot } = params;

  // Find UTXO(s) carrying NIGHT
  const nightUtxos = utxos.filter(u =>
    u.amount.some(a => a.unit === `${NIGHT_POLICY}${NIGHT_NAME}`)
  );
  if (nightUtxos.length === 0) throw new Error("No NIGHT found in the UTxOs");

  // Also grab pure-ADA UTXOs for fee payment
  const adaUtxos = utxos.filter(u => u.amount.length === 1);

  const allChosen = [...nightUtxos, ...adaUtxos.slice(0, 2)]; // max 2 ada utxos

  let totalAda   = BigInt(0);
  let totalNight = BigInt(0);
  for (const u of allChosen) {
    totalAda   += BigInt(u.amount.find(a => a.unit === "lovelace")?.quantity ?? "0");
    totalNight += BigInt(u.amount.find(a => a.unit === `${NIGHT_POLICY}${NIGHT_NAME}`)?.quantity ?? "0");
  }

  if (nightAmount > totalNight) throw new Error("Insufficient NIGHT");

  // Build multiasset value for recipient
  const CredCls    = lib.Credential ?? lib.StakeCredential; void CredCls;
  const policyHash = lib.ScriptHash.from_bytes(Buffer.from(NIGHT_POLICY, "hex"));
  const assetName  = lib.AssetName.new(Buffer.from(NIGHT_NAME, "hex"));

  const recipAssets = lib.Assets.new();
  recipAssets.insert(assetName, lib.BigNum.from_str(nightAmount.toString()));
  const recipMulti = lib.MultiAsset.new();
  recipMulti.insert(policyHash, recipAssets);
  const recipValue = lib.Value.new(lib.BigNum.from_str(MIN_TOKEN_LOVELACE.toString()));
  recipValue.set_multiasset(recipMulti);

  // Change value: remaining ADA + remaining NIGHT
  const remainingNight = totalNight - nightAmount;
  const remainingAda   = totalAda - MIN_TOKEN_LOVELACE - FEE_ESTIMATE;
  if (remainingAda < 0n) throw new Error("Insufficient ADA to cover the minimum UTxO plus fee");

  const inputs = lib.TransactionInputs.new();
  for (const u of allChosen) {
    inputs.add(lib.TransactionInput.new(
      lib.TransactionHash.from_hex(u.tx_hash), u.tx_index
    ));
  }

  const outputs = lib.TransactionOutputs.new();
  const recipAddr  = lib.Address.from_bytes(Buffer.from(recipientAddrHex, "hex"));
  outputs.add(lib.TransactionOutput.new(recipAddr, recipValue));

  // Change output with remaining ADA (+ NIGHT if any left)
  if (remainingAda >= BigInt(1_000_000) || remainingNight > 0n) {
    const changeValue = lib.Value.new(lib.BigNum.from_str(
      (remainingAda > 0n ? remainingAda : BigInt(1_000_000)).toString()
    ));
    if (remainingNight > 0n) {
      const changeAssets = lib.Assets.new();
      changeAssets.insert(assetName, lib.BigNum.from_str(remainingNight.toString()));
      const changeMulti = lib.MultiAsset.new();
      changeMulti.insert(policyHash, changeAssets);
      changeValue.set_multiasset(changeMulti);
    }
    const senderAddr = lib.Address.from_bytes(Buffer.from(senderAddrHex, "hex"));
    outputs.add(lib.TransactionOutput.new(senderAddr, changeValue));
  }

  return signAndSerialize(lib, inputs, outputs, FEE_ESTIMATE, currentSlot, signingKeyHex);
}

export async function buildSponsoredNightTx(params: {
  senderUtxos: BlockfrostUtxo[];
  sponsorUtxos: BlockfrostUtxo[];
  senderAddrHex: string;
  sponsorAddrHex: string;
  recipientAddrHex: string;
  nightAmount: bigint;
  senderSigningKeyHex: string;
  sponsorSigningKeyHex: string;
  currentSlot: number;
}): Promise<string> {
  const lib = await csl();
  const {
    senderUtxos,
    sponsorUtxos,
    senderAddrHex,
    sponsorAddrHex,
    recipientAddrHex,
    nightAmount,
    senderSigningKeyHex,
    sponsorSigningKeyHex,
    currentSlot,
  } = params;

  const senderNightUtxos = senderUtxos.filter((u) =>
    u.amount.some((a) => a.unit === `${NIGHT_POLICY}${NIGHT_NAME}`)
  );
  if (senderNightUtxos.length === 0) throw new Error("No NIGHT found in the UTxOs");

  const sponsorAdaUtxos = sponsorUtxos.filter((u) => u.amount.length === 1).slice(0, 2);
  if (sponsorAdaUtxos.length === 0) throw new Error("No sponsor with available ADA was found");

  let totalSenderAda = BigInt(0);
  let totalNight = BigInt(0);
  for (const u of senderNightUtxos) {
    totalSenderAda += BigInt(u.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
    totalNight += BigInt(u.amount.find((a) => a.unit === `${NIGHT_POLICY}${NIGHT_NAME}`)?.quantity ?? "0");
  }

  let totalSponsorAda = BigInt(0);
  for (const u of sponsorAdaUtxos) {
    totalSponsorAda += BigInt(u.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
  }

  if (nightAmount > totalNight) throw new Error("Insufficient NIGHT");
  if (totalSenderAda + totalSponsorAda < MIN_TOKEN_LOVELACE + FEE_ESTIMATE) {
    throw new Error("Insufficient ADA even with a sponsor to cover the minimum UTxO plus fee");
  }

  const policyHash = lib.ScriptHash.from_bytes(Buffer.from(NIGHT_POLICY, "hex"));
  const assetName = lib.AssetName.new(Buffer.from(NIGHT_NAME, "hex"));

  const senderAdaToRecipient = totalSenderAda >= MIN_TOKEN_LOVELACE ? MIN_TOKEN_LOVELACE : totalSenderAda;
  const sponsorAdaToRecipient = MIN_TOKEN_LOVELACE - senderAdaToRecipient;
  const senderRemainingAda = totalSenderAda - senderAdaToRecipient;
  const sponsorRemainingAda = totalSponsorAda - sponsorAdaToRecipient - FEE_ESTIMATE;
  const remainingNight = totalNight - nightAmount;

  const inputs = lib.TransactionInputs.new();
  for (const u of senderNightUtxos) {
    inputs.add(lib.TransactionInput.new(
      lib.TransactionHash.from_hex(u.tx_hash), u.tx_index
    ));
  }
  for (const u of sponsorAdaUtxos) {
    inputs.add(lib.TransactionInput.new(
      lib.TransactionHash.from_hex(u.tx_hash), u.tx_index
    ));
  }

  const outputs = lib.TransactionOutputs.new();
  const recipAssets = lib.Assets.new();
  recipAssets.insert(assetName, lib.BigNum.from_str(nightAmount.toString()));
  const recipMulti = lib.MultiAsset.new();
  recipMulti.insert(policyHash, recipAssets);
  const recipValue = lib.Value.new(lib.BigNum.from_str(MIN_TOKEN_LOVELACE.toString()));
  recipValue.set_multiasset(recipMulti);
  const recipAddr = lib.Address.from_bytes(Buffer.from(recipientAddrHex, "hex"));
  outputs.add(lib.TransactionOutput.new(recipAddr, recipValue));

  if (senderRemainingAda >= BigInt(1_000_000) || remainingNight > 0n) {
    const senderChangeValue = lib.Value.new(lib.BigNum.from_str(
      (senderRemainingAda > 0n ? senderRemainingAda : BigInt(1_000_000)).toString()
    ));
    if (remainingNight > 0n) {
      const senderChangeAssets = lib.Assets.new();
      senderChangeAssets.insert(assetName, lib.BigNum.from_str(remainingNight.toString()));
      const senderChangeMulti = lib.MultiAsset.new();
      senderChangeMulti.insert(policyHash, senderChangeAssets);
      senderChangeValue.set_multiasset(senderChangeMulti);
    }
    const senderAddr = lib.Address.from_bytes(Buffer.from(senderAddrHex, "hex"));
    outputs.add(lib.TransactionOutput.new(senderAddr, senderChangeValue));
  }

  if (sponsorRemainingAda >= BigInt(1_000_000)) {
    const sponsorAddr = lib.Address.from_bytes(Buffer.from(sponsorAddrHex, "hex"));
    const sponsorValue = lib.Value.new(lib.BigNum.from_str(sponsorRemainingAda.toString()));
    outputs.add(lib.TransactionOutput.new(sponsorAddr, sponsorValue));
  }

  return signAndSerializeWithKeys(
    lib,
    inputs,
    outputs,
    FEE_ESTIMATE,
    currentSlot,
    [senderSigningKeyHex, sponsorSigningKeyHex]
  );
}

// ── Shared signing helper ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function signAndSerialize(lib: any, inputs: any, outputs: any, fee: bigint, slot: number, signingKeyHex: string): string {
  return signAndSerializeWithKeys(lib, inputs, outputs, fee, slot, [signingKeyHex]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function signAndSerializeWithKeys(lib: any, inputs: any, outputs: any, fee: bigint, slot: number, signingKeyHexes: string[]): string {
  const txBody = lib.TransactionBody.new_tx_body(
    inputs, outputs,
    lib.BigNum.from_str(fee.toString()),
    slot + 7200
  );
  const vkeys    = lib.Vkeywitnesses.new();
  const txHash = lib.hash_transaction(txBody);
  for (const signingKeyHex of [...new Set(signingKeyHexes)]) {
    const keyBytes = Buffer.from(signingKeyHex, "hex");
    const privKey  = keyBytes.length === 32
      ? lib.PrivateKey.from_normal_bytes(keyBytes)
      : lib.PrivateKey.from_extended_bytes(keyBytes);
    vkeys.add(lib.make_vkey_witness(txHash, privKey));
  }
  const witnesses = lib.TransactionWitnessSet.new();
  witnesses.set_vkeys(vkeys);

  return Buffer.from(lib.Transaction.new(txBody, witnesses, undefined).to_bytes()).toString("hex");
}
