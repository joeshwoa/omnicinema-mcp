/**
 * Local synthesis fallback: renders a MusicArrangement to a real stereo WAV
 * with no API and no network.
 *
 * The arrangement is first composed into a score (see score.ts) — voice-led
 * chords, genre bass/drum patterns, a melodic motif, section dynamics — and
 * each part is voiced with a genre-appropriate instrument model:
 *   supersaw / string pads, FM electric piano (lo-fi, hip-hop), Karplus-Strong
 *   plucks and distorted power chords (rock), 808 bass, square / horn / bell
 *   leads, and a synthesized kit (kick, snare, clap, hats, crash, timpani).
 * The mix has per-part pan and gain, a Schroeder reverb send, sidechain pumping
 * for electronic/trap, vinyl texture for lo-fi, and is mastered to the
 * producer's loudness target (≈ -14 LUFS) with a -1 dBFS lookahead limiter.
 * Deterministic, so tests can assert exact durations and reproducibility.
 */
import type { MusicArrangement } from "../personas/types.js";
import { composeScore, type GenreStyle, type NoteEvent, type Part } from "./score.js";
import { midiToFreq } from "./theory.js";
import { writeWavStereoPcm16, type WavInfo } from "./wav.js";

interface Bus { L: Float32Array; R: Float32Array }

function bus(n: number): Bus {
  return { L: new Float32Array(n), R: new Float32Array(n) };
}

/** Equal-power pan: -1 (left) .. 1 (right). */
function panGains(p: number): [number, number] {
  const a = ((p + 1) / 2) * (Math.PI / 2);
  return [Math.cos(a), Math.sin(a)];
}

function addMono(dst: Bus, src: Float32Array, at: number, gain: number, pan: number): void {
  const [gl, gr] = panGains(pan);
  const n = Math.min(src.length, dst.L.length - at);
  for (let i = 0; i < n; i++) {
    const v = src[i]! * gain;
    dst.L[at + i]! += v * gl;
    dst.R[at + i]! += v * gr;
  }
}

let noiseState = 0x2468ace1;
function white(): number {
  noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
  return (noiseState / 4294967296) * 2 - 1;
}

function lp(buf: Float32Array, sr: number, cut: number | ((i: number) => number)): void {
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    const fc = typeof cut === "number" ? cut : cut(i);
    const a = 1 - Math.exp((-2 * Math.PI * Math.max(20, fc)) / sr);
    y += a * (buf[i]! - y);
    buf[i] = y;
  }
}

function hp(buf: Float32Array, sr: number, cut: number): void {
  let y = 0;
  let x1 = 0;
  const rc = 1 / (2 * Math.PI * cut);
  const a = rc / (rc + 1 / sr);
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!;
    y = a * (y + x - x1);
    x1 = x;
    buf[i] = y;
  }
}

/** ADSR-ish amplitude envelope. */
function adsr(i: number, sr: number, n: number, atk: number, dec: number, sus: number, rel: number): number {
  const t = i / sr;
  const held = n / sr;
  let v: number;
  if (t < atk) v = t / atk;
  else if (t < atk + dec) v = 1 - (1 - sus) * ((t - atk) / dec);
  else v = sus;
  if (t > held - rel) v *= Math.max(0, (held - t) / rel);
  return v;
}

// 8192-point sine table with linear interpolation (the FM voices call this
// several times per sample; Math.sin was the render bottleneck).
const TABLE_N = 8192;
const SINE = new Float32Array(TABLE_N + 1);
for (let i = 0; i <= TABLE_N; i++) SINE[i] = Math.sin((2 * Math.PI * i) / TABLE_N);
/** sin(2π·x) for any real x (x in cycles). */
function sinc(x: number): number {
  const f = (x - Math.floor(x)) * TABLE_N;
  const i = f | 0;
  const a = SINE[i]!;
  return a + (SINE[i + 1]! - a) * (f - i);
}

const saw = (ph: number) => 2 * (ph - Math.floor(ph + 0.5));
const square = (ph: number, w = 0.5) => ((ph - Math.floor(ph)) < w ? 1 : -1);
const tri = (ph: number) => 4 * Math.abs(ph - Math.floor(ph + 0.5)) - 1;

