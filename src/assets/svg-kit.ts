/**
 * Small, dependency-free toolkit shared by the offline SVG designer:
 * deterministic RNG, color math (palette ramps + WCAG contrast), XML escaping,
 * font stacks, and a text-width estimator so layouts can fit type into a safe
 * area without a font engine.
 */

// ── Deterministic randomness ────────────────────────────────────────────────

export function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Rng = () => number;

/** mulberry32 — tiny, fast, good enough for layout jitter. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function range(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export function pickOne<T>(arr: readonly T[], rng: Rng): T {
  return arr[Math.floor(rng() * arr.length) % arr.length]!;
}

// ── Color ───────────────────────────────────────────────────────────────────

export interface Rgb { r: number; g: number; b: number }

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear mix of two hex colors: t=0 → a, t=1 → b. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a) ?? { r: 0, g: 0, b: 0 };
  const y = parseHex(b) ?? { r: 0, g: 0, b: 0 };
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

export const lighten = (c: string, t: number) => mix(c, "#ffffff", t);
export const darken = (c: string, t: number) => mix(c, "#000000", t);

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(hex: string): number {
  const c = parseHex(hex) ?? { r: 0, g: 0, b: 0 };
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** HSL saturation proxy (0..1) used to rank "brand" colors. */
export function saturation(hex: string): number {
  const c = parseHex(hex) ?? { r: 0, g: 0, b: 0 };
  const mx = Math.max(c.r, c.g, c.b) / 255;
  const mn = Math.min(c.r, c.g, c.b) / 255;
  if (mx === mn) return 0;
  const l = (mx + mn) / 2;
  return l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
}

/** Pick the most readable of `candidates` on `bg`. */
export function readableOn(bg: string, candidates: string[] = ["#0f172a", "#ffffff"]): string {
  return [...candidates].sort((a, b) => contrast(b, bg) - contrast(a, bg))[0]!;
}

/**
 * A designer's palette derived from the persona brief's (usually 3) colors.
 * Roles are assigned by luminance/saturation rather than array position, since
 * persona palettes mix brand colors with a light background tone.
 */
export interface DesignPalette {
  primary: string;
  secondary: string;
  accent: string;
  /** Near-white surface tint. */
  light: string;
  /** Near-black on-brand ink for type. */
  ink: string;
  /** Muted text color. */
  muted: string;
  /** Whether the source palette is essentially grayscale. */
  mono: boolean;
}

const FALLBACK = ["#2563eb", "#0ea5e9", "#f8fafc"];

export function designPalette(input?: string[]): DesignPalette {
  const colors = (input ?? []).filter((c) => parseHex(c));
  const src = colors.length ? colors : FALLBACK;
  const lights = src.filter((c) => luminance(c) > 0.75);
  const brand = src.filter((c) => luminance(c) <= 0.75);
  // Persona palettes list the intended primary first, so keep their order for
  // brand colors; only fall back to saturation ranking when all are light.
  const ranked = brand.length ? brand : [...src].sort((a, b) => saturation(b) - saturation(a) || luminance(a) - luminance(b));
  const mono = src.every((c) => saturation(c) < 0.12);

  // For mono palettes the darkest tone leads; otherwise the most saturated.
  const primary = mono ? [...src].sort((a, b) => luminance(a) - luminance(b))[0]! : ranked[0]!;
  const secondary = ranked.find((c) => c !== primary) ?? mix(primary, "#ffffff", 0.35);
  const accent = ranked.find((c) => c !== primary && c !== secondary) ?? (mono ? mix(primary, "#ffffff", 0.55) : shiftTowards(secondary, primary));
  const light = lights[0] ? mix(lights[0], "#ffffff", 0.2) : mix(primary, "#ffffff", 0.94);
  const ink = mono ? "#0b0f19" : mix(darken(primary, 0.72), "#0b1020", 0.5);
  const muted = mix(ink, "#ffffff", 0.45);
  return { primary, secondary, accent, light, ink, muted, mono };
}

function shiftTowards(a: string, b: string): string {
  return mix(a, b, 0.5);
}

