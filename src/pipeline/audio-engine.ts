/**
 * Voiceover & Audio Engine (incl. full music/genre synthesis).
 *
 * Wrappers for spoken narration, cinematic soundtracks (any genre), and SFX.
 * Flow mirrors the image engine: personas consult → budget gate → generate via
 * official APIs (BYO key) OR a real local fallback. Every asset reports a precise
 * millisecond duration so the master sequencer can lock audio to video.
 *
 * Music: the Music Producer persona plans BPM/key/structure/instrumentation; the
 * engine either sends that to a MusicGen/AudioCraft API (HF/Replicate) or renders
 * it locally to WAV + MIDI via deterministic synthesis. Free-tier consumption is
 * tracked in data/usage-limits.json.
 */
import path from "node:path";
import { ensureDirs, paths } from "../config.js";
import { log } from "../logger.js";
import { run, which } from "../exec.js";
import { consult } from "../personas/consultation.js";
import { fitArrangementToDuration, planMusic } from "../personas/music-producer.js";
import type { ConsultationInput, MusicArrangement, PromptBrief } from "../personas/types.js";
import { breakdownLines, consume } from "../limits/limit-manager.js";
import { hfTts, MUSIC_PROVIDERS, freesound } from "../providers/audio.js";
import { renderArrangementToWav } from "../audio/synth.js";
import { writeArrangementMidi } from "../audio/midi.js";
import { readWavInfo, writeWavPcm16, type WavInfo } from "../audio/wav.js";
import { speakToWav } from "../audio/tts.js";
import { renderSfx } from "../audio/sfx.js";
import type { BudgetHalt, EngineResult, GeneratedAsset } from "./asset-results.js";

export interface AudioEngineInput extends ConsultationInput {
  /** Explicit narration script (defaults to `subject`). */
  script?: string;
  generative?: boolean;
  approveOverBudget?: boolean;
  outDir?: string;
  /** Soundtrack only: re-flow the arrangement to last about this long (ms). */
  targetDurationMs?: number;
}

// ── Voiceover ────────────────────────────────────────────────────────────────

export async function generateVoiceover(input: AudioEngineInput): Promise<EngineResult> {
  ensureDirs();
  const brief = consult({ ...input, assetKind: "voiceover" });
  const outDir = input.outDir || paths.assets;
  const base = `${slug(input.subject)}_voiceover`;
  const script = input.script?.trim() || input.subject.trim();
  const wpm = numParam(brief, "wpm", 150);
  const pauseMs = numParam(brief, "pauseMs", 250);
  const estMs = estimateSpeechMs(script, wpm, pauseMs);
  const warnings: string[] = [];

  if (input.generative && hfTts.configured()) {
    const gate = consume(hfTts.slug, 1, Boolean(input.approveOverBudget));
    if (!gate.proceeded) return halt(gate, brief);
    const dest = path.join(outDir, `${base}.wav`);
    const res = await hfTts.generate(script, dest);
    if (res.ok) {
      const durationMs = (await measureDurationMs(dest)) ?? estMs;
      return audioAsset({ kind: "voiceover", dest, outDir, format: "wav", provider: res.provider, source: "generative", license: res.license, attribution: res.attribution, brief, durationMs, warnings });
    }
    warnings.push(`${hfTts.slug}: ${res.note ?? "failed"}`);
  } else if (input.generative) {
    warnings.push("Generative TTS requested but HUGGINGFACE_API_TOKEN + HF_TTS_MODEL are not configured; using offline system TTS.");
  }

  const dest = path.join(outDir, `${base}.wav`);
  // Offline speech via a system TTS engine (say / pico2wave / flite / espeak-ng).
  const deep = /dramatic|trailer|cinematic|epic|deep/i.test(input.style ?? "");
  const spoken = await speakToWav(script, dest, { wpm, deep });
  if (spoken.ok) {
    const durationMs = (await measureDurationMs(dest)) ?? estMs;
    warnings.push(`Spoken offline by the system TTS engine "${spoken.engine}" — intelligible but synthetic-sounding. For a natural voice set HUGGINGFACE_API_TOKEN + HF_TTS_MODEL and use generative:true.`);
    return audioAsset({ kind: "voiceover", dest, outDir, format: "wav", provider: `system-tts:${spoken.engine}`, source: "offline", license: "Generated locally (engine license applies)", attribution: `Offline TTS (${spoken.engine})`, brief, durationMs, warnings, meta: { script, engine: spoken.engine, loudnessNormalized: spoken.normalized, targetLufs: -16 } });
  }

  // Last resort: a paced tone bed so timing still works — NOT speech.
  const info = writeTonePlaceholder(estMs, dest);
  warnings.push(`NOT SPEECH: no offline TTS engine was found (${spoken.note ?? "unknown"}), so this is a timing placeholder tone of the estimated narration length. Install espeak-ng (or use macOS 'say'), or configure HF_TTS_MODEL + generative:true.`);
  return audioAsset({ kind: "voiceover", dest, outDir, format: "wav", provider: "offline-tone", source: "offline", license: "n/a (placeholder)", attribution: "offline narration placeholder (tone, not speech)", brief, durationMs: info.durationMs, warnings, meta: { script, estimatedFrom: `${wpm}wpm` } });
}

