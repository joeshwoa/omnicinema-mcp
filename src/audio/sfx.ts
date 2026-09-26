/**
 * Procedural sound-effect synthesis (offline fallback for generate_sfx).
 *
 * Recipes are matched from the request text: whoosh, rain, thunder, wind,
 * impact, riser, UI click/ding/beep, fire, footsteps, ocean, heartbeat. Each is
 * built from seeded noise, filters and envelopes, then peak-normalized to
 * -1 dBFS with a short fade so there are no clicks. Deterministic per request.
 */
import { writeWavPcm16, type WavInfo } from "./wav.js";

export type SfxRecipe =
  | "whoosh" | "rain" | "thunder" | "wind" | "impact" | "riser" | "click" | "ding" | "beep"
  | "fire" | "footsteps" | "ocean" | "heartbeat";

const RECIPES: [SfxRecipe, RegExp][] = [
  ["thunder", /thunder|lightning|storm crack/],
  ["rain", /rain|drizzle|downpour|storm/],
  ["ocean", /ocean|waves?|surf|sea|shore|beach/],
  ["wind", /wind|breeze|gust|blizzard|howl/],
  ["whoosh", /whoosh|swoosh|swish|transition|swipe|fly ?by|pass ?by/],
  ["riser", /riser|rise|build|tension|uplifter|sweep up/],
  ["impact", /impact|hit|boom|punch|explosion|slam|thud|drop|bass drop|braam/],
  ["ding", /ding|chime|bell|notification|success|coin/],
  ["beep", /beep|alarm|alert|countdown|tone/],
  ["click", /click|tap|button|ui|typing|switch|tick/],
  ["fire", /fire|crackle|campfire|flame|fireplace/],
  ["footsteps", /footstep|steps|walking|walk|running/],
  ["heartbeat", /heart ?beat|pulse|heart/],
];

export function chooseRecipe(subject: string): SfxRecipe {
  return matchRecipe(subject) ?? "impact";
}