/** Karplus-Strong plucked string. */
function pluck(freq: number, n: number, sr: number, damp = 0.996, bright = 0.5): Float32Array {
  const out = new Float32Array(n);
  const len = Math.max(2, Math.round(sr / freq));
  const line = new Float32Array(len);
  for (let i = 0; i < len; i++) line[i] = white();
  // Soften the excitation for a warmer tone.
  for (let i = 1; i < len; i++) line[i] = line[i]! * bright + line[i - 1]! * (1 - bright);
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const cur = line[idx]!;
    const nxt = line[(idx + 1) % len]!;
    out[i] = cur;
    line[idx] = damp * 0.5 * (cur + nxt);
    idx = (idx + 1) % len;
  }
  return out;
}

function voice(e: NoteEvent, style: GenreStyle, sr: number, spb: number): Float32Array {
  const durS = Math.max(0.03, e.dur * spb);
  const f = midiToFreq(e.midi);
  switch (e.part) {
    case "pad": {
      if (style === "lofi" || style === "hip-hop") {
        // FM electric piano: decaying modulation index gives the tine "bark".
        const n = Math.floor((durS + 0.5) * sr);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          const idx = 1.8 * Math.exp(-t * 4) + 0.3;
          const wow = style === "lofi" ? 1 + 0.0025 * sinc(0.6 * t) : 1;
          const c = f * wow * t;
          const s = sinc(c + (idx / (2 * Math.PI)) * sinc(c)) + 0.15 * sinc(4 * f * t) * Math.exp(-t * 12);
          out[i] = s * Math.exp(-t * 1.1) * adsr(i, sr, n, 0.004, 0.1, 1, 0.25) * (1 + 0.12 * sinc(4.5 * t));
        }
        lp(out, sr, style === "lofi" ? 2600 : 4200);
        return out;
      }
      if (style === "rock") {
        const n = Math.floor((durS + 0.05) * sr);
        const out = pluck(f, n, sr, 0.998, 0.8);
        for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i]! * 5) * adsr(i, sr, n, 0.002, 0.05, 0.9, 0.03);
        lp(out, sr, 3200);
        return out;
      }
      // Supersaw / string ensemble.
      const atk = style === "orchestral" ? 0.35 : style === "ambient" ? 0.7 : 0.06;
      const rel = style === "orchestral" || style === "ambient" ? 0.8 : 0.35;
      const n = Math.floor((durS + rel) * sr);
      const out = new Float32Array(n);
      const det = [-0.0045, 0, 0.0047];
      const ph = [0.13, 0.41, 0.77]; // fixed start phases: deterministic, no phase-cancel click
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const vib = style === "orchestral" ? 1 + 0.003 * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, t / 0.6) : 1;
        let s = 0;
        for (let k = 0; k < det.length; k++) {
          ph[k] = ph[k]! + (f * (1 + det[k]!) * vib) / sr;
          s += saw(ph[k]!);
        }
        out[i] = (s / det.length) * adsr(i, sr, n, atk, 0.3, 0.85, rel);
      }
      lp(out, sr, style === "orchestral" ? 1700 : style === "ambient" ? 1100 : 2400);
      lp(out, sr, style === "orchestral" ? 2600 : 3200);
      return out;
    }
    case "bass": {
      const n = Math.floor((durS + 0.06) * sr);
      const out = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        if (style === "trap" || style === "hip-hop") {
          const fr = f * (1 + 0.6 * Math.exp(-t * 60));
          ph += fr / sr;
          out[i] = Math.tanh(2.2 * Math.sin(2 * Math.PI * ph)) * Math.exp(-t * (style === "trap" ? 0.9 : 2.2)) * adsr(i, sr, n, 0.002, 0.05, 1, 0.05);
        } else if (style === "rock" || style === "electronic" || style === "orchestral") {
          ph += f / sr;
          const env = style === "orchestral" ? adsr(i, sr, n, 0.12, 0.2, 0.8, 0.2) : adsr(i, sr, n, 0.003, 0.15, 0.7, 0.04);
          out[i] = (0.7 * saw(ph) + 0.5 * Math.sin(2 * Math.PI * ph * 0.5)) * env;
        } else {
          ph += f / sr;
          out[i] = (0.8 * Math.sin(2 * Math.PI * ph) + 0.25 * tri(ph)) * Math.exp(-t * 2.5) * adsr(i, sr, n, 0.004, 0.05, 1, 0.05);
        }
      }
      if (style === "electronic") lp(out, sr, (i) => 250 + 1400 * Math.exp(-i / (0.08 * sr)));
      else if (style === "rock" || style === "orchestral") lp(out, sr, style === "rock" ? 900 : 500);
      return out;
    }
    case "lead": {
      const n = Math.floor((durS + 0.15) * sr);
      const out = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const vibAmt = style === "electronic" ? 0 : 0.004 * Math.min(1, Math.max(0, (t - 0.18) / 0.3));
        ph += (f * (1 + vibAmt * Math.sin(2 * Math.PI * 5.5 * t))) / sr;
        let s: number;
        switch (style) {
          case "electronic": s = 0.6 * square(ph, 0.35) + 0.4 * saw(ph * 1.003); break;
          case "orchestral": s = saw(ph); break; // brass-ish after the filter
          case "rock": s = Math.tanh(4 * (saw(ph) + saw(ph * 1.006))); break;
          case "trap": s = Math.sin(2 * Math.PI * ph + 2.2 * Math.exp(-t * 6) * Math.sin(2 * Math.PI * 3.5 * ph)) * Math.exp(-t * 2.5); break;
          default: s = 0.75 * Math.sin(2 * Math.PI * ph) + 0.25 * tri(ph * 2);
        }
        out[i] = s * adsr(i, sr, n, style === "orchestral" ? 0.07 : 0.01, 0.12, 0.8, 0.12);
      }
      lp(out, sr, style === "orchestral" ? 1500 : style === "electronic" ? 3800 : style === "rock" ? 3000 : 5000);
      return out;
    }
    case "arp": {
      const n = Math.floor((durS + 0.25) * sr);
      if (style === "lofi" || style === "hip-hop") {
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          out[i] = sinc(f * t + (1.2 / (2 * Math.PI)) * Math.exp(-t * 8) * sinc(2 * f * t)) * Math.exp(-t * 5);
        }
        return out;
      }
      const out = pluck(f, n, sr, style === "orchestral" ? 0.985 : 0.994, style === "electronic" ? 0.3 : 0.6);
      lp(out, sr, style === "electronic" ? 4200 : 2500);
      return out;
    }
    case "kick": {
      const n = Math.floor((style === "trap" ? 0.5 : 0.3) * sr);
      const out = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        ph += (48 + 110 * Math.exp(-t * 32)) / sr;
        out[i] = Math.tanh(1.8 * Math.sin(2 * Math.PI * ph)) * Math.exp(-t * (style === "trap" ? 7 : 11)) + (i < sr * 0.004 ? white() * 0.4 * (1 - i / (sr * 0.004)) : 0);
      }
      return out;
    }
    case "snare": {
      const n = Math.floor(0.25 * sr);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        out[i] = white() * Math.exp(-t * 18) * 0.8 + Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 28) * 0.6;
      }
      hp(out, sr, 150);
      if (style === "lofi") lp(out, sr, 4000);
      return out;
    }
    case "clap": {
      const n = Math.floor(0.3 * sr);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const bursts = [0, 0.011, 0.022].reduce((s, o) => s + (t >= o ? Math.exp(-(t - o) * 90) : 0), 0);
        out[i] = white() * (bursts * 0.5 + Math.exp(-t * 14) * 0.5);
      }
      hp(out, sr, 700);
      lp(out, sr, 6000);
      return out;
    }
    case "hat":
    case "openhat": {
      const n = Math.floor((e.part === "hat" ? 0.06 : 0.35) * sr);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = white() * Math.exp(-(i / sr) * (e.part === "hat" ? 70 : 9));
      hp(out, sr, 7000);
      hp(out, sr, 7000);
      return out;
    }
    case "crash": {
      const n = Math.floor(2 * sr);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = white() * Math.exp(-(i / sr) * 2.2);
      hp(out, sr, 4000);
      return out;
    }
    case "timpani": {
      const n = Math.floor(1.6 * sr);
      const out = new Float32Array(n);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        ph += (f * (1 + 0.08 * Math.exp(-t * 20))) / sr;
        out[i] = (Math.sin(2 * Math.PI * ph) + 0.3 * Math.sin(2 * Math.PI * ph * 1.5)) * Math.exp(-t * 2.4) + white() * 0.15 * Math.exp(-t * 30);
      }
      lp(out, sr, 900);
      return out;
    }
  }
}