// ── Soundtrack / music ───────────────────────────────────────────────────────

export async function generateSoundtrack(input: AudioEngineInput): Promise<EngineResult> {
  ensureDirs();
  const brief = consult({ ...input, assetKind: "soundtrack" });
  const outDir = input.outDir || paths.assets;
  const base = `${slug(input.subject)}_${slug(String(brief.params.arrangement && (brief.params.arrangement as MusicArrangement).genre) || "score")}`;
  const planned = (brief.params.arrangement as MusicArrangement | undefined) ?? planMusic({ ...input, assetKind: "soundtrack" });
  const arrangement = input.targetDurationMs && input.targetDurationMs > 0 ? fitArrangementToDuration(planned, input.targetDurationMs) : planned;
  const exactMs = Math.round((totalBars(arrangement) * 4 * 60_000) / arrangement.bpm);
  const warnings: string[] = [];

  // Always emit an editable MIDI of the arrangement.
  const midiPath = path.join(outDir, `${base}.mid`);
  writeArrangementMidi(arrangement, midiPath);

  if (input.generative) {
    const provider = MUSIC_PROVIDERS.find((p) => p.configured());
    if (provider) {
      const gate = consume(provider.slug, 1, Boolean(input.approveOverBudget));
      if (!gate.proceeded) return halt(gate, brief);
      const dest = path.join(outDir, `${base}.wav`);
      const res = await provider.generate(brief.positivePrompt, dest);
      if (res.ok) {
        const durationMs = (await measureDurationMs(dest)) ?? exactMs;
        return audioAsset({ kind: "soundtrack", dest, outDir, format: "wav", provider: res.provider, source: "generative", license: res.license, attribution: res.attribution, brief, durationMs, warnings, meta: { arrangement, midiPath } });
      }
      warnings.push(`${provider.slug}: ${res.note ?? "failed"}`);
    } else {
      warnings.push("Generative music requested but no music provider configured; using local synthesis.");
    }
  }

  // Local deterministic synthesis fallback (WAV + MIDI).
  const dest = path.join(outDir, `${base}.wav`);
  const info = renderArrangementToWav(arrangement, dest);
  log.info(`Synthesized ${arrangement.genre} ${arrangement.bpm}BPM ${info.durationMs}ms -> ${dest}`);
  return audioAsset({ kind: "soundtrack", dest, outDir, format: "wav", provider: "local-synth", source: "offline", license: "MIT (generated by this tool)", attribution: `Local synthesis (${arrangement.genre}, ${arrangement.bpm} BPM, ${arrangement.keyRoot} ${arrangement.scale})`, brief, durationMs: info.durationMs, warnings, meta: { arrangement, midiPath } });
}

// ── SFX ──────────────────────────────────────────────────────────────────────