/** A 5-step tonal ramp from light to dark around a base color. */
export function ramp(base: string): [string, string, string, string, string] {
  return [lighten(base, 0.78), lighten(base, 0.45), base, darken(base, 0.3), darken(base, 0.58)];
}

// ── Typography ──────────────────────────────────────────────────────────────

export const FONT_SANS = "Poppins, Montserrat, 'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', sans-serif";
export const FONT_SERIF = "'Playfair Display', Georgia, 'Times New Roman', 'DejaVu Serif', serif";
export const FONT_MONO = "'JetBrains Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** Helvetica/Arial advance widths per 1000 em; unknown glyphs use 600. */
const ADV: Record<string, number> = {
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191, "(": 333, ")": 333,
  "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278, ":": 278, ";": 278, "?": 556, "@": 1015,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
  n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
};

/**
 * Estimated rendered width in px. `safety` over-estimates on purpose because
 * the fallback fonts (Poppins, DejaVu Sans) are wider than Helvetica.
 */
export function textWidth(text: string, fontSize: number, opts: { bold?: boolean; letterSpacing?: number; safety?: number } = {}): number {
  let units = 0;
  for (const ch of text) units += ADV[ch] ?? (/[0-9]/.test(ch) ? 556 : 600);
  const boldK = opts.bold ? 1.07 : 1;
  const safety = opts.safety ?? 1.14;
  const spacing = (opts.letterSpacing ?? 0) * Math.max(0, [...text].length - 1);
  return (units / 1000) * fontSize * boldK * safety + spacing;
}

/** Largest font size (<= max) so `text` fits in `maxWidth`. */
export function fitFontSize(text: string, maxWidth: number, maxSize: number, opts: { bold?: boolean; trackingEm?: number; minSize?: number } = {}): number {
  let size = maxSize;
  const min = opts.minSize ?? 8;
  while (size > min) {
    const w = textWidth(text, size, { bold: opts.bold, letterSpacing: (opts.trackingEm ?? 0) * size });
    if (w <= maxWidth) break;
    size -= Math.max(1, size * 0.04);
  }
  return Math.max(min, Math.round(size));
}

/** Greedy word-wrap using the width estimator; ellipsizes past maxLines. */
export function wrapText(text: string, fontSize: number, maxWidth: number, maxLines = 3, bold = false): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textWidth(next, fontSize, { bold }) <= maxWidth || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1]!;
    while (last.length > 1 && textWidth(`${last}…`, fontSize, { bold }) > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.replace(/[\s,.;:]+$/, "")}…`;
    return kept;
  }
  return lines;
}

// ── XML ─────────────────────────────────────────────────────────────────────

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Strip control chars that are illegal in XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function titleCase(s: string): string {
  return s.replace(/[A-Za-z][^\s-]*/g, (w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()));
}

/** Round to 2 decimals so SVG output stays compact and diff-stable. */
export function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

export function svgDoc(width: number, height: number, body: string, opts: { title?: string; desc?: string; defs?: string } = {}): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    opts.title ? `<title>${esc(opts.title)}</title>` : "",
    opts.desc ? `<desc>${esc(opts.desc)}</desc>` : "",
    opts.defs ? `<defs>${opts.defs}</defs>` : "",
    body,
    `</svg>`,
    "",
  ].filter(Boolean).join("\n");
}

/** Parse "16:9" → [16, 9]; null when invalid. */
export function parseAspect(ar?: string): [number, number] | null {
  if (!ar) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(ar);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? [w, h] : null;
}

/** Canvas size for an aspect ratio with the long edge = `long`. */
export function sizeFor(ar: string | undefined, long: number, fallback: [number, number]): { width: number; height: number } {
  const [w, h] = parseAspect(ar) ?? fallback;
  return w >= h
    ? { width: long, height: Math.round((long * h) / w) }
    : { width: Math.round((long * w) / h), height: long };
}

/** Match any of the words (whole-word-ish, case-insensitive). */
export function hasAny(hay: string, words: string[]): boolean {
  const h = ` ${hay.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return words.some((w) => h.includes(` ${w} `) || h.includes(` ${w}s `));
}