interface PartMix { gain: number; pan: number; send: number; duck: boolean }

function mixFor(part: Part, style: GenreStyle): PartMix {
  const table: Record<Part, PartMix> = {
    pad: { gain: style === "rock" ? 0.22 : style === "orchestral" ? 0.3 : 0.2, pan: 0, send: 0.35, duck: true },
    bass: { gain: style === "trap" || style === "hip-hop" ? 0.55 : 0.42, pan: 0, send: 0, duck: true },
    lead: { gain: style === "orchestral" ? 0.3 : 0.26, pan: 0.12, send: 0.3, duck: false },
    arp: { gain: 0.16, pan: -0.35, send: 0.35, duck: true },
    kick: { gain: 0.85, pan: 0, send: 0, duck: false },
    snare: { gain: 0.45, pan: 0.02, send: 0.22, duck: false },
    clap: { gain: 0.42, pan: 0, send: 0.25, duck: false },
    hat: { gain: 0.16, pan: 0.28, send: 0.02, duck: false },
    openhat: { gain: 0.14, pan: 0.32, send: 0.05, duck: false },
    crash: { gain: 0.18, pan: -0.2, send: 0.1, duck: false },
    timpani: { gain: 0.6, pan: -0.1, send: 0.3, duck: false },
  };
  return table[part];
}