/** The recipe a request matches, or undefined when nothing fits (whole words only). */
export function matchRecipe(subject: string): SfxRecipe | undefined {
  const s = ` ${subject.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
  for (const [r, re] of RECIPES) {
    const whole = new RegExp(`(?<![a-z])(?:${re.source})(?![a-z])`);
    if (whole.test(s)) return r;
  }
  return undefined;
}

function rngFrom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** One-pole low-pass (in place). `cut` in Hz may vary per sample via fn. */
function lowpass(buf: Float32Array, sr: number, cut: number | ((i: number) => number)): void {
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    const fc = typeof cut === "number" ? cut : cut(i);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
    y += a * (buf[i]! - y);
    buf[i] = y;
  }
}

function highpass(buf: Float32Array, sr: number, cut: number): void {
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

/** State-variable band-pass with a time-varying centre frequency. */
function bandpass(buf: Float32Array, sr: number, fc: (i: number) => number, q = 1.2): void {
  let low = 0;
  let band = 0;
  for (let i = 0; i < buf.length; i++) {
    const f = 2 * Math.sin((Math.PI * Math.min(fc(i), sr / 6)) / sr);
    const high = buf[i]! - low - band / q;
    band += f * high;
    low += f * band;
    buf[i] = band;
  }
}

function noise(n: number, seed: number): Float32Array {
  const r = rngFrom(seed);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = r();
  return b;
}

/** Pink-ish noise (Paul Kellet's economy filter). */
function pink(n: number, seed: number): Float32Array {
  const r = rngFrom(seed);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = r();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
  }
  return out;
}

function addSine(buf: Float32Array, sr: number, start: number, dur: number, f: (t: number) => number, amp: (t: number) => number): void {
  let phase = 0;
  const n = Math.floor(dur * sr);
  for (let i = 0; i < n && start + i < buf.length; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * f(t)) / sr;
    buf[start + i]! += Math.sin(phase) * amp(t);
  }
}

function mixIn(dst: Float32Array, src: Float32Array, at: number, gain: number): void {
  for (let i = 0; i < src.length && at + i < dst.length; i++) dst[at + i]! += src[i]! * gain;
}

function envelope(buf: Float32Array, sr: number, env: (t: number, T: number) => number): void {
  const T = buf.length / sr;
  for (let i = 0; i < buf.length; i++) buf[i]! *= env(i / sr, T);
}

function finish(buf: Float32Array, sr: number, peak = 0.89): Float32Array {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]!));
  const g = p > 0 ? peak / p : 1;
  const fade = Math.min(buf.length / 4, Math.floor(0.008 * sr));
  for (let i = 0; i < buf.length; i++) {
    let v = buf[i]! * g;
    if (i < fade) v *= i / fade;
    if (i > buf.length - fade) v *= (buf.length - i) / fade;
    buf[i] = v;
  }
  return buf;
}

export function synthesizeSfx(recipe: SfxRecipe, seed: number, sr = 48000): Float32Array {
  const secs = (s: number) => Math.floor(s * sr);
  switch (recipe) {
    case "whoosh": {
      const b = noise(secs(1.3), seed);
      const n = b.length;
      bandpass(b, sr, (i) => 250 + 4200 * Math.sin((Math.PI * i) / n) ** 2, 2.5);
      envelope(b, sr, (t, T) => Math.sin((Math.PI * t) / T) ** 2.2);
      return finish(b, sr);
    }
    case "rain": {
      const b = pink(secs(6), seed);
      lowpass(b, sr, 6000);
      highpass(b, sr, 300);
      const r = rngFrom(seed ^ 0x55);
      for (let k = 0; k < 900; k++) {
        const at = Math.floor(((r() + 1) / 2) * (b.length - 800));
        const drop = noise(400, seed + k);
        bandpass(drop, sr, () => 2500 + (r() + 1) * 2500, 4);
        envelope(drop, sr, (t) => Math.exp(-t * 400));
        mixIn(b, drop, at, 0.5 + 0.4 * r());
      }
      return finish(b, sr, 0.6);
    }
    case "thunder": {
      const b = noise(secs(5), seed);
      lowpass(b, sr, (i) => 120 + 1800 * Math.exp(-i / (0.25 * sr)));
      lowpass(b, sr, 900);
      envelope(b, sr, (t) => (t < 0.03 ? t / 0.03 : 1) * (Math.exp(-t * 0.9) * 0.8 + 0.2 * Math.exp(-t * 3) * (1 + Math.sin(t * 17))));
      return finish(b, sr);
    }
    case "wind": {
      const b = pink(secs(6), seed);
      const r = rngFrom(seed);
      const lfoP = (r() + 1) * 3;
      lowpass(b, sr, (i) => 400 + 900 * (0.5 + 0.5 * Math.sin((2 * Math.PI * 0.23 * i) / sr + lfoP)));
      const whistle = noise(b.length, seed ^ 0x99);
      bandpass(whistle, sr, (i) => 700 + 250 * Math.sin((2 * Math.PI * 0.11 * i) / sr), 18);
      mixIn(b, whistle, 0, 0.35);
      envelope(b, sr, (t, T) => Math.min(1, t / 1.2, (T - t) / 1.2) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.17 * t + lfoP) ** 2));
      return finish(b, sr, 0.7);
    }
    case "riser": {
      const b = noise(secs(3.5), seed);
      const n = b.length;
      bandpass(b, sr, (i) => 300 + 6000 * (i / n) ** 2, 3);
      envelope(b, sr, (t, T) => (t / T) ** 2);
      addSine(b, sr, 0, 3.5, (t) => 110 * 2 ** (t / 1.2), (t) => 0.25 * (t / 3.5) ** 2);
      return finish(b, sr);
    }
    case "click": {
      const b = new Float32Array(secs(0.12));
      const c = noise(secs(0.012), seed);
      highpass(c, sr, 1500);
      mixIn(b, c, 0, 1);
      addSine(b, sr, 0, 0.03, () => 2200, (t) => Math.exp(-t * 180) * 0.5);
      return finish(b, sr, 0.7);
    }
    case "ding": {
      const b = new Float32Array(secs(1.6));
      for (const [f, a, d] of [[1318.5, 0.6, 3], [1975.5, 0.3, 4.5], [2637, 0.15, 6], [659.25, 0.2, 2.5]] as const) {
        addSine(b, sr, 0, 1.6, () => f, (t) => a * Math.exp(-t * d) * Math.min(1, t / 0.003));
      }
      return finish(b, sr, 0.7);
    }
    case "beep": {
      const b = new Float32Array(secs(1.2));
      for (let k = 0; k < 3; k++) addSine(b, sr, secs(k * 0.4), 0.16, () => 1000, (t) => 0.5 * Math.min(1, t / 0.005, (0.16 - t) / 0.005));
      return finish(b, sr, 0.6);
    }
    case "fire": {
      const b = pink(secs(5), seed);
      lowpass(b, sr, 700);
      const r = rngFrom(seed ^ 0x77);
      for (let k = 0; k < 160; k++) {
        const at = Math.floor(((r() + 1) / 2) * (b.length - 2000));
        const pop = noise(Math.floor(200 + (r() + 1) * 600), seed + 3 * k);
        highpass(pop, sr, 1200);
        envelope(pop, sr, (t) => Math.exp(-t * 250));
        mixIn(b, pop, at, 0.6 + 0.8 * Math.abs(r()));
      }
      return finish(b, sr, 0.7);
    }
    case "footsteps": {
      const b = new Float32Array(secs(3));
      for (let k = 0; k < 5; k++) {
        const at = secs(0.25 + k * 0.52);
        const step = noise(secs(0.12), seed + k);
        lowpass(step, sr, 900);
        envelope(step, sr, (t) => Math.exp(-t * 45));
        mixIn(b, step, at, k % 2 ? 0.8 : 1);
        addSine(b, sr, at, 0.08, () => 75, (t) => 0.5 * Math.exp(-t * 60));
      }
      return finish(b, sr, 0.8);
    }
    case "ocean": {
      const b = pink(secs(8), seed);
      lowpass(b, sr, (i) => 350 + 2200 * Math.max(0, Math.sin((2 * Math.PI * i) / (sr * 4)) ** 3));
      envelope(b, sr, (t, T) => Math.min(1, t / 1.5, (T - t) / 1.5) * (0.35 + 0.65 * Math.max(0, Math.sin((2 * Math.PI * t) / 4)) ** 2));
      return finish(b, sr, 0.7);
    }
    case "heartbeat": {
      const b = new Float32Array(secs(3.2));
      for (let k = 0; k < 4; k++) {
        for (const [off, amp] of [[0, 1], [0.18, 0.7]] as const) {
          addSine(b, sr, secs(0.1 + k * 0.8 + off), 0.2, (t) => 55 + 25 * Math.exp(-t * 30), (t) => amp * Math.exp(-t * 22) * Math.min(1, t / 0.004));
        }
      }
      lowpass(b, sr, 200);
      return finish(b, sr);
    }
    case "impact":
    default: {
      const b = new Float32Array(secs(2));
      addSine(b, sr, 0, 2, (t) => 35 + 90 * Math.exp(-t * 14), (t) => Math.exp(-t * 3.2) * Math.min(1, t / 0.002));
      const hit = noise(secs(0.6), seed);
      lowpass(hit, sr, (i) => 200 + 5000 * Math.exp(-i / (0.03 * sr)));
      envelope(hit, sr, (t) => Math.exp(-t * 9));
      mixIn(b, hit, 0, 0.8);
      // Gentle saturation for weight.
      for (let i = 0; i < b.length; i++) b[i] = Math.tanh(b[i]! * 1.6);
      return finish(b, sr);
    }
  }
}

export function renderSfx(subject: string, dest: string, seed = 0x1234abcd): { info: WavInfo; recipe: SfxRecipe } {
  const recipe = chooseRecipe(subject);
  let h = seed;
  for (let i = 0; i < subject.length; i++) h = Math.imul(h ^ subject.charCodeAt(i), 16777619) >>> 0;
  const sr = 48000;
  return { info: writeWavPcm16(dest, synthesizeSfx(recipe, h, sr), sr), recipe };
}
