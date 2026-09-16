/**
 * Soft operator chimes via Web Audio. No samples, no harsh beeps.
 */

type NotifyKind = "done" | "tick" | "error";

let audioCtx: AudioContext | null = null;
let unlocked = false;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx = window.AudioContext || (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  return audioCtx;
}

export function unlockNotifyAudio() {
  if (unlocked) return;
  const ctx = getContext();
  if (!ctx) return;
  unlocked = true;
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => undefined);
  }
}

function tone(
  ctx: AudioContext,
  dest: GainNode,
  freq: number,
  start: number,
  duration: number,
  peak: number,
  type: OscillatorType = "sine"
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.022);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function playPattern(kind: NotifyKind) {
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume().then(() => playPattern(kind)).catch(() => undefined);
    return;
  }

  const master = ctx.createGain();
  master.gain.value = 0.22;
  master.connect(ctx.destination);
  const t = ctx.currentTime + 0.01;

  if (kind === "done") {
    // Warm C-major chime, overlapping partials
    const notes = [
      { freq: 523.25, start: 0, duration: 0.85, peak: 0.16 },
      { freq: 659.25, start: 0.11, duration: 0.9, peak: 0.14 },
      { freq: 783.99, start: 0.22, duration: 1.05, peak: 0.13 },
      { freq: 1046.5, start: 0.36, duration: 1.2, peak: 0.11 },
    ];
    for (const note of notes) {
      tone(ctx, master, note.freq, t + note.start, note.duration, note.peak, "sine");
      tone(ctx, master, note.freq / 2, t + note.start, note.duration + 0.15, note.peak * 0.28, "triangle");
    }
  } else if (kind === "tick") {
    tone(ctx, master, 659.25, t, 0.35, 0.12, "sine");
    tone(ctx, master, 987.77, t + 0.08, 0.45, 0.1, "sine");
  } else {
    // Soft descending third — notice, not an alarm
    tone(ctx, master, 392.0, t, 0.55, 0.12, "sine");
    tone(ctx, master, 329.63, t + 0.16, 0.7, 0.11, "sine");
    tone(ctx, master, 246.94, t + 0.34, 0.85, 0.08, "triangle");
  }

  window.setTimeout(() => {
    try { master.disconnect(); } catch { /* already gone */ }
  }, 2200);
}

export function playNotify(kind: NotifyKind) {
  try {
    playPattern(kind);
  } catch {
    // Audio is best-effort
  }
}