/** Freeverb-style reverb (4 combs + 2 allpasses per channel). */
function reverb(input: Bus, sr: number, room: number, damp: number): Bus {
  const scale = sr / 44100;
  const combs = [1116, 1188, 1277, 1356].map((d) => Math.round(d * scale));
  const aps = [556, 441].map((d) => Math.round(d * scale));
  const out = bus(input.L.length);
  for (const [src, dst, spread] of [[input.L, out.L, 0], [input.R, out.R, 23]] as const) {
    for (const d0 of combs) {
      const d = d0 + spread;
      const buf = new Float32Array(d);
      let idx = 0;
      let store = 0;
      for (let i = 0; i < src.length; i++) {
        const y = buf[idx]!;
        store = y * (1 - damp) + store * damp;
        buf[idx] = src[i]! * 0.015 + store * room;
        dst[i]! += y;
        idx = (idx + 1) % d;
      }
    }
    for (const d0 of aps) {
      const d = d0 + spread;
      const buf = new Float32Array(d);
      let idx = 0;
      for (let i = 0; i < dst.length; i++) {
        const b = buf[idx]!;
        const x = dst[i]!;
        buf[idx] = x + b * 0.5;
        dst[i] = b - x;
        idx = (idx + 1) % d;
      }
    }
  }
  return out;
}

/** Lookahead peak limiter to `ceiling` (linear). */
function limit(b: Bus, sr: number, ceiling: number): void {
  const look = Math.max(1, Math.floor(0.004 * sr));
  const rel = Math.exp(-1 / (0.08 * sr));
  const n = b.L.length;
  const peak = new Float32Array(n);
  for (let i = 0; i < n; i++) peak[i] = Math.max(Math.abs(b.L[i]!), Math.abs(b.R[i]!));
  // Sliding-window max over the lookahead (monotonic deque).
  const winMax = new Float32Array(n);
  const dq: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    while (dq.length && peak[dq[dq.length - 1]!]! <= peak[i]!) dq.pop();
    dq.push(i);
    while (dq[0]! > i + look) dq.shift();
    winMax[i] = peak[dq[0]!]!;
  }
  let g = 1;
  for (let i = 0; i < n; i++) {
    const target = winMax[i]! > ceiling ? ceiling / winMax[i]! : 1;
    g = target < g ? target : target + (g - target) * rel;
    b.L[i]! *= g;
    b.R[i]! *= g;
  }
}

/** Integrated-loudness proxy: gated RMS (dBFS) over 400 ms blocks. */
export function gatedRmsDb(b: Bus, sr: number): number {
  const block = Math.floor(0.4 * sr);
  const powers: number[] = [];
  for (let s = 0; s + block <= b.L.length; s += Math.floor(block / 4)) {
    let acc = 0;
    for (let i = s; i < s + block; i++) acc += (b.L[i]! ** 2 + b.R[i]! ** 2) / 2;
    powers.push(acc / block);
  }
  const abs = powers.filter((p) => 10 * Math.log10(p + 1e-12) > -70);
  if (!abs.length) return -120;
  const mean = abs.reduce((a, c) => a + c, 0) / abs.length;
  const rel = abs.filter((p) => 10 * Math.log10(p + 1e-12) > 10 * Math.log10(mean) - 10);
  const m2 = rel.reduce((a, c) => a + c, 0) / Math.max(1, rel.length);
  return 10 * Math.log10(m2 + 1e-12);
}