export async function generateSfx(input: AudioEngineInput): Promise<EngineResult> {
  ensureDirs();
  const brief = consult({ ...input, assetKind: "sfx" });
  const outDir = input.outDir || paths.assets;
  const base = `${slug(input.subject)}_sfx`;
  const warnings: string[] = [];

  if (input.generative && freesound.configured()) {
    const gate = consume(freesound.slug, 1, Boolean(input.approveOverBudget));
    if (!gate.proceeded) return halt(gate, brief);
    const dest = path.join(outDir, `${base}.mp3`);
    const res = await freesound.fetch(input.subject, dest);
    if (res.ok) {
      const durationMs = (await measureDurationMs(dest)) ?? 1000;
      return audioAsset({ kind: "sfx", dest, outDir, format: "mp3", provider: res.provider, source: "generative", license: res.license, attribution: res.attribution, brief, durationMs, warnings });
    }
    warnings.push(`freesound: ${res.note ?? "failed"}`);
  } else if (input.generative) {
    warnings.push("Generative SFX requested but FREESOUND_API_KEY is not set; using offline synthesis.");
  }

  const dest = path.join(outDir, `${base}.wav`);
  const { info, recipe } = renderSfx(input.subject, dest);
  return audioAsset({ kind: "sfx", dest, outDir, format: "wav", provider: "offline-synth", source: "offline", license: "MIT (generated by this tool)", attribution: `offline procedural sfx (${recipe})`, brief, durationMs: info.durationMs, warnings, meta: { recipe } });
}

// ── shared ───────────────────────────────────────────────────────────────────

export function estimateSpeechMs(text: string, wpm: number, pauseMs: number): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  const sentences = (text.match(/[.!?]+/g)?.length ?? 0) + 1;
  const speakMs = (words / Math.max(60, wpm)) * 60_000;
  return Math.max(800, Math.round(speakMs + sentences * pauseMs));
}

/** Measure a media file's duration: WAV header, else ffprobe, else null. */
export async function measureDurationMs(filePath: string): Promise<number | null> {
  if (filePath.toLowerCase().endsWith(".wav")) {
    return readWavInfo(filePath)?.durationMs ?? null;
  }
  const ffprobe = await which("ffprobe");
  if (ffprobe) {
    const res = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath], paths.repoRoot, 30_000);
    const seconds = Number.parseFloat(res.stdout.trim());
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  }
  return null;
}

function totalBars(a: MusicArrangement): number {
  return a.structure.reduce((n, s) => n + s.bars, 0);
}

function writeTonePlaceholder(durationMs: number, dest: string, sampleRate = 24000): WavInfo {
  const n = Math.round((durationMs / 1000) * sampleRate);
  const buf = new Float32Array(n);
  const durS = durationMs / 1000;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const syllable = 0.5 * (1 + Math.sin(2 * Math.PI * 4 * t)); // ~4 Hz cadence
    const fade = Math.min(1, t * 4) * Math.min(1, (durS - t) * 4);
    buf[i] = Math.sin(2 * Math.PI * 220 * t) * 0.08 * syllable * fade;
  }
  return writeWavPcm16(dest, buf, sampleRate);
}


function halt(gate: { decision: import("../limits/limit-manager.js").BudgetDecision }, brief: PromptBrief): BudgetHalt {
  log.warn(`Audio budget gate halted: ${gate.decision.message}`);
  return { halted: true, reason: gate.decision.message, decision: gate.decision, breakdown: breakdownLines(gate.decision), brief };
}

function audioAsset(a: {
  kind: string; dest: string; outDir: string; format: string; provider: string;
  source: "generative" | "offline"; license: string; attribution: string; brief: PromptBrief;
  durationMs: number; warnings: string[]; meta?: Record<string, unknown>;
}): GeneratedAsset {
  return {
    kind: a.kind, path: a.dest, relPath: path.relative(a.outDir, a.dest), format: a.format,
    provider: a.provider, source: a.source, license: a.license, attribution: a.attribution,
    brief: a.brief, durationMs: a.durationMs, warnings: a.warnings, meta: a.meta,
  };
}

function numParam(brief: PromptBrief, key: string, dflt: number): number {
  const v = brief.params[key];
  return typeof v === "number" ? v : dflt;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "audio";
}
