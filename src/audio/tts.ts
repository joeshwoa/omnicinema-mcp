/**
 * Offline text-to-speech via whatever system engine exists — no network, no key.
 *
 * Preference order (most natural first): macOS `say`, `pico2wave` (SVOX Pico),
 * ffmpeg's built-in `flite` filter (ffmpeg builds with --enable-libflite),
 * `espeak-ng`, `espeak`. These are intelligible but clearly synthetic voices;
 * for a natural voice use a TTS API (HF_TTS_MODEL + generative:true).
 *
 * Output is normalized with ffmpeg when available: 80 Hz high-pass and EBU R128
 * loudness to -16 LUFS / -1.5 dBTP (the Voice Director's spec), 48 kHz mono.
 * Set CINEMA_TTS=off to disable, or CINEMA_TTS=<engine> to force one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, which } from "../exec.js";

export type TtsEngine = "say" | "pico2wave" | "flite" | "espeak-ng" | "espeak";

export interface TtsInfo { engine: TtsEngine; bin: string }

let cached: Promise<TtsInfo | null> | null = null;

async function ffmpegHasFlite(): Promise<boolean> {
  const res = await run("ffmpeg", ["-hide_banner", "-filters"], process.cwd(), 15_000);
  return res.code === 0 && /\bflite\b/.test(res.stdout);
}

export function detectTts(): Promise<TtsInfo | null> {
  const pref = (process.env.CINEMA_TTS ?? "").trim().toLowerCase();
  if (pref === "off" || pref === "0" || pref === "none") return Promise.resolve(null);
  cached ??= (async () => {
    const order: TtsEngine[] = ["say", "pico2wave", "flite", "espeak-ng", "espeak"];
    const candidates = pref && order.includes(pref as TtsEngine) ? [pref as TtsEngine] : order;
    for (const engine of candidates) {
      if (engine === "say" && process.platform !== "darwin") continue;
      if (engine === "flite") {
        const ff = await which("ffmpeg");
        if (ff && (await ffmpegHasFlite())) return { engine, bin: ff };
        continue;
      }
      const bin = await which(engine);
      if (bin) return { engine, bin };
    }
    return null;
  })();
  return cached;
}

export function resetTtsCache(): void {
  cached = null;
}

export interface SpeakOptions {
  /** Words per minute (Voice Director pacing). */
  wpm?: number;
  /** Lower voice for dramatic/trailer reads. */
  deep?: boolean;
}

export interface SpeakResult { ok: boolean; engine?: TtsEngine; note?: string; normalized?: boolean }

/** Speak `text` into a WAV at `dest`. Never throws. */
export async function speakToWav(text: string, dest: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  const tts = await detectTts();
  if (!tts) return { ok: false, note: "no offline TTS engine found (install espeak-ng, or use ffmpeg built with libflite)" };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-tts-"));
  const raw = path.join(tmpDir, "raw.wav");
  const textFile = path.join(tmpDir, "text.txt");
  fs.writeFileSync(textFile, text, "utf8");
  const wpm = Math.round(Math.max(90, Math.min(220, opts.wpm ?? 150)));
  try {
    let res;
    switch (tts.engine) {
      case "say":
        res = await run(tts.bin, ["-r", String(wpm), "-o", raw, "--file-format=WAVE", "--data-format=LEI16@22050", "-f", textFile], tmpDir, 120_000);
        break;
      case "pico2wave":
        res = await run(tts.bin, ["-l", "en-US", "-w", raw, text], tmpDir, 120_000);
        break;
      case "flite":
        res = await run(tts.bin, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `flite=textfile='${textFile.replace(/'/g, "\\'")}':voice=slt`, raw], tmpDir, 120_000);
        break;
      default:
        res = await run(tts.bin, ["-v", "en-us", "-s", String(wpm), "-p", opts.deep ? "32" : "45", "-g", "4", "-w", raw, "-f", textFile], tmpDir, 120_000);
    }
    if (res.code !== 0 || !fs.existsSync(raw) || fs.statSync(raw).size < 1000) {
      return { ok: false, engine: tts.engine, note: `${tts.engine} failed: ${(res.stderr || res.stdout).slice(0, 200)}` };
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Pace flite (fixed rate) toward the requested WPM with a pitch-preserving tempo change.
    const tempo = tts.engine === "flite" || tts.engine === "pico2wave" ? Math.max(0.75, Math.min(1.3, wpm / 165)) : 1;
    const ff = await which("ffmpeg");
    if (ff) {
      const af = [`highpass=f=80`, ...(Math.abs(tempo - 1) > 0.02 ? [`atempo=${tempo.toFixed(3)}`] : []), `loudnorm=I=-16:TP=-1.5:LRA=11`];
      const n = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-af", af.join(","), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", dest], tmpDir, 120_000);
      if (n.code === 0 && fs.existsSync(dest)) return { ok: true, engine: tts.engine, normalized: true };
    }
    fs.copyFileSync(raw, dest);
    return { ok: true, engine: tts.engine, normalized: false };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
