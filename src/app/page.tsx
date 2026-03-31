"use client";

import { useEffect, useRef, useState } from "react";

interface Wallet {
  index: number;
  accountIndex: number;
  baseAddress: string;
  baseAddressHex: string;
  enterpriseAddress: string;
  enterpriseAddressHex: string;
  pubkeyHex: string;
  stakeAddress: string;
  // balances
  lovelace?: string;
  nightAmount?: string;
  claimableNight?: string;
  adaDisplay?: string;
  nightDisplay?: string;
  claimableDisplay?: string;
}

interface SponsorOption {
  accountIndex: number;
  index: number;
  baseAddress: string;
  lovelace: string;
  adaDisplay: string;
}

type AddrMode = "base" | "enterprise";

interface TransferState {
  wallet: Wallet;
  currency: "ADA" | "NIGHT";
  destType: "custom" | string; // "custom" or baseAddressHex of target wallet
  customAddr: string;
  amount: string;
  sendAll: boolean;
  submitting: boolean;
  result: { txHash: string; explorerUrl: string } | null;
  error: string;
}

interface RowActionState {
  loading: boolean;
  result: { txHash: string; explorerUrl: string; redeemedAmount?: number } | null;
  error: string;
}

interface PlayState {
  running: boolean;
  currentAddress: string | null;
  claimedCount: number;
  totalCount: number;
  lastMessage: string;
  stopRequested: boolean;
}

interface ConsolidationState {
  running: boolean;
  submittedCount: number;
  totalCount: number;
  lastMessage: string;
}