export function renderArrangementBuffers(arrangement: MusicArrangement, sampleRate = 44100): { L: Float32Array; R: Float32Array; style: GenreStyle } {
  noiseState = 0x2468ace1; // deterministic noise per render
  const sr = sampleRate;
  const spb = 60 / arrangement.bpm;
  const score = composeScore(arrangement);
  const totalSamples = Math.max(sr, Math.round(score.totalBeats * spb * sr));
  const dry = bus(totalSamples);
  const duckBus = bus(totalSamples);
  const send = bus(totalSamples);
  const style = score.style;

  // Deterministic humanization + wide pads: alternate pad notes L/R.
  let padAlt = 0;
  for (const e of score.events) {
    const at = Math.round(e.start * spb * sr);
    if (at >= totalSamples) continue;
    const m = mixFor(e.part, style);
    const buf = voice(e, style, sr, spb);
    let pan = m.pan;
    if (e.part === "pad") pan = (padAlt++ % 3 - 1) * 0.45;
    const target = m.duck && (style === "electronic" || style === "trap") ? duckBus : dry;
    addMono(target, buf, at, m.gain * e.vel, pan);
    if (m.send > 0) addMono(send, buf, at, m.gain * e.vel * m.send, pan);
  }

  // Sidechain pump from the kick pattern (electronic / trap).
  if (style === "electronic" || style === "trap") {
    const kicks = score.events.filter((e) => e.part === "kick").map((e) => Math.round(e.start * spb * sr)).sort((a, b) => a - b);
    let k = 0;
    for (let i = 0; i < totalSamples; i++) {
      while (k + 1 < kicks.length && kicks[k + 1]! <= i) k++;
      const since = kicks.length && kicks[k]! <= i ? (i - kicks[k]!) / sr : 9;
      const g = 1 - 0.55 * Math.exp(-since / 0.09);
      dry.L[i]! += duckBus.L[i]! * g;
      dry.R[i]! += duckBus.R[i]! * g;
    }
  }

  const big = style === "orchestral" || style === "ambient";
  const wet = reverb(send, sr, big ? 0.86 : 0.78, big ? 0.25 : 0.35);
  for (let i = 0; i < totalSamples; i++) {
    dry.L[i]! += wet.L[i]! * (big ? 0.9 : 0.6);
    dry.R[i]! += wet.R[i]! * (big ? 0.9 : 0.6);
  }

  if (style === "lofi") {
    // Vinyl crackle + gentle tape saturation and a softened top end.
    let s = 0x5eed;
    for (let i = 0; i < totalSamples; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      const crack = (s & 0xffff) < 6 ? ((s >>> 16) / 65536 - 0.5) * 0.25 : 0;
      dry.L[i] = Math.tanh((dry.L[i]! + crack) * 1.3) / 1.3;
      dry.R[i] = Math.tanh((dry.R[i]! + crack * 0.8) * 1.3) / 1.3;
    }
    lp(dry.L, sr, 7000);
    lp(dry.R, sr, 7000);
  }

  // Clean up sub rumble and DC.
  hp(dry.L, sr, 28);
  hp(dry.R, sr, 28);

  // End: fade the last beat and a half so the file never ends on a click.
  const fade = Math.min(totalSamples, Math.round(1.5 * spb * sr));
  for (let i = 0; i < fade; i++) {
    const g = 1 - i / fade;
    dry.L[totalSamples - fade + i]! *= g;
    dry.R[totalSamples - fade + i]! *= g;
  }

  // Master: loudness toward the target, then a -1 dBFS lookahead limiter.
  const target = arrangement.targetLufs ?? -14;
  const current = gatedRmsDb(dry, sr);
  // Gated RMS of dense music reads ~1 dB below LUFS; compensate slightly.
  const gain = Math.pow(10, (target - 1 - current) / 20);
  for (let i = 0; i < totalSamples; i++) {
    dry.L[i]! *= gain;
    dry.R[i]! *= gain;
  }
  limit(dry, sr, Math.pow(10, -1.2 / 20));
  return { L: dry.L, R: dry.R, style };
}

export function renderArrangementToWav(
  arrangement: MusicArrangement,
  dest: string,
  sampleRate = 44100,
): WavInfo {
  const { L, R } = renderArrangementBuffers(arrangement, sampleRate);
  return writeWavStereoPcm16(dest, L, R, sampleRate);
}
