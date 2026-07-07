/**
 * Local MIDI-style synthesis fallback.
 *
 * Renders a MusicArrangement into a real, audible WAV with no API and no network:
 * a sustained chord pad, a bass line, a simple drum kit, and (for some genres) an
 * arpeggio. Deterministic, so tests can assert exact durations and reproducibility.
 * This is the "stable local fallback" for music generation.
 */
import type { MusicArrangement } from "../personas/types.js";
import { degreeSemitone, midiToFreq, tonicMidi, triadMidi } from "./theory.js";
import { writeWavPcm16, type WavInfo } from "./wav.js";

const BEATS_PER_BAR = 4;

type Wave = "sine" | "saw" | "triangle";

function osc(wave: Wave, phase: number): number {
  const p = phase - Math.floor(phase); // 0..1
  switch (wave) {
    case "saw": return 2 * p - 1;
    case "triangle": return 4 * Math.abs(p - 0.5) - 1;
    default: return Math.sin(2 * Math.PI * p);
  }
}

/** Add a pitched tone with an ADSR-ish envelope into the mix buffer. */
function addTone(
  mix: Float32Array, sr: number, freq: number, start: number, durSamples: number,
  amp: number, wave: Wave, attack = 0.01, release = 0.15,
): void {
  const atk = Math.max(1, Math.floor(attack * sr));
  const rel = Math.max(1, Math.floor(release * sr));
  for (let i = 0; i < durSamples; i++) {
    const idx = start + i;
    if (idx >= mix.length) break;
    let env = 1;
    if (i < atk) env = i / atk;
    else if (i > durSamples - rel) env = Math.max(0, (durSamples - i) / rel);
    mix[idx]! += osc(wave, (freq * i) / sr) * amp * env;
  }
}

/** Percussive kick: pitch sweep sine with fast decay. */
function addKick(mix: Float32Array, sr: number, start: number, amp = 0.9): void {
  const dur = Math.floor(0.18 * sr);
  for (let i = 0; i < dur; i++) {
    const idx = start + i;
    if (idx >= mix.length) break;
    const t = i / sr;
    const freq = 120 * Math.exp(-t * 30) + 40;
    const env = Math.exp(-t * 18);
    mix[idx]! += Math.sin(2 * Math.PI * freq * t) * amp * env;
  }
}

/** Snare/hat via shaped white noise. */
function addNoise(mix: Float32Array, sr: number, start: number, durS: number, amp: number, decay: number, seed: number): void {
  const dur = Math.floor(durS * sr);
  let s = seed >>> 0;
  for (let i = 0; i < dur; i++) {
    const idx = start + i;
    if (idx >= mix.length) break;
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const noise = (s / 4294967296) * 2 - 1;
    mix[idx]! += noise * amp * Math.exp((-i / sr) * decay);
  }
}

export function renderArrangementToWav(
  arrangement: MusicArrangement,
  dest: string,
  sampleRate = 44100,
): WavInfo {
  const { bpm, keyRoot, scale, progression, structure, genre, swing } = arrangement;
  const secondsPerBeat = 60 / bpm;
  const totalBars = structure.reduce((n, s) => n + s.bars, 0);
  const totalSamples = Math.max(sampleRate, Math.round(totalBars * BEATS_PER_BAR * secondsPerBeat * sampleRate));
  const mix = new Float32Array(totalSamples);

  const tonic = tonicMidi(keyRoot, 4);
  const beatSamples = Math.round(secondsPerBeat * sampleRate);
  const hasDrums = !genre.includes("orchestral");
  const hasArp = genre === "electronic" || genre === "lo-fi";

  for (let bar = 0; bar < totalBars; bar++) {
    const degree = progression[bar % progression.length]!;
    const chord = triadMidi(tonic, scale, degree);
    const bassMidi = tonic + degreeSemitone(scale, degree) - 24;
    const barStart = Math.round(bar * BEATS_PER_BAR * secondsPerBeat * sampleRate);

    // Chord pad across the whole bar.
    for (const note of chord) {
      addTone(mix, sampleRate, midiToFreq(note), barStart, BEATS_PER_BAR * beatSamples, 0.14, "triangle", 0.08, 0.4);
    }

    for (let beat = 0; beat < BEATS_PER_BAR; beat++) {
      const beatStart = barStart + beat * beatSamples;
      // Bass on beats 1 and 3.
      if (beat % 2 === 0) {
        addTone(mix, sampleRate, midiToFreq(bassMidi), beatStart, Math.floor(beatSamples * 0.9), 0.5, "sine", 0.005, 0.1);
      }
      if (hasDrums) {
        if (beat % 2 === 0) addKick(mix, sampleRate, beatStart, 0.8);
        else addNoise(mix, sampleRate, beatStart, 0.2, 0.35, 40, 0x9e37 + bar * 7 + beat); // snare
        // Hats on eighths, with swing on the off-beat.
        addNoise(mix, sampleRate, beatStart, 0.05, 0.12, 120, 0x1234 + beat);
        const swingOffset = Math.floor(swing * beatSamples);
        addNoise(mix, sampleRate, beatStart + Math.floor(beatSamples / 2) + swingOffset, 0.05, 0.1, 130, 0x5678 + beat);
      }
      if (hasArp) {
        const arpNote = chord[beat % chord.length]! + 12;
        addTone(mix, sampleRate, midiToFreq(arpNote), beatStart, Math.floor(beatSamples * 0.45), 0.16, "saw", 0.005, 0.08);
      }
    }
  }

  // Peak-normalize to leave a little headroom.
  let peak = 0;
  for (let i = 0; i < mix.length; i++) peak = Math.max(peak, Math.abs(mix[i]!));
  if (peak > 0) {
    const gain = 0.89 / peak;
    for (let i = 0; i < mix.length; i++) mix[i]! *= gain;
  }

  return writeWavPcm16(dest, mix, sampleRate);
}