function TransferModal({
  state,
  wallets,
  blockfrostKey,
  mnemonic,
  onClose,
  onChange,
  onSubmit,
}: {
  state: TransferState;
  wallets: Wallet[];
  blockfrostKey: string;
  mnemonic: string;
  onClose: () => void;
  onChange: (patch: Partial<TransferState>) => void;
  onSubmit: () => void;
}) {
  const others = wallets.filter(w => w.baseAddress !== state.wallet.baseAddress);
  // Default dest wallet = next account
  const destWallet =
    state.destType !== "custom"
      ? wallets.find(w => w.baseAddressHex === state.destType) ?? null
      : null;

  const toAddressHex =
    state.destType === "custom"
      ? (() => {
          // Convert bech32 or hex — if it looks like hex already, use it; otherwise try to treat as address
          const v = state.customAddr.trim();
          if (/^[0-9a-fA-F]+$/.test(v)) return v;
          return v; // will be decoded server-side via bech32
        })()
      : destWallet?.baseAddressHex ?? "";

  const hasNight = Number(state.wallet.nightAmount ?? 0) > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-950/95 shadow-[0_30px_120px_rgba(0,0,0,0.45)]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div>
            <h2 className="text-white font-semibold">Transferir fondos</h2>
            <p className="mt-0.5 font-mono text-xs text-slate-500">
              Account {state.wallet.accountIndex} / Index {state.wallet.index}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 text-xl leading-none transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          {/* Currency */}
          <div>
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest block mb-1.5">
              Moneda
            </label>
            <div className="flex w-fit overflow-hidden rounded-xl border border-white/10 bg-slate-900/80 text-sm">
              {(["ADA", "NIGHT"] as ("ADA" | "NIGHT")[]).map(c => (
                <button
                  key={c}
                  onClick={() => onChange({ currency: c, sendAll: false, amount: "" })}
                  disabled={c === "NIGHT" && !hasNight}
                  className={`px-4 py-2 transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                    state.currency === c
                      ? "bg-slate-200 text-slate-950"
                      : "bg-transparent text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-600 mt-1">
              {state.currency === "ADA"
                ? `Disponible: ${state.wallet.adaDisplay ?? "—"}`
                : `Disponible: ${state.wallet.nightDisplay ?? "0 NIGHT"}`}
            </p>
          </div>

          {/* Destination */}
          <div>
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest block mb-1.5">
              Destino
            </label>
            <select
              value={state.destType}
              onChange={e => onChange({ destType: e.target.value, customAddr: "" })}
              className="w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm
                         text-slate-100 focus:outline-none focus:border-slate-500"
            >
              <option value="custom">Custom…</option>
              {others.map(w => (
                <option key={w.baseAddress} value={w.baseAddressHex}>
                  Account {w.accountIndex} — {w.baseAddress.slice(0, 20)}…{w.baseAddress.slice(-6)}
                </option>
              ))}
            </select>

            {state.destType === "custom" && (
              <input
                type="text"
                value={state.customAddr}
                onChange={e => onChange({ customAddr: e.target.value })}
                placeholder="addr1q... o hex de bytes de la dirección"
                className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm
                           text-slate-100 placeholder-slate-600 focus:outline-none focus:border-slate-500
                           font-mono"
              />
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest block mb-1.5">
              Monto
            </label>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={state.sendAll ? "todo" : state.amount}
                onChange={e => onChange({ amount: e.target.value, sendAll: false })}
                disabled={state.sendAll}
                placeholder={state.currency === "ADA" ? "lovelace (ej: 2000000)" : "unidades raw (ej: 50000000)"}
                className="flex-1 rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm
                           text-slate-100 placeholder-slate-600 focus:outline-none focus:border-slate-500
                           font-mono disabled:opacity-40"
              />
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={state.sendAll}
                  onChange={e => onChange({ sendAll: e.target.checked, amount: "" })}
                  className="accent-violet-500"
                />
                Enviar todo
              </label>
            </div>
            {state.currency === "ADA" && (
              <p className="text-xs text-slate-600 mt-1">1 ADA = 1,000,000 lovelace</p>
            )}
            {state.currency === "NIGHT" && (
              <p className="text-xs text-slate-600 mt-1">1 NIGHT = 1,000,000 unidades · requiere ~1.5 ADA de gas</p>
            )}
          </div>

          {/* Result / Error */}
          {state.result && (
            <div className="rounded-xl border border-emerald-800/60 bg-emerald-950/40 p-3 text-sm">
              <p className="text-green-300 font-semibold">Transacción enviada</p>
              <p className="text-green-400 font-mono text-xs mt-1 break-all">{state.result.txHash}</p>
              <a
                href={state.result.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-violet-400 hover:text-violet-300 text-xs underline mt-1 block"
              >
                Ver en Cardanoscan →
              </a>
            </div>
          )}
          {state.error && (
            <div className="rounded-xl border border-red-900/70 bg-red-950/40 p-3 text-sm text-red-300">
              {state.error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-white/10 px-5 py-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onSubmit}
            disabled={
              state.submitting ||
              (state.destType === "custom" ? !state.customAddr.trim() : !toAddressHex) ||
              (!state.sendAll && !state.amount.trim())
            }
            className="rounded-xl bg-slate-200 px-5 py-2 text-sm font-medium text-slate-950
                       transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40
                       transition-colors flex items-center gap-2"
          >
            {state.submitting ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Enviando…
              </>
            ) : "Enviar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [mnemonic, setMnemonic]         = useState("");
  const [count, setCount]               = useState(1);
  const [maxAccounts, setMaxAccounts]   = useState(50);
  const [wallets, setWallets]           = useState<Wallet[]>([]);
  const [loading, setLoading]           = useState(false);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [error, setError]               = useState("");
  const [balancesLoaded, setBalancesLoaded]   = useState(false);
  const [addrMode, setAddrMode]         = useState<AddrMode>("base");
  const [blockfrostKey, setBlockfrostKey] = useState("");
  const [minClaimNight, setMinClaimNight] = useState("5");
  const [consolidationAddress, setConsolidationAddress] = useState("");
  const [sponsorOptions, setSponsorOptions] = useState<SponsorOption[]>([]);
  const [selectedSponsorAccountIndex, setSelectedSponsorAccountIndex] = useState<string>("auto");
  const [sponsorsLoading, setSponsorsLoading] = useState(false);
  const [transfer, setTransfer]         = useState<TransferState | null>(null);
  const [rowActions, setRowActions]     = useState<Record<string, RowActionState>>({});
  const [playState, setPlayState]       = useState<PlayState>({
    running: false,
    currentAddress: null,
    claimedCount: 0,
    totalCount: 0,
    lastMessage: "",
    stopRequested: false,
  });
  const [consolidationState, setConsolidationState] = useState<ConsolidationState>({
    running: false,
    submittedCount: 0,
    totalCount: 0,
    lastMessage: "",
  });
  const walletsRef = useRef<Wallet[]>([]);
  const playStateRef = useRef<PlayState>(playState);
  const confirmedClaimsRef = useRef<Set<string>>(new Set());

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  useEffect(() => {
    walletsRef.current = wallets;
  }, [wallets]);

  useEffect(() => {
    playStateRef.current = playState;
  }, [playState]);

  useEffect(() => {
    void fetchSponsors();
  }, []);

  useEffect(() => {
    if (wallets.length > 0) {
      void fetchBalances(wallets);
    }
  }, [selectedSponsorAccountIndex]);

  async function fetchSponsors() {
    setSponsorsLoading(true);
    try {
      const res = await fetch("/api/sponsors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mnemonic,
          blockfrostApiKey: blockfrostKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSponsorOptions(data.sponsors ?? []);
    } catch (e) {
      setError(String(e));
    } finally {
      setSponsorsLoading(false);
    }
  }

  // ── Fetch balances ─────────────────────────────────────────────────────────
  async function fetchBalances(walletList: Wallet[]) {
    if (!walletList.length) return walletList;
    setBalancesLoading(true);
    setError("");
    try {
      const res = await fetch("/api/balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallets: walletList,
          blockfrostApiKey: blockfrostKey,
          sponsorAddress:
            selectedSponsorAccountIndex === "auto"
              ? null
              : sponsorOptions.find((option) => String(option.accountIndex) === selectedSponsorAccountIndex)?.baseAddress ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const byAddr: Record<string, (typeof data.balances)[0]> = {};
      for (const b of data.balances) byAddr[b.baseAddress] = b;

      const nextWallets = walletList.map((w) => {
          const b = byAddr[w.baseAddress];
          return b ? {
            ...w,
            lovelace: b.lovelace,
            nightAmount: b.nightAmount,
            claimableNight: b.claimableNight,
            adaDisplay: b.adaDisplay,
            nightDisplay: b.nightDisplay,
            claimableDisplay: b.claimableDisplay,
          } : w;
        });
      confirmedClaimsRef.current = new Set(
        [...confirmedClaimsRef.current].filter((address) => {
          const wallet = nextWallets.find((entry) => entry.baseAddress === address);
          return wallet ? Number(wallet.claimableNight ?? 0) > 0 : false;
        })
      );
      setWallets(nextWallets);
      setBalancesLoaded(true);
      return nextWallets;
    } catch (e) {
      setError(String(e));
      return walletList;
    } finally {
      setBalancesLoading(false);
    }
  }

  async function refreshBalancesWithRetry(walletList: Wallet[], attempts = 4) {
    let latestWallets = walletList;
    for (let i = 0; i < attempts; i++) {
      latestWallets = await fetchBalances(latestWallets);
      if (i < attempts - 1) await sleep(2_000);
    }
    return latestWallets;
  }

  // ── Derive + auto-fetch balances ───────────────────────────────────────────
  async function handleDerive() {
    setError("");
    setLoading(true);
    setWallets([]);
    confirmedClaimsRef.current = new Set();
    setSponsorOptions([]);
    setSelectedSponsorAccountIndex("auto");
    setBalancesLoaded(false);
    try {
      const res = await fetch("/api/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mnemonic, count, maxAccounts }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setWallets(data.wallets);
      setLoading(false);
      await fetchSponsors();
      await fetchBalances(data.wallets);
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  // ── Open transfer modal ────────────────────────────────────────────────────
  function openTransfer(w: Wallet) {
    setTransfer({
      wallet: w,
      currency: "ADA",
      destType: "custom",
      customAddr: "",
      amount: "",
      sendAll: false,
      submitting: false,
      result: null,
      error: "",
    });
  }

  function setRowAction(address: string, patch: Partial<RowActionState>) {
    setRowActions((prev) => ({
      ...prev,
      [address]: Object.assign(
        { loading: false, result: null, error: "" },
        prev[address],
        patch
      ),
    }));
  }

  function formatWalletLabel(wallet: Wallet) {
    return `Acc ${wallet.accountIndex} / Idx ${wallet.index}`;
  }

  function getClaimableNightDisplayValue(wallet: Wallet) {
    return Number(wallet.claimableNight ?? 0) / 1_000_000;
  }

  function getMinClaimNightValue() {
    const parsed = Number(minClaimNight);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function canClaimWallet(wallet: Wallet) {
    return (
      getClaimableNightDisplayValue(wallet) >= getMinClaimNightValue() &&
      !confirmedClaimsRef.current.has(wallet.baseAddress)
    );
  }

  function playCompletionSound() {
    if (typeof window === "undefined") return;
    const AudioCtx = window.AudioContext || (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const notes = [
      { freq: 880, start: 0, duration: 0.08 },
      { freq: 1174.66, start: 0.1, duration: 0.08 },
      { freq: 1567.98, start: 0.22, duration: 0.16 },
    ];

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + note.start);
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + note.start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + note.start + note.duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + note.start);
      osc.stop(ctx.currentTime + note.start + note.duration);
    }

    window.setTimeout(() => {
      void ctx.close().catch(() => undefined);
    }, 700);
  }

  async function waitForTransactionConfirmation(txHash: string) {
    for (let attempt = 0; attempt < 90; attempt++) {
      const res = await fetch("/api/tx-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash,
          blockfrostApiKey: blockfrostKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "No se pudo verificar la transacción");
      }
      if (data.confirmed) return data as { confirmed: boolean; confirmations: number; explorerUrl: string };
      await sleep(4_000);
    }

    throw new Error("La transacción no confirmó a tiempo");
  }

  async function claimNightAndWait(w: Wallet) {
    setRowAction(w.baseAddress, { loading: true, error: "", result: null });
    try {
      const res = await fetch("/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mnemonic,
          fromAccountIndex: w.accountIndex,
          fromAddressIndex: w.index,
          blockfrostApiKey: blockfrostKey,
          sponsorAccountIndex:
            selectedSponsorAccountIndex === "auto"
              ? null
              : Number(selectedSponsorAccountIndex),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setPlayState((prev) => ({
        ...prev,
        lastMessage: `${formatWalletLabel(w)} submitted. Waiting for confirmation...`,
      }));

      await waitForTransactionConfirmation(data.txHash);

      confirmedClaimsRef.current = new Set(confirmedClaimsRef.current).add(w.baseAddress);
      setRowAction(w.baseAddress, { loading: false, result: data, error: "" });

      void fetchSponsors();
      void refreshBalancesWithRetry(walletsRef.current);

      return {
        result: data as { txHash: string; explorerUrl: string; redeemedAmount?: number },
      };
    } catch (e) {
      const message = String(e);
      setRowAction(w.baseAddress, { loading: false, error: message });
      throw new Error(message);
    }
  }

  async function quickSendAdaToNext(w: Wallet) {
    const nextWallet =
      wallets.find((x) => x.accountIndex === w.accountIndex + 1 && x.index === 0) ?? null;

    if (!nextWallet) {
      setRowAction(w.baseAddress, { error: "No existe la siguiente dirección en la lista." });
      return;
    }

    setRowAction(w.baseAddress, { loading: true, error: "", result: null });
    try {
      const currentLovelace = BigInt(w.lovelace ?? "0");
      const reserveLovelace = BigInt(1_500_000);
      const feeEstimate = BigInt(250_000);
      const optimisticSend =
        currentLovelace > reserveLovelace + feeEstimate
          ? currentLovelace - reserveLovelace - feeEstimate
          : BigInt(0);

      const res = await fetch("/api/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mnemonic,
          fromAccountIndex: w.accountIndex,
          fromAddressIndex: w.index,
          toAddressHex: nextWallet.baseAddressHex,
          currency: "ADA",
          amount: "all",
          reserveLovelace: "1500000",
          blockfrostApiKey: blockfrostKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setWallets((prev) =>
        prev.map((wallet) => {
          if (wallet.baseAddress === w.baseAddress) {
            return {
              ...wallet,
              lovelace: reserveLovelace.toString(),
              adaDisplay: (Number(reserveLovelace) / 1_000_000).toFixed(2) + " ADA",
            };
          }
          if (wallet.baseAddress === nextWallet.baseAddress) {
            const updated = BigInt(wallet.lovelace ?? "0") + optimisticSend;
            return {
              ...wallet,
              lovelace: updated.toString(),
              adaDisplay: (Number(updated) / 1_000_000).toFixed(2) + " ADA",
            };
          }
          return wallet;
        })
      );

      setRowAction(w.baseAddress, { loading: false, result: data });
      void refreshBalancesWithRetry(wallets);
    } catch (e) {
      setRowAction(w.baseAddress, { loading: false, error: String(e) });
    }
  }

  async function claimNight(w: Wallet) {
    if (!canClaimWallet(w)) {
      setRowAction(w.baseAddress, {
        loading: false,
        error: `Claimable menor al mínimo configurado (${getMinClaimNightValue().toFixed(4)} NIGHT).`,
        result: null,
      });
      return;
    }
    try {
      await claimNightAndWait(w);
    } catch {}
  }

  async function startPlayMode() {
    const minClaim = getMinClaimNightValue();
    const initialWallets = walletsRef.current.filter((wallet) => canClaimWallet(wallet));
    if (!initialWallets.length) {
      setPlayState({
        running: false,
        currentAddress: null,
        claimedCount: 0,
        totalCount: 0,
        lastMessage: minClaim > 0
          ? `No hay wallets con al menos ${minClaim.toFixed(4)} NIGHT reclamable.`
          : "No hay wallets con NIGHT reclamable.",
        stopRequested: false,
      });
      return;
    }

    setPlayState({
      running: true,
      currentAddress: null,
      claimedCount: 0,
      totalCount: initialWallets.length,
      lastMessage: `Play mode iniciado. ${initialWallets.length} wallet(s) pendientes.`,
      stopRequested: false,
    });

    let claimedCount = 0;

    try {
      while (true) {
        if (playStateRef.current.stopRequested) {
          setPlayState((prev) => ({
            ...prev,
            running: false,
            currentAddress: null,
            lastMessage: `Play mode detenido. ${claimedCount}/${prev.totalCount} claims completados.`,
          }));
          return;
        }

        const nextWallet = walletsRef.current.find((wallet) => canClaimWallet(wallet)) ?? null;

        if (!nextWallet) {
          setPlayState((prev) => ({
            ...prev,
            running: false,
            currentAddress: null,
            claimedCount,
            lastMessage: `Play mode completo. ${claimedCount} claim(s) confirmados.`,
            stopRequested: false,
          }));
          playCompletionSound();
          return;
        }

        setPlayState((prev) => ({
          ...prev,
          currentAddress: nextWallet.baseAddress,
          lastMessage: `Claiming ${formatWalletLabel(nextWallet)}...`,
        }));

        await claimNightAndWait(nextWallet);
        claimedCount += 1;

        setPlayState((prev) => ({
          ...prev,
          claimedCount,
          currentAddress: null,
          lastMessage: `${formatWalletLabel(nextWallet)} confirmado. Buscando el siguiente claim...`,
        }));
      }
    } catch (e) {
      setPlayState((prev) => ({
        ...prev,
        running: false,
        currentAddress: null,
        claimedCount,
        lastMessage: `Play mode frenado por error: ${String(e)}`,
        stopRequested: false,
      }));
    }
  }

  function stopPlayMode() {
    setPlayState((prev) => ({
      ...prev,
      stopRequested: true,
      lastMessage: prev.running ? "Deteniendo play mode al terminar la transacción actual..." : prev.lastMessage,
    }));
  }

  // ── Submit transfer ────────────────────────────────────────────────────────
  async function submitTransfer() {
    if (!transfer) return;
    setTransfer(t => t ? { ...t, submitting: true, error: "", result: null } : t);

    const destWallet = transfer.destType !== "custom"
      ? wallets.find(w => w.baseAddressHex === transfer.destType)
      : null;

    const toAddressHex = transfer.destType === "custom"
      ? transfer.customAddr.trim()
      : destWallet?.baseAddressHex ?? "";

    try {
      const res = await fetch("/api/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mnemonic,
          fromAccountIndex: transfer.wallet.accountIndex,
          fromAddressIndex: transfer.wallet.index,
          toAddressHex,
          currency: transfer.currency,
          amount: transfer.sendAll ? "all" : transfer.amount,
          blockfrostApiKey: blockfrostKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setTransfer(t => t ? { ...t, submitting: false, result: data } : t);
      void refreshBalancesWithRetry(wallets);
    } catch (e) {
      setTransfer(t => t ? { ...t, submitting: false, error: String(e) } : t);
    }
  }

  async function consolidateNightToCustomAddress() {
    const destination = consolidationAddress.trim();
    if (!destination) {
      setError("Ingresá una dirección custom para consolidar NIGHT.");
      return;
    }

    const normalizedDestination = destination.toLowerCase();
    const walletsWithNight = walletsRef.current.filter((wallet) => {
      if (Number(wallet.nightAmount ?? 0) <= 0) return false;
      const knownAddresses = [
        wallet.baseAddress,
        wallet.enterpriseAddress,
        wallet.baseAddressHex,
        wallet.enterpriseAddressHex,
      ].map((value) => value.toLowerCase());
      return !knownAddresses.includes(normalizedDestination);
    });
    if (!walletsWithNight.length) {
      setConsolidationState({
        running: false,
        submittedCount: 0,
        totalCount: 0,
        lastMessage: "No hay wallets con NIGHT para consolidar.",
      });
      return;
    }

    setConsolidationState({
      running: true,
      submittedCount: 0,
      totalCount: walletsWithNight.length,
      lastMessage: `Consolidando NIGHT desde ${walletsWithNight.length} wallet(s)...`,
    });

    let submittedCount = 0;

    for (const wallet of walletsWithNight) {
      setConsolidationState((prev) => ({
        ...prev,
        lastMessage: `Enviando NIGHT desde ${formatWalletLabel(wallet)}...`,
      }));
      setRowAction(wallet.baseAddress, { loading: true, error: "", result: null });

      try {
        let transferResult:
          | { txHash: string; explorerUrl: string; redeemedAmount?: number }
          | null = null;

        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await fetch("/api/transfer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mnemonic,
              fromAccountIndex: wallet.accountIndex,
              fromAddressIndex: wallet.index,
              toAddressHex: destination,
              currency: "NIGHT",
              amount: "all",
              blockfrostApiKey: blockfrostKey,
            }),
          });
          const data = await res.json();

          if (res.ok) {
            transferResult = data;
            break;
          }

          const message = String(data.error ?? "");
          if (
            attempt === 0 &&
            message.includes("ADA insuficiente para cubrir el mínimo UTXO + fee")
          ) {
            const sponsorWallet = walletsRef.current
              .filter((candidate) => candidate.baseAddress !== wallet.baseAddress)
              .sort((a, b) => Number(b.lovelace ?? 0) - Number(a.lovelace ?? 0))
              .find((candidate) => Number(candidate.lovelace ?? 0) >= 2_100_000);

            if (!sponsorWallet) {
              throw new Error("No hay otra wallet con ADA suficiente para fondear el envío de NIGHT.");
            }

            setConsolidationState((prev) => ({
              ...prev,
              lastMessage: `Fondeando ${formatWalletLabel(wallet)} desde ${formatWalletLabel(sponsorWallet)}...`,
            }));

            const topupRes = await fetch("/api/transfer", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mnemonic,
                fromAccountIndex: sponsorWallet.accountIndex,
                fromAddressIndex: sponsorWallet.index,
                toAddressHex: wallet.baseAddressHex,
                currency: "ADA",
                amount: "2000000",
                blockfrostApiKey: blockfrostKey,
              }),
            });
            const topupData = await topupRes.json();
            if (!topupRes.ok) throw new Error(topupData.error);

            await waitForTransactionConfirmation(topupData.txHash);
            await fetchBalances(walletsRef.current);
            continue;
          }

          throw new Error(message);
        }

        if (!transferResult) {
          throw new Error("No se pudo construir la transferencia de NIGHT.");
        }

        setConsolidationState((prev) => ({
          ...prev,
          lastMessage: `${formatWalletLabel(wallet)} enviada. Esperando confirmación...`,
        }));
        await waitForTransactionConfirmation(transferResult.txHash);

        submittedCount += 1;
        setRowAction(wallet.baseAddress, { loading: false, result: transferResult, error: "" });
        setConsolidationState((prev) => ({
          ...prev,
          submittedCount,
          lastMessage: `${formatWalletLabel(wallet)} enviado. Siguiendo con la siguiente wallet...`,
        }));
      } catch (e) {
        setRowAction(wallet.baseAddress, { loading: false, error: String(e), result: null });
        setConsolidationState((prev) => ({
          ...prev,
          lastMessage: `Error en ${formatWalletLabel(wallet)}. Continuando...`,
        }));
      }
    }

    setConsolidationState((prev) => ({
      ...prev,
      running: false,
      lastMessage: `Consolidación enviada. ${submittedCount}/${prev.totalCount} transacciones submitidas.`,
    }));
    void refreshBalancesWithRetry(walletsRef.current);
  }

  const totalAda   = wallets.reduce((s, w) => s + Number(w.lovelace ?? 0), 0) / 1_000_000;
  const totalNight = wallets.reduce((s, w) => s + Number(w.nightAmount ?? 0), 0) / 1_000_000;
  const totalClaimable = wallets.reduce((s, w) => s + Number(w.claimableNight ?? 0), 0) / 1_000_000;
  const totalClaimableEligible = wallets
    .filter((w) => canClaimWallet(w))
    .reduce((s, w) => s + Number(w.claimableNight ?? 0), 0) / 1_000_000;
  const minClaimValue = getMinClaimNightValue();
  const withAda    = wallets.filter((w) => Number(w.lovelace ?? 0) > 0).length;
  const withNight  = wallets.filter((w) => Number(w.nightAmount ?? 0) > 0).length;
  const withClaimable = wallets.filter((w) => Number(w.claimableNight ?? 0) > 0).length;
  const withClaimableEligible = wallets.filter((w) => canClaimWallet(w)).length;
  const selectedSponsorOption =
    selectedSponsorAccountIndex === "auto"
      ? null
      : sponsorOptions.find((option) => String(option.accountIndex) === selectedSponsorAccountIndex) ?? null;

  const displayAddr = (w: Wallet) =>
    addrMode === "base" ? w.baseAddress : w.enterpriseAddress;

  return (
    <div className="min-h-screen px-5 py-8 text-slate-200 md:px-8">
      <div className="mx-auto max-w-7xl">

        {/* Header */}
        <div className="mb-8 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Midnight Operator Console
            </div>
            <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-tight text-white">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-300 shadow-[0_0_18px_rgba(252,211,77,0.6)]" />
              MidnightMiner Claimer
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">
              Derivá wallets, chequeá ADA y NIGHT, detectá rewards reclamables y mové fondos entre accounts sin salir del panel.
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-right">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Modo</div>
            <div className="mt-1 text-sm font-medium text-slate-200">Dark minimal operator view</div>
          </div>
        </div>

        {/* Input panel */}
        <div className="mb-6 rounded-3xl border border-white/10 bg-slate-950/70 p-6 shadow-[0_18px_80px_rgba(0,0,0,0.35)] backdrop-blur">
          <div className="flex flex-col gap-4">

            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest block mb-1.5">
                Seed Phrase
              </label>
              <textarea
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
                placeholder="word1 word2 word3 ... word12/24"
                rows={3}
                className="w-full bg-[#07060f] border border-[#1e1b3a] rounded-lg px-3 py-2.5 text-sm
                           text-slate-100 placeholder-slate-600 focus:outline-none focus:border-violet-600
                           font-mono resize-none"
              />
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1 min-w-72">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                  Sponsor para claims
                </label>
                <select
                  value={selectedSponsorAccountIndex}
                  onChange={(e) => setSelectedSponsorAccountIndex(e.target.value)}
                  className="rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm
                             text-slate-100 focus:outline-none focus:border-slate-500"
                >
                  <option value="auto">Auto · mejor sponsor disponible</option>
                  {sponsorOptions.map((option) => (
                    <option key={option.baseAddress} value={String(option.accountIndex)}>
                      {`Acc ${option.accountIndex} / ${option.index} · ${option.adaDisplay}`}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-slate-600">
                  {sponsorsLoading
                    ? "Cargando sponsors..."
                    : selectedSponsorOption
                      ? `${selectedSponsorOption.baseAddress.slice(0, 24)}…${selectedSponsorOption.baseAddress.slice(-8)}`
                      : "Elige la account sponsor manualmente o usa selección automática."}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                  Wallets a derivar
                </label>
                <input
                  type="number" min={1} max={50} value={count}
                  onChange={(e) => setCount(Math.min(50, Math.max(1, Number(e.target.value))))}
                  className="w-20 rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm
                             text-slate-100 focus:outline-none focus:border-slate-500"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                  Accounts a revisar
                </label>
                <input
                  type="number" min={1} max={200} value={maxAccounts}
                  onChange={(e) => setMaxAccounts(Math.min(200, Math.max(1, Number(e.target.value))))}
                  className="w-20 rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm
                             text-slate-100 focus:outline-none focus:border-slate-500"
                />
              </div>

              <div className="flex flex-col gap-1 flex-1 min-w-48">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                  Blockfrost API Key <span className="text-slate-600 normal-case font-normal">(opcional si existe en .env.local)</span>
                </label>
                <input
                  type="password"
                  value={blockfrostKey}
                  onChange={(e) => setBlockfrostKey(e.target.value)}
                  placeholder="mainnetXXXXXXXXXXXXXXXXXXXXXXXXX"
                  className="rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm
                             text-slate-100 placeholder-slate-600 focus:outline-none focus:border-slate-500
                             font-mono"
                />
              </div>

              <div className="flex flex-col gap-1 min-w-44">
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                  Min claim NIGHT
                </label>
                <input
                  type="number"
                  min={0}
                  step="0.0001"
                  value={minClaimNight}
                  onChange={(e) => setMinClaimNight(e.target.value)}
                  placeholder="0"
                  className="rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm
                             text-slate-100 placeholder-slate-600 focus:outline-none focus:border-slate-500
                             font-mono"
                />
                <div className="text-xs text-slate-600">
                  Solo reclama wallets con al menos ese NIGHT pendiente.
                </div>
              </div>

              <button
                onClick={handleDerive}
                disabled={loading || !mnemonic.trim()}
                className="rounded-xl bg-slate-200 px-5 py-2 text-sm font-medium text-slate-950
                           transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40
                           transition-colors flex items-center gap-2"
              >
                {loading ? (
                  <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>Derivando...</>
                ) : balancesLoading ? (
                  <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>Cargando balances...</>
                ) : "Derivar y ver balances"}
              </button>
            </div>

            <p className="text-xs text-slate-600">
              Revisa <em>accounts</em> × <em>wallets</em> direcciones · Ruta m/1852&apos;/1815&apos;/acc&apos;/0/idx ·
              Base (addr1q) para Eternl/Nami/Yoroi · Enterprise (addr1v) para MidnightMiner
            </p>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-end">
                <div className="flex-1">
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest block mb-1.5">
                    Consolidar todo el NIGHT a
                  </label>
                  <input
                    type="text"
                    value={consolidationAddress}
                    onChange={(e) => setConsolidationAddress(e.target.value)}
                    placeholder="addr1... o hex"
                    className="w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm
                               text-slate-100 placeholder-slate-600 focus:outline-none focus:border-slate-500
                               font-mono"
                  />
                  <div className="mt-1 text-xs text-slate-600">
                    Hace una tx por wallet con NIGHT usando `amount = all`, que es lo más simple y barato posible con este modelo.
                  </div>
                </div>
                <button
                  onClick={consolidateNightToCustomAddress}
                  disabled={consolidationState.running || playState.running || !consolidationAddress.trim()}
                  className="rounded-xl bg-violet-200 px-5 py-2 text-sm font-medium text-slate-950
                             transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {consolidationState.running ? "Consolidando..." : "Consolidar NIGHT"}
                </button>
              </div>
              {consolidationState.lastMessage && (
                <div className="mt-3 text-xs text-violet-200">
                  {consolidationState.running
                    ? `${consolidationState.submittedCount}/${consolidationState.totalCount} submitidas. `
                    : ""}
                  {consolidationState.lastMessage}
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="mt-3 p-3 bg-red-950/60 border border-red-800 rounded-lg text-red-300 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Results */}
        {wallets.length > 0 && (
          <div className="overflow-hidden rounded-3xl border border-white/10 bg-slate-950/70 shadow-[0_18px_80px_rgba(0,0,0,0.3)] backdrop-blur">

            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-[#1e1b3a]">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-white">
                  {wallets.length} wallets · {maxAccounts} account{maxAccounts > 1 ? "s" : ""}
                </span>
                <div className="flex rounded-lg overflow-hidden border border-[#2a2750] text-xs">
                  {(["base", "enterprise"] as AddrMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => setAddrMode(m)}
                      className={`px-3 py-1.5 transition-colors ${
                        addrMode === m
                          ? "bg-violet-800 text-white"
                          : "bg-[#13112a] text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {m === "base" ? "Base (addr1q)" : "Enterprise (addr1v)"}
                    </button>
                  ))}
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300">
                  {playState.running
                    ? `${playState.claimedCount}/${playState.totalCount} confirmados`
                    : `${withClaimableEligible} pendientes`}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={playState.running ? stopPlayMode : startPlayMode}
                  disabled={balancesLoading || consolidationState.running || (!playState.running && withClaimableEligible === 0)}
                  className={`px-4 py-1.5 border text-sm rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 ${
                    playState.running
                      ? "bg-red-950/70 hover:bg-red-900 border-red-800 text-red-300 hover:text-red-100"
                      : "bg-amber-950/70 hover:bg-amber-900 border-amber-800 text-amber-300 hover:text-amber-100"
                  }`}
                >
                  {playState.running ? "■ Stop play mode" : "▶ Play mode"}
                </button>
                <button
                  onClick={() => fetchBalances(wallets)}
                  disabled={balancesLoading || playState.running || consolidationState.running}
                  className="px-4 py-1.5 bg-[#1a1735] hover:bg-[#22204a] border border-violet-800
                             text-violet-300 hover:text-violet-100 text-sm rounded-lg transition-colors
                             disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {balancesLoading ? (
                    <><svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>Actualizando...</>
                  ) : "↺ Actualizar balances"}
                </button>
              </div>
            </div>

            {(playState.lastMessage || playState.running) && (
              <div className="border-b border-[#1e1b3a] bg-amber-950/10 px-5 py-3 text-xs text-amber-200">
                <span className="font-medium">{playState.running ? "Play mode activo." : "Play mode."}</span>{" "}
                {playState.lastMessage}
              </div>
            )}

            {/* Summary */}
            {balancesLoaded && (
              <div className="grid grid-cols-5 divide-x divide-[#1e1b3a] border-b border-[#1e1b3a]">
                {[
                  { label: "Total wallets", value: wallets.length },
                  { label: "Con ADA",       value: withAda },
                  { label: "Total ADA",     value: totalAda.toFixed(2) },
                  { label: "Total NIGHT",   value: totalNight.toFixed(4), hi: withNight > 0 },
                  {
                    label: minClaimValue > 0 ? `Claimable ≥ ${minClaimValue.toFixed(4)}` : "Claimable",
                    value: (minClaimValue > 0 ? totalClaimableEligible : totalClaimable).toFixed(4),
                    hi: withClaimable > 0,
                  },
                ].map((s) => (
                  <div key={s.label} className="px-5 py-3 text-center">
                    <div className={`text-xl font-bold ${s.hi ? "text-violet-400" : "text-white"}`}>
                      {s.value}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1200px] text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-[#1e1b3a]">
                    <th className="px-4 py-3 text-left whitespace-nowrap">Acc / Idx</th>
                    <th className="px-4 py-3 text-left">
                      {addrMode === "base" ? "Base Address (addr1q)" : "Enterprise Address (addr1v)"}
                    </th>
                    {balancesLoaded && (
                      <>
                        <th className="px-4 py-3 text-right whitespace-nowrap">ADA</th>
                        <th className="px-4 py-3 text-right whitespace-nowrap">NIGHT</th>
                        <th className="px-4 py-3 text-right whitespace-nowrap">Claimable</th>
                      </>
                    )}
                    <th className="px-4 py-3 text-right whitespace-nowrap"></th>
                  </tr>
                </thead>
                <tbody>
                  {wallets.map((w) => {
                    const hasAda   = Number(w.lovelace ?? 0) > 0;
                    const hasNight = Number(w.nightAmount ?? 0) > 0;
                    const hasClaimable = Number(w.claimableNight ?? 0) > 0;
                    const claimAllowed = canClaimWallet(w);
                    return (
                      <tr
                        key={w.baseAddress}
                        className={`border-b border-[#13112a] hover:bg-[#11102a] transition-colors ${
                          hasAda || hasNight ? "bg-violet-950/10" : ""
                        }`}
                      >
                        <td className="px-4 py-3 text-center whitespace-nowrap">
                          <span className="text-xs text-violet-400 font-mono">{w.accountIndex}</span>
                          <span className="text-slate-700 mx-1">/</span>
                          <span className="text-xs text-slate-500 font-mono">{w.index}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-mono text-xs text-slate-300 break-all">
                            {displayAddr(w)}
                          </div>
                          {addrMode === "base" && (
                            <div className="font-mono text-[10px] text-slate-600 mt-0.5">
                              stake: {w.stakeAddress.slice(0, 28)}…
                            </div>
                          )}
                        </td>
                        {balancesLoaded && (
                          <>
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              <span className={hasAda ? "text-slate-200 font-medium" : "text-slate-600"}>
                                {w.adaDisplay ?? "—"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              {hasNight
                                ? <span className="text-violet-400 font-semibold">{w.nightDisplay}</span>
                                : <span className="text-slate-600">0 NIGHT</span>}
                            </td>
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              {hasClaimable
                                ? <span className="text-amber-300 font-semibold">{w.claimableDisplay}</span>
                                : <span className="text-slate-600">0 NIGHT</span>}
                            </td>
                          </>
                        )}
                        <td className="px-4 py-3 text-right align-top">
                          <div className="flex justify-end gap-2 flex-wrap">
                            <button
                              onClick={() => quickSendAdaToNext(w)}
                              disabled={rowActions[w.baseAddress]?.loading || playState.running || consolidationState.running}
                              className="px-3 py-1.5 text-xs bg-emerald-950/70 hover:bg-emerald-900 border border-emerald-800
                                         text-emerald-300 hover:text-emerald-100 rounded-md transition-colors
                                         disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Enviar todo menos 1.5 ADA al siguiente account"
                            >
                              {rowActions[w.baseAddress]?.loading ? "Procesando..." : "Pasar ADA"}
                            </button>
                            <button
                              onClick={() => openTransfer(w)}
                              disabled={playState.running || consolidationState.running}
                              className="px-3 py-1.5 text-xs bg-[#1a1735] hover:bg-[#22204a] border border-[#2a2750]
                                         text-violet-300 hover:text-violet-100 rounded-md transition-colors
                                         disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Transferir ADA o NIGHT"
                            >
                              Transferir
                            </button>
                            {hasClaimable && (
                              <button
                                onClick={() => claimNight(w)}
                                disabled={rowActions[w.baseAddress]?.loading || playState.running || consolidationState.running || !claimAllowed}
                                className="px-3 py-1.5 text-xs bg-amber-950/70 hover:bg-amber-900 border border-amber-800
                                           text-amber-300 hover:text-amber-100 rounded-md transition-colors
                                           disabled:opacity-30 disabled:cursor-not-allowed"
                                title={claimAllowed
                                  ? "Intentar claim de NIGHT"
                                  : `Requiere al menos ${minClaimValue.toFixed(4)} NIGHT reclamable`}
                              >
                                Claim NIGHT
                              </button>
                            )}
                          </div>
                          {(rowActions[w.baseAddress]?.error || rowActions[w.baseAddress]?.result) && (
                            <div className="mt-2 max-w-sm ml-auto text-left">
                              {rowActions[w.baseAddress]?.error && (
                                <div className="text-[10px] text-red-300 break-words">
                                  {rowActions[w.baseAddress]?.error}
                                </div>
                              )}
                              {rowActions[w.baseAddress]?.result && (
                                <div className="text-[10px] text-emerald-300 break-words">
                                  {typeof rowActions[w.baseAddress]?.result?.redeemedAmount === "number" && (
                                    <div>
                                      Claimed: {(rowActions[w.baseAddress]?.result?.redeemedAmount! / 1_000_000).toFixed(6)} NIGHT
                                    </div>
                                  )}
                                  <a
                                    href={rowActions[w.baseAddress]?.result?.explorerUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-violet-300 underline break-all"
                                  >
                                    {rowActions[w.baseAddress]?.result?.txHash}
                                  </a>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-3 border-t border-[#1e1b3a] text-xs text-slate-600">
              ADA: Koios API · NIGHT: on-chain token · Claves privadas nunca salen del servidor local
            </div>
          </div>
        )}
      </div>

      {/* Transfer modal */}
      {transfer && (
        <TransferModal
          state={transfer}
          wallets={wallets}
          blockfrostKey={blockfrostKey}
          mnemonic={mnemonic}
          onClose={() => setTransfer(null)}
          onChange={(patch) => setTransfer(t => t ? { ...t, ...patch } : t)}
          onSubmit={submitTransfer}
        />
      )}
    </div>
  );
}
