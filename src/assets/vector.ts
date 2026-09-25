/**
 * Offline SVG designer — the "design" half of the image engine.
 *
 * Deterministic (seeded by the subject), dependency-free, and valid SVG 1.1
 * that renders identically in browsers, librsvg (rsvg-convert, ffmpeg) and
 * resvg. Every generator takes the persona brief's palette + style so the
 * Graphic Designer's directives (limited flat palette, generous padding, safe
 * area, transparent logo background, 8pt grid) are actually honored.
 *
 *   generateLogoSvg            logo (emblem / monogram / wordmark / horizontal)
 *                              + reversed (dark-background) and icon variants
 *   generateVectorArtSvg       layered flat illustration matched to the subject
 *   generateUiMockupSvg        device-framed UI screen (see ui-mockup.ts)
 *   generatePhotoPlaceholderSvg labelled, tasteful stand-in for a photo
 *   generateStoryboardFrameSvg per-shot storyboard card (offline animatic)
 */
import fs from "node:fs";
import path from "node:path";
import {
  FONT_SANS, FONT_SERIF, contrast, darken, designPalette, esc, fitFontSize, hasAny, lighten,
  luminance, makeRng, mix, n, pickOne, range, seedFrom, sizeFor, svgDoc, textWidth,
  titleCase, wrapText, type DesignPalette, type Rng,
} from "./svg-kit.js";
import { uiMockupSvg } from "./ui-mockup.js";

export interface VectorOptions {
  /** Style keywords from the brief, e.g. "vibrant", "luxury", "sharp", "noir". */
  style?: string;
  /** Aspect ratio from the brief, e.g. "1:1", "16:10", "3:1". */
  aspectRatio?: string;
  /** "sharp corners" | "softly rounded corners" (Graphic Designer param). */
  cornerStyle?: string;
}

export interface VectorResult {
  width: number;
  height: number;
  /** Extra files written next to the main one (logo variants), by role. */
  variants?: Record<string, string>;
  /** Human-readable design decisions (layout, mark, template…). */
  notes?: string[];
}

function write(dest: string, svg: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, svg, "utf8");
}

// ════════════════════════════════════════════════════════════════════════════
// Logos
// ════════════════════════════════════════════════════════════════════════════

type MarkKind =
  | "orbit" | "spark" | "cube" | "leaf" | "peak" | "wave" | "bolt" | "stack"
  | "bean" | "pulse" | "ascend" | "drop" | "bloom";

const MARK_KEYWORDS: [MarkKind, string[]][] = [
  ["orbit", ["nova", "space", "orbit", "planet", "astro", "cosmic", "cosmos", "galaxy", "satellite", "moon", "lunar", "rocket"]],
  ["spark", ["star", "spark", "idea", "ai", "magic", "bright", "shine", "stellar", "genius", "insight", "twinkle"]],
  ["cube", ["labs", "lab", "tech", "data", "block", "blocks", "chain", "crypto", "cube", "build", "software", "dev", "code", "systems", "robotics", "quantum"]],
  ["leaf", ["eco", "green", "leaf", "plant", "garden", "organic", "nature", "bio", "farm", "herb", "tea", "vegan", "botanical"]],
  ["peak", ["mountain", "peak", "summit", "outdoor", "adventure", "alpine", "trek", "climb", "travel", "expedition", "ridge"]],
  ["wave", ["wave", "sea", "ocean", "surf", "audio", "sound", "music", "radio", "flow", "podcast", "tide", "sonic"]],
  ["bolt", ["energy", "power", "electric", "fast", "volt", "charge", "bolt", "flash", "speed", "turbo", "rapid"]],
  ["stack", ["stack", "layer", "layers", "cloud", "platform", "server", "ops", "infra", "hosting", "saas"]],
  ["bean", ["coffee", "cafe", "espresso", "roast", "roastery", "bean", "brew", "barista"]],
  ["pulse", ["health", "medical", "clinic", "care", "fitness", "heart", "pulse", "med", "wellness", "hospital", "therapy"]],
  ["ascend", ["finance", "capital", "invest", "growth", "bank", "fund", "wealth", "trade", "trading", "analytics", "ventures", "money"]],
  ["drop", ["water", "drop", "pure", "clean", "spa", "skin", "aqua", "hydro", "rain"]],
  ["bloom", ["flower", "bloom", "floral", "beauty", "boutique", "petal", "florist", "wedding", "studio"]],
];

function chooseMark(name: string, subject: string, rng: Rng): MarkKind {
  const hay = `${name} ${subject}`;
  for (const [kind, words] of MARK_KEYWORDS) if (hasAny(hay, words)) return kind;
  // Compound brand names ("Greenleaf", "Voltline"): match keyword stems inside words.
  const squashed = name.toLowerCase().replace(/[^a-z]/g, "");
  for (const [kind, words] of MARK_KEYWORDS) if (words.some((w) => w.length >= 4 && squashed.includes(w))) return kind;
  return pickOne(["bloom", "spark", "cube", "orbit", "stack", "wave"] as MarkKind[], rng);
}

/** Pull a brand name out of a free-text request. */
export function brandName(subject: string): { name: string; tagline: string } {
  let s = subject.trim();
  const quoted = /["“']([^"”']{2,40})["”']/.exec(s);
  if (quoted) return { name: quoted[1]!.trim(), tagline: "" };
  const called = /\b(?:called|named)\s+([A-Z0-9][\w&'.-]*(?:\s+[A-Z0-9][\w&'.-]*){0,3})/.exec(s);
  if (called) return { name: called[1]!.trim(), tagline: "" };
  const sep = /\s+[-–—:|]\s+|:\s*|,\s+/.exec(s);
  let tagline = "";
  if (sep) {
    tagline = s.slice(sep.index + sep[0].length).trim();
    s = s.slice(0, sep.index).trim();
  }
  s = s.replace(/^(?:a|an|the)?\s*(?:logo|brand|branding|mark|identity)\s+(?:for|of)\s+(?:a|an|the)?\s*/i, "");
  const words = s.split(/\s+/).filter(Boolean);
  const name = titleCase(words.slice(0, 4).join(" ")) || "Brand";
  return { name, tagline: titleCase(tagline).slice(0, 48) };
}

function initialsOf(name: string): string {
  const words = name.split(/[\s-]+/).filter((w) => /[A-Za-z0-9]/.test(w));
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0]?.[0] ?? "B").toUpperCase();
}

interface MarkColors { primary: string; secondary: string; accent: string; knock: string }

/** Draw a mark inside a 100×100 box. `uid` keeps clipPath ids unique per file. */
function drawMark(kind: MarkKind, c: MarkColors, uid: string, sharp: boolean): string {
  switch (kind) {
    case "orbit":
      return `<g transform="rotate(-22 50 50)">
  <path d="M6 50 A44 14 0 0 1 94 50" fill="none" stroke="${c.secondary}" stroke-width="5" stroke-linecap="round"/>
  <circle cx="50" cy="50" r="26" fill="${c.primary}"/>
  <path d="M94 50 A44 14 0 0 1 6 50" fill="none" stroke="${c.secondary}" stroke-width="5" stroke-linecap="round"/>
</g>
<circle cx="84" cy="18" r="7" fill="${c.accent}"/>`;
    case "spark":
      return `<path d="M46 8 C49 38 58 47 88 50 C58 53 49 62 46 92 C43 62 34 53 4 50 C34 47 43 38 46 8 Z" fill="${c.primary}"/>
<path d="M82 6 C83 15 86 18 95 19 C86 20 83 23 82 32 C81 23 78 20 69 19 C78 18 81 15 82 6 Z" fill="${c.secondary}"/>
<circle cx="82" cy="84" r="5" fill="${c.accent}"/>`;
    case "cube": {
      const top = shrink([[50, 6], [88.1, 28], [50, 50], [11.9, 28]], 3);
      const left = shrink([[11.9, 28], [50, 50], [50, 94], [11.9, 72]], 3);
      const right = shrink([[50, 50], [88.1, 28], [88.1, 72], [50, 94]], 3);
      return `<polygon points="${pts(top)}" fill="${c.secondary}" stroke-linejoin="round"/>
<polygon points="${pts(left)}" fill="${c.primary}"/>
<polygon points="${pts(right)}" fill="${darken(c.primary, 0.28)}"/>`;
    }
    case "leaf":
      return `<g transform="rotate(-30 50 92)"><path d="M50 92 C24 72 22 34 50 8 C78 34 76 72 50 92 Z" fill="${c.secondary}"/></g>
<g transform="rotate(26 50 92)"><path d="M50 92 C24 72 22 34 50 8 C78 34 76 72 50 92 Z" fill="${c.primary}"/>
<path d="M50 88 L50 22" stroke="${c.knock}" stroke-width="3.2" stroke-linecap="round"/>
<path d="M50 60 L62 48 M50 44 L60 35 M50 72 L38 62" stroke="${c.knock}" stroke-width="2.6" stroke-linecap="round"/></g>`;
    case "peak":
      return `<clipPath id="clip-${uid}"><circle cx="50" cy="50" r="44"/></clipPath>
<circle cx="50" cy="50" r="44" fill="none" stroke="${c.primary}" stroke-width="5"/>
<g clip-path="url(#clip-${uid})">
  <circle cx="70" cy="32" r="10" fill="${c.accent}"/>
  <polygon points="2,96 42,26 82,96" fill="${c.primary}"/>
  <polygon points="42,26 33,42 39,38 43,44 48,37 52,40" fill="${c.knock}"/>
  <polygon points="44,96 70,50 98,96" fill="${c.secondary}"/>
</g>`;
    case "wave":
      return [32, 50, 68].map((y, i) => {
        const col = [c.primary, c.secondary, c.accent][i]!;
        return `<path d="M8 ${y} C20 ${y - 11} 34 ${y - 11} 46 ${y} S72 ${y + 11} 92 ${y - 2}" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round"/>`;
      }).join("\n");
    case "bolt":
      return `<rect x="6" y="6" width="88" height="88" rx="${sharp ? 6 : 24}" fill="${c.primary}"/>
<polygon points="57,14 26,56 47,56 41,88 74,42 53,42 60,14" fill="${c.knock}" stroke="${c.knock}" stroke-width="2" stroke-linejoin="round"/>`;
    case "stack":
      return `<polygon points="50,12 88,32 50,52 12,32" fill="${c.primary}" stroke="${c.primary}" stroke-width="4" stroke-linejoin="round"/>
<polyline points="12,50 50,70 88,50" fill="none" stroke="${c.secondary}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
<polyline points="12,68 50,88 88,68" fill="none" stroke="${c.accent}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "bean":
      return `<circle cx="50" cy="50" r="45" fill="none" stroke="${c.secondary}" stroke-width="4"/>
<g transform="rotate(-32 50 50)">
  <ellipse cx="50" cy="50" rx="25" ry="35" fill="${c.primary}"/>
  <path d="M50 17 C38 38 62 62 50 83" fill="none" stroke="${c.knock}" stroke-width="5" stroke-linecap="round"/>
</g>`;
    case "pulse":
      return `<circle cx="50" cy="50" r="44" fill="${c.primary}"/>
<polyline points="14,53 32,53 40,34 51,74 60,42 66,53 86,53" fill="none" stroke="${c.knock}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "ascend": {
      const r = sharp ? 1 : 4;
      return `<rect x="12" y="58" width="18" height="30" rx="${r}" fill="${c.accent}"/>
<rect x="41" y="42" width="18" height="46" rx="${r}" fill="${c.secondary}"/>
<rect x="70" y="24" width="18" height="64" rx="${r}" fill="${c.primary}"/>
<path d="M10 44 L38 22 L52 32 L80 8" fill="none" stroke="${c.primary}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
<polygon points="84,4 86,20 70,10" fill="${c.primary}"/>`;
    }
    case "drop":
      return `<path d="M50 4 C50 4 16 44 16 64 A34 34 0 0 0 84 64 C84 44 50 4 50 4 Z" fill="${c.primary}"/>
<path d="M32 64 A18 18 0 0 0 48 82" fill="none" stroke="${c.knock}" stroke-width="5" stroke-linecap="round"/>
<circle cx="66" cy="40" r="6" fill="${c.secondary}"/>`;
    case "bloom":
    default:
      return [0, 60, 120, 180, 240, 300].map((deg, i) =>
        `<ellipse cx="50" cy="30" rx="13" ry="24" transform="rotate(${deg} 50 50)" fill="${i % 2 ? c.secondary : c.primary}" fill-opacity="0.88"/>`,
      ).join("\n") + `\n<circle cx="50" cy="50" r="9" fill="${c.accent}"/>`;
  }
}

function pts(p: number[][]): string {
  return p.map(([x, y]) => `${n(x!)},${n(y!)}`).join(" ");
}

/** Pull polygon vertices toward their centroid so faces get clean gaps. */
function shrink(p: number[][], by: number): number[][] {
  const cx = p.reduce((s, v) => s + v[0]!, 0) / p.length;
  const cy = p.reduce((s, v) => s + v[1]!, 0) / p.length;
  return p.map(([x, y]) => {
    const dx = x! - cx;
    const dy = y! - cy;
    const d = Math.hypot(dx, dy) || 1;
    return [x! - (dx / d) * by, y! - (dy / d) * by];
  });
}

type BadgeShape = "circle" | "rounded" | "hexagon" | "shield";

function badge(shape: BadgeShape, fill: string, sharp: boolean): string {
  switch (shape) {
    case "circle": return `<circle cx="50" cy="50" r="48" fill="${fill}"/>`;
    case "rounded": return `<rect x="2" y="2" width="96" height="96" rx="${sharp ? 8 : 26}" fill="${fill}"/>`;
    case "hexagon": return `<polygon points="50,2 91.6,26 91.6,74 50,98 8.4,74 8.4,26" fill="${fill}" stroke="${fill}" stroke-width="${sharp ? 0 : 6}" stroke-linejoin="round"/>`;
    case "shield":
    default: return `<path d="M50 2 L92 16 L92 48 C92 74 72 90 50 98 C28 90 8 74 8 48 L8 16 Z" fill="${fill}"/>`;
  }
}

type Layout = "emblem" | "monogram" | "wordmark" | "horizontal";
type TypeVoice = "modern" | "premium" | "tech" | "playful";

function chooseLayout(style: string, aspect: [number, number] | null, rng: Rng): Layout {
  const s = style.toLowerCase();
  if (/\bmonogram|initials?|badge|crest|seal\b/.test(s)) return "monogram";
  if (/\bwordmark|typographic|logotype|text only\b/.test(s)) return "wordmark";
  if (/\bhorizontal|lockup|banner|header\b/.test(s)) return "horizontal";
  if (/\bemblem|icon|symbol|mark\b/.test(s)) return "emblem";
  if (aspect && aspect[0] / aspect[1] >= 1.8) return "horizontal";
  return pickOne(["emblem", "emblem", "monogram"] as Layout[], rng);
}

function chooseVoice(style: string): TypeVoice {
  const s = style.toLowerCase();
  if (/luxury|elegant|premium|classic|serif|fashion|wedding|boutique|noir/.test(s)) return "premium";
  if (/tech|mono|minimal|brutal|future|cyber|industrial/.test(s)) return "tech";
  if (/playful|fun|kids|friendly|vibrant|cute|bubbly/.test(s)) return "playful";
  return "modern";
}

interface TypeSpec { family: string; weight: number; upper: boolean; trackingEm: number }

function typeSpec(voice: TypeVoice): TypeSpec {
  switch (voice) {
    case "premium": return { family: FONT_SERIF, weight: 600, upper: true, trackingEm: 0.16 };
    case "tech": return { family: FONT_SANS, weight: 600, upper: true, trackingEm: 0.12 };
    case "playful": return { family: FONT_SANS, weight: 800, upper: false, trackingEm: -0.01 };
    default: return { family: FONT_SANS, weight: 700, upper: false, trackingEm: -0.015 };
  }
}

function textEl(x: number, y: number, str: string, size: number, fill: string, spec: TypeSpec, anchor: "start" | "middle" | "end" = "middle", extra = ""): string {
  const ls = spec.trackingEm ? ` letter-spacing="${n(spec.trackingEm * size)}"` : "";
  return `<text x="${n(x)}" y="${n(y)}" font-family="${esc(spec.family)}" font-size="${n(size)}" font-weight="${spec.weight}" fill="${fill}" text-anchor="${anchor}"${ls}${extra}>${esc(str)}</text>`;
}

interface LogoParts {
  width: number; height: number; body: string; icon: string; notes: string[];
}

function logoParts(subject: string, pal: DesignPalette, opts: VectorOptions, reversed: boolean): LogoParts {
  const style = opts.style ?? "";
  const rng = makeRng(seedFrom(`logo:${subject}`));
  const sharp = /sharp/i.test(opts.cornerStyle ?? "") || /\bsharp|brutal/i.test(style);
  const aspect = parseAspectSafe(opts.aspectRatio);
  const layout = chooseLayout(style, aspect, rng);
  const { name, tagline } = brandName(subject);
  const mark = chooseMark(name, subject, rng);
  const voice = chooseVoice(style);
  const spec = typeSpec(voice);
  const uid = (seedFrom(subject + (reversed ? "r" : "")) % 1e6).toString(36);

  // Colors: on transparent. Reversed = for dark backgrounds.
  const bgProbe = reversed ? "#0b1020" : "#ffffff";
  const fix = (col: string) => (contrast(col, bgProbe) < 2.2 ? (reversed ? lighten(col, 0.55) : darken(col, 0.35)) : col);
  const colors: MarkColors = {
    primary: fix(pal.primary),
    secondary: fix(pal.secondary),
    accent: fix(pal.accent),
    knock: "#ffffff",
  };
  if (reversed && luminance(colors.primary) > 0.6) colors.knock = "#0b1020";
  const ink = reversed ? "#f8fafc" : pal.ink;
  const muted = reversed ? "#cbd5e1" : pal.muted;
  const display = spec.upper ? name.toUpperCase() : name;

  const notes = [`layout=${layout}`, `mark=${mark}`, `type=${voice}`, `name="${name}"`];
  const shape: BadgeShape = sharp ? pickOne(["rounded", "hexagon", "shield"] as BadgeShape[], rng) : pickOne(["circle", "rounded", "hexagon", "shield"] as BadgeShape[], rng);
  const badgeFill = colors.primary;
  const initials = initialsOf(name);
  // White initials unless the badge is too light for them (WCAG large-text 3:1).
  const monoInk = contrast("#ffffff", badgeFill) >= 3 ? "#ffffff" : "#0b1020";
  const monogramSvg = (size: number) => {
    const fs_ = size * (initials.length > 1 ? 0.36 : 0.5);
    return `${badge(shape, badgeFill, sharp)}
<circle cx="50" cy="50" r="${shape === "circle" ? 40 : 0}" fill="none" stroke="${monoInk}" stroke-opacity="0.35" stroke-width="${shape === "circle" ? 1.6 : 0}"/>
<text x="50" y="${n(50 + (fs_ / size) * 100 * 0.35)}" font-family="${esc(spec.family)}" font-size="${n((fs_ / size) * 100)}" font-weight="${Math.max(700, spec.weight)}" fill="${monoInk}" text-anchor="middle" letter-spacing="${n(initials.length > 1 ? 1 : 0)}">${esc(initials)}</text>`;
  };
  const markSvg = layout === "monogram" ? monogramSvg(100) : drawMark(mark, colors, uid, sharp);
  const icon = markSvg;

  if (layout === "horizontal" || layout === "wordmark") {
    const [aw, ah] = aspect && aspect[0] / aspect[1] >= 1.6 ? aspect : [8, 3];
    const W = 1600;
    const H = Math.round((W * ah) / aw);
    const m = Math.round(H * 0.16);
    const parts: string[] = [];
    if (layout === "horizontal") {
      const S = Math.round(Math.min(H - 2 * m, H * 0.6));
      const gap = Math.round(S * 0.28);
      const maxText = W - 2 * m - S - gap;
      const size = fitFontSize(display, maxText, S * 0.62, { bold: true, trackingEm: spec.trackingEm });
      const tagSize = Math.round(size * 0.3);
      const blockW = S + gap + Math.min(maxText, textWidth(display, size, { bold: true, letterSpacing: spec.trackingEm * size, safety: 1.02 }));
      const x0 = Math.round((W - blockW) / 2);
      const cy = H / 2;
      parts.push(`<g transform="translate(${n(x0)} ${n(cy - S / 2)}) scale(${n(S / 100)})">${markSvg}</g>`);
      const ty = tagline ? cy + size * 0.12 : cy + size * 0.35;
      parts.push(textEl(x0 + S + gap, ty, display, size, ink, spec, "start"));
      if (tagline) parts.push(textEl(x0 + S + gap, ty + tagSize * 1.9, tagline.toUpperCase(), tagSize, muted, { ...spec, weight: 500, trackingEm: 0.22, family: FONT_SANS }, "start"));
    } else {
      // Wordmark: pure type with an accent bar and a colored full stop.
      const size = fitFontSize(display + ".", W - 2 * m, H * 0.34, { bold: true, trackingEm: spec.trackingEm });
      const cy = H / 2 + size * 0.3 - (tagline ? size * 0.25 : 0);
      const tw = Math.min(W - 2 * m, textWidth(display, size, { bold: true, letterSpacing: spec.trackingEm * size, safety: 1.0 }));
      parts.push(`<text x="${W / 2}" y="${n(cy)}" font-family="${esc(spec.family)}" font-size="${size}" font-weight="${spec.weight}" fill="${ink}" text-anchor="middle"${spec.trackingEm ? ` letter-spacing="${n(spec.trackingEm * size)}"` : ""}>${esc(display)}<tspan fill="${colors.primary}">.</tspan></text>`);
      parts.push(`<rect x="${n(W / 2 - tw / 2)}" y="${n(cy + size * 0.22)}" width="${n(Math.max(size * 0.9, tw * 0.18))}" height="${n(Math.max(6, size * 0.07))}" rx="${sharp ? 0 : n(size * 0.035)}" fill="${colors.secondary}"/>`);
      if (tagline) parts.push(textEl(W / 2, cy + size * 0.22 + size * 0.55, tagline.toUpperCase(), Math.round(size * 0.22), muted, { ...spec, weight: 500, trackingEm: 0.22, family: FONT_SANS }));
    }
    return { width: W, height: H, body: parts.join("\n"), icon, notes };
  }

  // Square layouts: emblem (mark over name) and monogram (badge over name).
  const size = aspect ? sizeFor(opts.aspectRatio, 1024, [1, 1]) : { width: 1024, height: 1024 };
  const W = size.width;
  const H = size.height;
  const m = Math.round(Math.min(W, H) * 0.12);
  const S = Math.round(Math.min(W, H) * (layout === "monogram" ? 0.4 : 0.38));
  const nameSize = fitFontSize(display, W - 2 * m, Math.min(W, H) * 0.105, { bold: true, trackingEm: spec.trackingEm });
  const tagSize = Math.max(14, Math.round(Math.min(W, H) * 0.028));
  const gap = Math.round(S * 0.2);
  const blockH = S + gap + nameSize * 0.78 + (tagline ? tagSize * 2.4 : 0);
  const top = Math.round((H - blockH) / 2);
  const parts = [
    `<g transform="translate(${n(W / 2 - S / 2)} ${top}) scale(${n(S / 100)})">${markSvg}</g>`,
    textEl(W / 2, top + S + gap + nameSize * 0.78, display, nameSize, ink, spec),
  ];
  if (tagline) {
    parts.push(textEl(W / 2, top + S + gap + nameSize * 0.78 + tagSize * 2.2, tagline.toUpperCase(), tagSize, muted, { family: FONT_SANS, weight: 500, upper: true, trackingEm: 0.24 }));
  }
  return { width: W, height: H, body: parts.join("\n"), icon, notes };
}

function parseAspectSafe(ar?: string): [number, number] | null {
  const m = ar ? /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(ar) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export interface LogoSvgs { main: string; reversed: string; icon: string; width: number; height: number; notes: string[] }

/** Pure builder (no I/O): the logo plus its reversed and icon-only variants. */
export function logoSvgs(subject: string, palette?: string[], opts: VectorOptions = {}): LogoSvgs {
  const pal = designPalette(palette);
  const main = logoParts(subject, pal, opts, false);
  const rev = logoParts(subject, pal, opts, true);
  const { name } = brandName(subject);
  const title = `${name} logo`;
  const iconSize = 512;
  const im = iconSize * 0.12;
  const iconBody = `<g transform="translate(${n(im)} ${n(im)}) scale(${n((iconSize - 2 * im) / 100)})">${main.icon}</g>`;
  return {
    main: svgDoc(main.width, main.height, main.body, { title, desc: `Logo for ${subject}. Transparent background; ${main.notes.join(", ")}.` }),
    reversed: svgDoc(rev.width, rev.height, rev.body, { title: `${title} (reversed)`, desc: "For dark backgrounds. Transparent background." }),
    icon: svgDoc(iconSize, iconSize, iconBody, { title: `${title} (icon)`, desc: "Square app/fav icon. Transparent background." }),
    width: main.width,
    height: main.height,
    notes: main.notes,
  };
}

/**
 * Write the logo to `dest` (transparent background) plus `<base>-reversed.svg`
 * for dark backgrounds and `<base>-icon.svg` (square mark only).
 */
export function generateLogoSvg(subject: string, palette: string[] | undefined, dest: string, opts: VectorOptions = {}): VectorResult {
  const out = logoSvgs(subject, palette, opts);
  const base = dest.replace(/\.svg$/i, "");
  const variants = { reversed: `${base}-reversed.svg`, icon: `${base}-icon.svg` };
  write(dest, out.main);
  write(variants.reversed, out.reversed);
  write(variants.icon, out.icon);
  return { width: out.width, height: out.height, variants, notes: out.notes };
}

// ════════════════════════════════════════════════════════════════════════════
// Vector art — layered flat illustration
// ════════════════════════════════════════════════════════════════════════════

type ArtTemplate = "landscape" | "sea" | "city" | "space" | "forest" | "network" | "abstract";

const ART_KEYWORDS: [ArtTemplate, string[]][] = [
  ["space", ["space", "planet", "galaxy", "cosmos", "cosmic", "rocket", "astronaut", "orbit", "nebula", "universe", "stars", "moon"]],
  ["sea", ["sea", "ocean", "beach", "lighthouse", "coast", "harbor", "harbour", "boat", "island", "wave", "sail", "shore", "lake", "storm"]],
  ["city", ["city", "skyline", "urban", "street", "neon", "cyberpunk", "downtown", "building", "metropolis", "town", "rooftop"]],
  ["forest", ["forest", "tree", "woods", "jungle", "camp", "camping", "pine", "grove", "cabin"]],
  ["landscape", ["mountain", "hill", "valley", "landscape", "nature", "sunset", "sunrise", "desert", "field", "meadow", "canyon", "peak", "travel"]],
  ["network", ["control", "tech", "data", "network", "ai", "robot", "circuit", "server", "digital", "code", "cloud", "cyber", "system", "systems", "center", "centre", "dashboard", "quantum"]],
];

function chooseArt(subject: string, style: string): ArtTemplate {
  const hay = `${subject} ${style}`;
  for (const [t, words] of ART_KEYWORDS) if (hasAny(subject, words)) return t;
  for (const [t, words] of ART_KEYWORDS) if (hasAny(hay, words)) return t;
  return "abstract";
}

function isNight(hay: string): boolean {
  return hasAny(hay, ["night", "midnight", "neon", "moon", "space", "cyberpunk", "dark", "noir", "stars", "galaxy", "nebula", "storm"]);
}

/** Jagged ridge (low-poly) as a closed path to the bottom edge. */
function ridgePath(rng: Rng, W: number, H: number, baseY: number, amp: number, peaks: number, smooth: boolean): { d: string; yAt: (x: number) => number } {
  const count = peaks * 2 + 1;
  const pts: [number, number][] = [];
  for (let i = 0; i <= count; i++) {
    const x = (i / count) * W;
    const up = i % 2 === 1;
    const y = baseY - (up ? amp * range(rng, 0.55, 1) : amp * range(rng, 0.05, 0.35));
    pts.push([x, y]);
  }
  pts[0]![0] = -10;
  pts[pts.length - 1]![0] = W + 10;
  const yAt = (x: number) => {
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]!;
      const [x1, y1] = pts[i]!;
      if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
    }
    return pts[pts.length - 1]![1];
  };
  let d = `M${n(pts[0]![0])} ${n(pts[0]![1])}`;
  if (smooth) {
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]!;
      const [x1, y1] = pts[i]!;
      const mx = (x0 + x1) / 2;
      d += ` C${n(mx)} ${n(y0)} ${n(mx)} ${n(y1)} ${n(x1)} ${n(y1)}`;
    }
  } else {
    for (let i = 1; i < pts.length; i++) d += ` L${n(pts[i]![0])} ${n(pts[i]![1])}`;
  }
  d += ` L${W + 10} ${H + 10} L-10 ${H + 10} Z`;
  return { d, yAt };
}

function pine(x: number, baseY: number, h: number, fill: string): string {
  const w = h * 0.42;
  return `<g fill="${fill}"><rect x="${n(x - h * 0.03)}" y="${n(baseY - h * 0.16)}" width="${n(h * 0.06)}" height="${n(h * 0.18)}"/>` +
    `<polygon points="${n(x)},${n(baseY - h)} ${n(x + w * 0.36)},${n(baseY - h * 0.62)} ${n(x - w * 0.36)},${n(baseY - h * 0.62)}"/>` +
    `<polygon points="${n(x)},${n(baseY - h * 0.8)} ${n(x + w * 0.5)},${n(baseY - h * 0.34)} ${n(x - w * 0.5)},${n(baseY - h * 0.34)}"/>` +
    `<polygon points="${n(x)},${n(baseY - h * 0.56)} ${n(x + w * 0.62)},${n(baseY - h * 0.12)} ${n(x - w * 0.62)},${n(baseY - h * 0.12)}"/></g>`;
}

function cloud(x: number, y: number, s: number, fill: string, opacity: number): string {
  return `<g fill="${fill}" fill-opacity="${opacity}"><rect x="${n(x - s)}" y="${n(y)}" width="${n(s * 2.2)}" height="${n(s * 0.5)}" rx="${n(s * 0.25)}"/>` +
    `<circle cx="${n(x - s * 0.25)}" cy="${n(y + s * 0.05)}" r="${n(s * 0.42)}"/><circle cx="${n(x + s * 0.4)}" cy="${n(y - s * 0.08)}" r="${n(s * 0.58)}"/></g>`;
}

function stars(rng: Rng, W: number, H: number, count: number, maxY: number, color: string): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = rng() * W;
    const y = rng() * maxY;
    const r = rng() < 0.08 ? range(rng, 2.2, 3.2) : range(rng, 0.7, 1.8);
    out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${color}" fill-opacity="${n(range(rng, 0.45, 1))}"/>`);
  }
  return out.join("");
}

export interface ArtSvg { svg: string; width: number; height: number; template: ArtTemplate }

export function vectorArtSvg(subject: string, palette?: string[], opts: VectorOptions = {}): ArtSvg {
  const style = opts.style ?? "";
  const pal = designPalette(palette);
  const { width: W, height: H } = sizeFor(opts.aspectRatio, 1200, [1, 1]);
  const rng = makeRng(seedFrom(`art:${subject}:${style}`));
  const template = chooseArt(subject, style);
  const night = isNight(`${subject} ${style}`) || template === "space";
  const uid = (seedFrom(subject) % 1e6).toString(36);
  const defs: string[] = [];
  const body: string[] = [];

  const skyTop = night ? mix(darken(pal.primary, 0.78), "#050814", 0.35) : lighten(pal.secondary, 0.25);
  const skyBot = night ? darken(pal.primary, 0.35) : mix(pal.light, lighten(pal.accent, 0.6), 0.35);
  defs.push(`<linearGradient id="sky-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skyTop}"/><stop offset="1" stop-color="${skyBot}"/></linearGradient>`);

  // A warm sun reads as "sun" regardless of palette; tint it slightly on-brand.
  const sunColor = night ? "#f1f5f9" : mix("#fcd34d", pal.accent, 0.25);
  const horizon = H * 0.62;

  switch (template) {
    case "landscape": {
      body.push(`<rect width="${W}" height="${H}" fill="url(#sky-${uid})"/>`);
      if (night) body.push(stars(rng, W, H, 90, H * 0.5, "#ffffff"));
      const sx = W * range(rng, 0.62, 0.78);
      const sy = H * 0.32;
      const sr = Math.min(W, H) * 0.09;
      body.push(`<circle cx="${n(sx)}" cy="${n(sy)}" r="${n(sr * 2.1)}" fill="${sunColor}" fill-opacity="0.12"/><circle cx="${n(sx)}" cy="${n(sy)}" r="${n(sr * 1.5)}" fill="${sunColor}" fill-opacity="0.2"/><circle cx="${n(sx)}" cy="${n(sy)}" r="${n(sr)}" fill="${sunColor}"/>`);
      if (!night) {
        body.push(cloud(W * 0.22, H * 0.2, W * 0.07, "#ffffff", 0.85), cloud(W * 0.5, H * 0.12, W * 0.05, "#ffffff", 0.7));
        body.push(birds(W * 0.3, H * 0.3, W * 0.012, pal.ink, 0.55));
      }
      const layers = [
        { base: horizon, amp: H * 0.3, peaks: 3, col: mix(pal.secondary, skyBot, 0.55), smooth: false },
        { base: horizon + H * 0.08, amp: H * 0.22, peaks: 4, col: mix(pal.primary, skyBot, 0.35), smooth: false },
        { base: horizon + H * 0.2, amp: H * 0.1, peaks: 2, col: darken(pal.primary, 0.25), smooth: true },
        { base: horizon + H * 0.32, amp: H * 0.07, peaks: 2, col: darken(pal.primary, 0.55), smooth: true },
      ];
      let last: ReturnType<typeof ridgePath> | null = null;
      for (const l of layers) {
        const r = ridgePath(rng, W, H, l.base, l.amp, l.peaks, l.smooth);
        body.push(`<path d="${r.d}" fill="${l.col}"/>`);
        last = r;
        if (l === layers[2]) {
          for (let i = 0; i < 9; i++) {
            const x = range(rng, 0.02, 0.98) * W;
            body.push(pine(x, r.yAt(x) + 6, range(rng, 0.05, 0.09) * H, darken(pal.primary, 0.42)));
          }
        }
      }
      if (last) {
        for (let i = 0; i < 6; i++) {
          const x = range(rng, 0.0, 1) * W;
          body.push(pine(x, last.yAt(x) + 10, range(rng, 0.1, 0.16) * H, darken(pal.primary, 0.7)));
        }
      }
      break;
    }
    case "sea": {
      const storm = hasAny(`${subject} ${style}`, ["storm", "stormy", "rain", "thunder", "tempest"]);
      const top = storm ? mix(darken(pal.primary, 0.7), "#1f2937", 0.5) : skyTop;
      const bot = storm ? mix(darken(pal.secondary, 0.45), "#475569", 0.4) : skyBot;
      defs.push(`<linearGradient id="sky2-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bot}"/></linearGradient>`);
      body.push(`<rect width="${W}" height="${H}" fill="url(#sky2-${uid})"/>`);
      if (night && !storm) body.push(stars(rng, W, H, 70, H * 0.45, "#ffffff"));
      const sx = W * 0.3;
      if (!storm) body.push(`<circle cx="${n(sx)}" cy="${n(horizon - H * 0.12)}" r="${n(W * 0.08)}" fill="${sunColor}"/><circle cx="${n(sx)}" cy="${n(horizon - H * 0.12)}" r="${n(W * 0.13)}" fill="${sunColor}" fill-opacity="0.16"/>`);
      if (storm) {
        for (let i = 0; i < 5; i++) body.push(cloud(range(rng, 0.05, 0.95) * W, range(rng, 0.06, 0.3) * H, W * range(rng, 0.08, 0.14), darken(top, 0.2), 0.9));
        body.push(`<polyline points="${n(W * 0.66)},${n(H * 0.26)} ${n(W * 0.62)},${n(H * 0.38)} ${n(W * 0.65)},${n(H * 0.38)} ${n(W * 0.6)},${n(H * 0.5)}" fill="none" stroke="#fef9c3" stroke-width="${n(W * 0.006)}" stroke-linejoin="round" stroke-linecap="round"/>`);
        const rain: string[] = [];
        for (let i = 0; i < 70; i++) {
          const x = rng() * W;
          const y = rng() * H * 0.85;
          rain.push(`M${n(x)} ${n(y)} l${n(-W * 0.008)} ${n(H * 0.03)}`);
        }
        body.push(`<path d="${rain.join(" ")}" stroke="#e2e8f0" stroke-opacity="0.35" stroke-width="2" stroke-linecap="round"/>`);
      }
      // Sea bands.
      const seaTop = mix(pal.primary, top, 0.25);
      const bands = [seaTop, darken(pal.primary, 0.2), darken(pal.primary, 0.42), darken(pal.primary, 0.6)];
      bands.forEach((col, i) => {
        const y = horizon + i * H * 0.1;
        body.push(`<rect x="0" y="${n(y)}" width="${W}" height="${n(H - y)}" fill="${col}"/>`);
        const waves: string[] = [];
        const step = W / (8 + i * 2);
        for (let x = -step; x < W + step; x += step) waves.push(`M${n(x)} ${n(y + H * 0.02)} q${n(step / 4)} ${n(-H * 0.012)} ${n(step / 2)} 0`);
        body.push(`<path d="${waves.join(" ")}" fill="none" stroke="${lighten(col, 0.35)}" stroke-opacity="0.5" stroke-width="${n(2 + i)}" stroke-linecap="round"/>`);
      });
      if (!storm) {
        const refl: string[] = [];
        for (let i = 0; i < 6; i++) refl.push(`<rect x="${n(sx - W * (0.06 - i * 0.008))}" y="${n(horizon + 8 + i * H * 0.03)}" width="${n(W * (0.12 - i * 0.016))}" height="${n(H * 0.006)}" rx="3" fill="${sunColor}" fill-opacity="${n(0.6 - i * 0.08)}"/>`);
        body.push(refl.join(""));
      }
      if (hasAny(subject, ["lighthouse", "coast", "shore", "harbor", "harbour", "keeper"]) || storm) {
        const lx = W * 0.74;
        const rockTop = horizon + H * 0.02;
        body.push(`<path d="M${n(lx - W * 0.16)} ${H} Q${n(lx - W * 0.12)} ${n(rockTop)} ${n(lx)} ${n(rockTop - H * 0.01)} Q${n(lx + W * 0.14)} ${n(rockTop)} ${n(lx + W * 0.2)} ${H} Z" fill="${darken(pal.primary, 0.72)}"/>`);
        const th = H * 0.3;
        const tb = rockTop;
        const tw = W * 0.05;
        const tt = tw * 0.62;
        const tower = `M${n(lx - tw / 2)} ${n(tb)} L${n(lx - tt / 2)} ${n(tb - th)} L${n(lx + tt / 2)} ${n(tb - th)} L${n(lx + tw / 2)} ${n(tb)} Z`;
        defs.push(`<clipPath id="tower-${uid}"><path d="${tower}"/></clipPath>`);
        body.push(`<path d="${tower}" fill="#f8fafc"/>`);
        body.push(`<g clip-path="url(#tower-${uid})">${[0, 1, 2].map((i) => `<rect x="${n(lx - tw)}" y="${n(tb - th + th * (0.18 + i * 0.28))}" width="${n(tw * 2)}" height="${n(th * 0.13)}" fill="${storm ? "#dc2626" : pal.secondary}"/>`).join("")}</g>`);
        const lampY = tb - th;
        const beamCol = "#fef9c3";
        body.push(`<polygon points="${n(lx)},${n(lampY - H * 0.03)} ${n(-W * 0.05)},${n(lampY - H * 0.16)} ${n(-W * 0.05)},${n(lampY + H * 0.08)}" fill="${beamCol}" fill-opacity="0.18"/>`);
        body.push(`<rect x="${n(lx - tt * 0.55)}" y="${n(lampY - H * 0.05)}" width="${n(tt * 1.1)}" height="${n(H * 0.05)}" fill="${beamCol}"/>`);
        body.push(`<path d="M${n(lx - tt * 0.75)} ${n(lampY - H * 0.05)} L${n(lx)} ${n(lampY - H * 0.085)} L${n(lx + tt * 0.75)} ${n(lampY - H * 0.05)} Z" fill="${darken(pal.primary, 0.7)}"/>`);
        body.push(`<rect x="${n(lx - tt * 0.8)}" y="${n(lampY - H * 0.002)}" width="${n(tt * 1.6)}" height="${n(H * 0.012)}" fill="${darken(pal.primary, 0.7)}"/>`);
      } else if (hasAny(subject, ["boat", "sail", "sailing", "ship", "yacht"])) {
        const bx = W * 0.62;
        const by = horizon + H * 0.07;
        body.push(`<path d="M${n(bx - W * 0.07)} ${n(by)} L${n(bx + W * 0.07)} ${n(by)} L${n(bx + W * 0.05)} ${n(by + H * 0.025)} L${n(bx - W * 0.05)} ${n(by + H * 0.025)} Z" fill="${darken(pal.primary, 0.7)}"/>` +
          `<polygon points="${n(bx)},${n(by - H * 0.16)} ${n(bx)},${n(by - H * 0.01)} ${n(bx + W * 0.06)},${n(by - H * 0.01)}" fill="#f8fafc"/>` +
          `<polygon points="${n(bx - W * 0.005)},${n(by - H * 0.13)} ${n(bx - W * 0.005)},${n(by - H * 0.01)} ${n(bx - W * 0.045)},${n(by - H * 0.01)}" fill="${pal.secondary}"/>`);
      }
      if (!storm && !night) body.push(birds(W * 0.52, H * 0.22, W * 0.011, pal.ink, 0.5));
      break;
    }
    case "city": {
      body.push(`<rect width="${W}" height="${H}" fill="url(#sky-${uid})"/>`);
      if (night) body.push(stars(rng, W, H, 60, H * 0.45, "#ffffff"));
      const mx = W * 0.78;
      body.push(`<circle cx="${n(mx)}" cy="${n(H * 0.2)}" r="${n(W * 0.055)}" fill="${sunColor}"/>${night ? `<circle cx="${n(mx + W * 0.02)}" cy="${n(H * 0.19)}" r="${n(W * 0.05)}" fill="${mix(skyTop, skyBot, 0.19)}"/>` : ""}`);
      const ground = H * 0.8;
      const rows = [
        { col: mix(pal.secondary, skyBot, 0.55), hMin: 0.22, hMax: 0.42, wMin: 0.05, wMax: 0.09, windows: false },
        { col: mix(pal.primary, "#0b1020", night ? 0.55 : 0.2), hMin: 0.18, hMax: 0.5, wMin: 0.06, wMax: 0.11, windows: true },
      ];
      for (const row of rows) {
        let x = -W * 0.02;
        while (x < W) {
          const bw = range(rng, row.wMin, row.wMax) * W;
          const bh = range(rng, row.hMin, row.hMax) * H;
          const y = ground - bh;
          body.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(bw + 1)}" height="${n(bh + H)}" fill="${row.col}"/>`);
          if (rng() < 0.25) body.push(`<rect x="${n(x + bw * 0.45)}" y="${n(y - H * 0.04)}" width="${n(bw * 0.08)}" height="${n(H * 0.04)}" fill="${row.col}"/>`);
          if (row.windows) {
            const lit = night ? lighten(pal.accent, 0.3) : lighten(pal.secondary, 0.55);
            const cols = Math.max(2, Math.floor(bw / (W * 0.018)));
            const cw = bw / cols;
            const cells: string[] = [];
            for (let wy = y + H * 0.025; wy < ground - H * 0.03; wy += H * 0.032) {
              for (let c = 0; c < cols; c++) {
                if (rng() < (night ? 0.45 : 0.3)) cells.push(`<rect x="${n(x + c * cw + cw * 0.28)}" y="${n(wy)}" width="${n(cw * 0.44)}" height="${n(H * 0.014)}"/>`);
              }
            }
            body.push(`<g fill="${lit}" fill-opacity="${night ? 0.9 : 0.55}">${cells.join("")}</g>`);
          }
          x += bw + range(rng, 0, 0.01) * W;
        }
      }
      body.push(`<rect x="0" y="${n(ground)}" width="${W}" height="${n(H - ground)}" fill="${darken(pal.primary, 0.72)}"/>`);
      if (night || hasAny(`${subject} ${style}`, ["neon", "cyberpunk"])) {
        body.push(`<rect x="0" y="${n(ground)}" width="${W}" height="${n(H * 0.006)}" fill="${pal.accent}"/><rect x="0" y="${n(ground - H * 0.004)}" width="${W}" height="${n(H * 0.014)}" fill="${pal.accent}" fill-opacity="0.25"/>`);
        body.push(`<rect x="0" y="${n(ground + H * 0.08)}" width="${W}" height="${n(H * 0.004)}" fill="${pal.secondary}" fill-opacity="0.8"/>`);
      }
      const dashes: string[] = [];
      for (let x = 0; x < W; x += W * 0.08) dashes.push(`<rect x="${n(x)}" y="${n(ground + H * 0.12)}" width="${n(W * 0.04)}" height="${n(H * 0.006)}" rx="2"/>`);
      body.push(`<g fill="#f8fafc" fill-opacity="0.5">${dashes.join("")}</g>`);
      break;
    }
    case "space": {
      body.push(`<rect width="${W}" height="${H}" fill="url(#sky-${uid})"/>`);
      defs.push(`<radialGradient id="neb-${uid}"><stop offset="0" stop-color="${pal.secondary}" stop-opacity="0.45"/><stop offset="1" stop-color="${pal.secondary}" stop-opacity="0"/></radialGradient>`);
      defs.push(`<radialGradient id="neb2-${uid}"><stop offset="0" stop-color="${pal.accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${pal.accent}" stop-opacity="0"/></radialGradient>`);
      body.push(`<circle cx="${n(W * 0.25)}" cy="${n(H * 0.3)}" r="${n(W * 0.35)}" fill="url(#neb-${uid})"/><circle cx="${n(W * 0.8)}" cy="${n(H * 0.75)}" r="${n(W * 0.3)}" fill="url(#neb2-${uid})"/>`);
      body.push(stars(rng, W, H, 180, H, "#ffffff"));
      const px = W * 0.6;
      const py = H * 0.55;
      const pr = Math.min(W, H) * 0.2;
      defs.push(`<clipPath id="planet-${uid}"><circle cx="${n(px)}" cy="${n(py)}" r="${n(pr)}"/></clipPath>`);
      body.push(`<g transform="rotate(-18 ${n(px)} ${n(py)})"><path d="M${n(px - pr * 1.9)} ${n(py)} A${n(pr * 1.9)} ${n(pr * 0.45)} 0 0 1 ${n(px + pr * 1.9)} ${n(py)}" fill="none" stroke="${lighten(pal.accent, 0.2)}" stroke-width="${n(pr * 0.09)}" stroke-opacity="0.9"/></g>`);
      body.push(`<circle cx="${n(px)}" cy="${n(py)}" r="${n(pr)}" fill="${pal.primary}"/>`);
      body.push(`<g clip-path="url(#planet-${uid})">` +
        [0.25, 0.5, 0.7].map((f, i) => `<rect x="${n(px - pr)}" y="${n(py - pr + pr * 2 * f)}" width="${n(pr * 2)}" height="${n(pr * (0.12 + i * 0.04))}" fill="${i % 2 ? pal.secondary : lighten(pal.primary, 0.25)}" fill-opacity="0.8"/>`).join("") +
        `<circle cx="${n(px + pr * 0.45)}" cy="${n(py + pr * 0.35)}" r="${n(pr * 1.05)}" fill="#000000" fill-opacity="0.22"/></g>`);
      body.push(`<g transform="rotate(-18 ${n(px)} ${n(py)})"><path d="M${n(px + pr * 1.9)} ${n(py)} A${n(pr * 1.9)} ${n(pr * 0.45)} 0 0 1 ${n(px - pr * 1.9)} ${n(py)}" fill="none" stroke="${lighten(pal.accent, 0.2)}" stroke-width="${n(pr * 0.09)}"/></g>`);
      body.push(`<circle cx="${n(W * 0.2)}" cy="${n(H * 0.22)}" r="${n(pr * 0.22)}" fill="${lighten(pal.secondary, 0.4)}"/><circle cx="${n(W * 0.2 + pr * 0.07)}" cy="${n(H * 0.22 - pr * 0.05)}" r="${n(pr * 0.05)}" fill="${pal.secondary}" fill-opacity="0.6"/>`);
      if (hasAny(subject, ["rocket", "launch", "ship", "spaceship", "astronaut"])) {
        const rx = W * 0.22;
        const ry = H * 0.72;
        body.push(`<g transform="rotate(35 ${n(rx)} ${n(ry)})">` +
          `<polygon points="${n(rx - W * 0.012)},${n(ry + H * 0.07)} ${n(rx)},${n(ry + H * 0.14)} ${n(rx + W * 0.012)},${n(ry + H * 0.07)}" fill="${pal.accent}"/>` +
          `<path d="M${n(rx)} ${n(ry - H * 0.1)} C${n(rx + W * 0.04)} ${n(ry - H * 0.05)} ${n(rx + W * 0.03)} ${n(ry + H * 0.05)} ${n(rx + W * 0.022)} ${n(ry + H * 0.07)} L${n(rx - W * 0.022)} ${n(ry + H * 0.07)} C${n(rx - W * 0.03)} ${n(ry + H * 0.05)} ${n(rx - W * 0.04)} ${n(ry - H * 0.05)} ${n(rx)} ${n(ry - H * 0.1)} Z" fill="#f8fafc"/>` +
          `<circle cx="${n(rx)}" cy="${n(ry - H * 0.02)}" r="${n(W * 0.012)}" fill="${pal.primary}"/></g>`);
      } else {
        body.push(`<path d="M${n(W * 0.1)} ${n(H * 0.85)} L${n(W * 0.28)} ${n(H * 0.72)}" stroke="#ffffff" stroke-opacity="0.6" stroke-width="3" stroke-linecap="round"/><circle cx="${n(W * 0.28)}" cy="${n(H * 0.72)}" r="5" fill="#ffffff"/>`);
      }
      break;
    }
    case "forest": {
      body.push(`<rect width="${W}" height="${H}" fill="url(#sky-${uid})"/>`);
      if (night) body.push(stars(rng, W, H, 70, H * 0.4, "#ffffff"));
      body.push(`<circle cx="${n(W * 0.7)}" cy="${n(H * 0.26)}" r="${n(W * 0.07)}" fill="${sunColor}"/>`);
      const depths = 4;
      for (let d = 0; d < depths; d++) {
        const col = mix(darken(pal.primary, 0.2 + d * 0.16), skyBot, 0.6 - d * 0.18);
        const base = H * (0.55 + d * 0.13);
        body.push(`<rect x="0" y="${n(base)}" width="${W}" height="${n(H - base)}" fill="${col}"/>`);
        const count = 10 + d * 3;
        for (let i = 0; i < count; i++) {
          const x = (i / count) * W + range(rng, -0.03, 0.03) * W;
          body.push(pine(x, base + 4, H * range(rng, 0.14, 0.22) * (0.7 + d * 0.15), col));
        }
        if (d < depths - 1) body.push(`<rect x="0" y="${n(base + H * 0.02)}" width="${W}" height="${n(H * 0.06)}" fill="#ffffff" fill-opacity="0.12"/>`);
      }
      break;
    }
    case "network": {
      const bg = night || /dark|noir|mono/i.test(style) ? mix(darken(pal.primary, 0.82), "#060913", 0.4) : pal.light;
      const fg = luminance(bg) < 0.3 ? "#e2e8f0" : pal.ink;
      body.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);
      const dots: string[] = [];
      for (let x = W * 0.04; x < W; x += W * 0.04) for (let y = H * 0.04; y < H; y += H * 0.04) dots.push(`<circle cx="${n(x)}" cy="${n(y)}" r="1.4"/>`);
      body.push(`<g fill="${fg}" fill-opacity="0.12">${dots.join("")}</g>`);
      const cx = W / 2;
      const cy = H / 2;
      const R = Math.min(W, H) * 0.42;
      body.push([1, 0.72, 0.46].map((f, i) => `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R * f)}" fill="none" stroke="${i === 1 ? pal.secondary : fg}" stroke-opacity="${i === 1 ? 0.55 : 0.18}" stroke-width="${i === 1 ? 3 : 2}"${i === 0 ? ` stroke-dasharray="6 10"` : ""}/>`).join(""));
      const nodes: [number, number][] = [];
      for (let i = 0; i < 22; i++) {
        const a = rng() * Math.PI * 2;
        const r = R * Math.sqrt(range(rng, 0.05, 1));
        nodes.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      const edges: string[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const near = nodes.map((p, j) => ({ j, d: Math.hypot(p[0] - nodes[i]![0], p[1] - nodes[i]![1]) })).filter((e) => e.j !== i).sort((a, b) => a.d - b.d).slice(0, 2);
        for (const e of near) if (e.j > i || e.d > R * 0.3) edges.push(`M${n(nodes[i]![0])} ${n(nodes[i]![1])} L${n(nodes[e.j]![0])} ${n(nodes[e.j]![1])}`);
      }
      body.push(`<path d="${edges.join(" ")}" stroke="${pal.secondary}" stroke-opacity="0.55" stroke-width="2.4" fill="none"/>`);
      nodes.forEach(([x, y], i) => {
        const hot = i % 5 === 0;
        body.push(hot
          ? `<circle cx="${n(x)}" cy="${n(y)}" r="${n(R * 0.07)}" fill="${pal.accent}" fill-opacity="0.18"/><circle cx="${n(x)}" cy="${n(y)}" r="${n(R * 0.03)}" fill="${pal.accent}"/>`
          : `<circle cx="${n(x)}" cy="${n(y)}" r="${n(R * 0.018)}" fill="${fg}"/>`);
      });
      body.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R * 0.14)}" fill="${pal.primary}"/><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R * 0.14)}" fill="none" stroke="${pal.secondary}" stroke-width="4"/><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(R * 0.05)}" fill="#ffffff"/>`);
      // Radar sweep wedge.
      const a0 = -Math.PI / 2;
      const a1 = a0 + Math.PI / 5;
      body.push(`<path d="M${n(cx)} ${n(cy)} L${n(cx + Math.cos(a0) * R)} ${n(cy + Math.sin(a0) * R)} A${n(R)} ${n(R)} 0 0 1 ${n(cx + Math.cos(a1) * R)} ${n(cy + Math.sin(a1) * R)} Z" fill="${pal.secondary}" fill-opacity="0.12"/>`);
      break;
    }
    case "abstract":
    default: {
      // Swiss/Bauhaus grid of geometric tiles.
      const bg = night ? darken(pal.primary, 0.8) : pal.light;
      body.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);
      const cols = W >= H ? 4 : 3;
      const rows = Math.max(2, Math.round((cols * H) / W));
      const m = Math.min(W, H) * 0.06;
      const cw = (W - 2 * m) / cols;
      const ch = (H - 2 * m) / rows;
      const colors = [pal.primary, pal.secondary, pal.accent, pal.ink, lighten(pal.primary, 0.55)];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = m + c * cw;
          const y = m + r * ch;
          const s = Math.min(cw, ch);
          const col = pickOne(colors, rng);
          const col2 = pickOne(colors.filter((k) => k !== col), rng);
          const kind = Math.floor(rng() * 7);
          const cxm = x + cw / 2;
          const cym = y + ch / 2;
          if (rng() < 0.35) body.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(cw)}" height="${n(ch)}" fill="${col2}" fill-opacity="${night ? 0.5 : 0.18}"/>`);
          switch (kind) {
            case 0: body.push(`<circle cx="${n(cxm)}" cy="${n(cym)}" r="${n(s * 0.4)}" fill="${col}"/>`); break;
            case 1: { const rot = Math.floor(rng() * 4) * 90; body.push(`<path d="M${n(x)} ${n(y)} L${n(x + s)} ${n(y)} A${n(s)} ${n(s)} 0 0 1 ${n(x)} ${n(y + s)} Z" transform="rotate(${rot} ${n(x + s / 2)} ${n(y + s / 2)})" fill="${col}"/>`); break; }
            case 2: body.push(`<path d="M${n(x)} ${n(y + ch)} A${n(cw / 2)} ${n(cw / 2)} 0 0 1 ${n(x + cw)} ${n(y + ch)} Z" fill="${col}"/>`); break;
            case 3: body.push(`<polygon points="${n(x)},${n(y + ch)} ${n(cxm)},${n(y)} ${n(x + cw)},${n(y + ch)}" fill="${col}"/>`); break;
            case 4: { const k = 5; for (let i = 0; i < k; i++) body.push(`<rect x="${n(x)}" y="${n(y + (i * ch) / k)}" width="${n(cw)}" height="${n(ch / k / 2)}" fill="${col}"/>`); break; }
            case 5: body.push(`<circle cx="${n(cxm)}" cy="${n(cym)}" r="${n(s * 0.4)}" fill="none" stroke="${col}" stroke-width="${n(s * 0.1)}"/><circle cx="${n(cxm)}" cy="${n(cym)}" r="${n(s * 0.12)}" fill="${col2}"/>`); break;
            default: body.push(`<rect x="${n(x + cw * 0.18)}" y="${n(y + ch * 0.18)}" width="${n(cw * 0.64)}" height="${n(ch * 0.64)}" fill="${col}" transform="rotate(45 ${n(cxm)} ${n(cym)})"/>`);
          }
        }
      }
    }
  }

  const svg = svgDoc(W, H, body.join("\n"), {
    title: `${titleCase(subject)} — vector art`,
    desc: `Flat vector illustration (${template}) for "${subject}"${style ? `, style: ${style}` : ""}.`,
    defs: defs.join(""),
  });
  return { svg, width: W, height: H, template };
}

function birds(x: number, y: number, s: number, color: string, opacity: number): string {
  const b = (dx: number, dy: number, k: number) => `M${n(x + dx)} ${n(y + dy)} q${n(s * k)} ${n(-s * k)} ${n(s * 2 * k)} 0 q${n(s * k)} ${n(-s * k)} ${n(s * 2 * k)} 0`;
  return `<path d="${b(0, 0, 1)} ${b(s * 6, s * 2, 0.8)} ${b(s * 3, s * 5, 0.7)}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${n(Math.max(1.5, s * 0.35))}" stroke-linecap="round"/>`;
}

export function generateVectorArtSvg(subject: string, palette: string[] | undefined, dest: string, opts: VectorOptions = {}): VectorResult {
  const out = vectorArtSvg(subject, palette, opts);
  write(dest, out.svg);
  return { width: out.width, height: out.height, notes: [`template=${out.template}`] };
}

// ════════════════════════════════════════════════════════════════════════════
// UI mockups (implementation in ui-mockup.ts)
// ════════════════════════════════════════════════════════════════════════════

export function generateUiMockupSvg(subject: string, palette: string[] | undefined, dest: string, opts: VectorOptions = {}): VectorResult {
  const out = uiMockupSvg(subject, palette, opts);
  write(dest, out.svg);
  return { width: out.width, height: out.height, notes: [`screen=${out.screen}`, `device=${out.device}`] };
}

// ════════════════════════════════════════════════════════════════════════════
// Photo placeholder
// ════════════════════════════════════════════════════════════════════════════

export function photoPlaceholderSvg(subject: string, palette: string[] | undefined, width: number, height: number, opts: VectorOptions & { hint?: string } = {}): string {
  const pal = designPalette(palette);
  const W = Math.max(64, Math.round(width));
  const H = Math.max(64, Math.round(height));
  const uid = (seedFrom(subject) % 1e6).toString(36);
  const rng = makeRng(seedFrom(`photo:${subject}`));
  const top = mix(darken(pal.primary, 0.55), "#0b1020", 0.35);
  const bot = mix(pal.secondary, top, 0.45);
  const u = Math.min(W, H);
  const m = u * 0.06;
  const defs = `<linearGradient id="bg-${uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bot}"/></linearGradient>` +
    `<radialGradient id="glow-${uid}" cx="0.7" cy="0.3" r="0.6"><stop offset="0" stop-color="${lighten(pal.accent, 0.3)}" stop-opacity="0.35"/><stop offset="1" stop-color="${pal.accent}" stop-opacity="0"/></radialGradient>`;
  const ridge = ridgePath(rng, W, H, H * 0.78, H * 0.16, 3, true);
  const ridge2 = ridgePath(rng, W, H, H * 0.88, H * 0.1, 2, true);
  const bracket = (x: number, y: number, dx: number, dy: number) => `M${n(x)} ${n(y + dy * u * 0.06)} L${n(x)} ${n(y)} L${n(x + dx * u * 0.06)} ${n(y)}`;
  const title = titleCase(subject);
  const titleSize = Math.min(u * 0.075, fitFontSize(title, W * 0.8, u * 0.075, { bold: true }));
  const lines = wrapText(title, titleSize, W * 0.8, 2, true);
  const hint = opts.hint ?? "Placeholder — enable an image provider (HF_IMAGE_MODEL / REPLICATE_IMAGE_MODEL) and generative:true for a real photo.";
  const hintSize = Math.max(11, u * 0.022);
  const cy = H * 0.46 - ((lines.length - 1) * titleSize * 1.15) / 2;
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#bg-${uid})"/>`,
    `<rect width="${W}" height="${H}" fill="url(#glow-${uid})"/>`,
    `<path d="${ridge.d}" fill="#000000" fill-opacity="0.18"/>`,
    `<path d="${ridge2.d}" fill="#000000" fill-opacity="0.22"/>`,
    `<g stroke="#ffffff" stroke-opacity="0.12" stroke-width="1"><path d="M${n(W / 3)} 0 V${H} M${n((2 * W) / 3)} 0 V${H} M0 ${n(H / 3)} H${W} M0 ${n((2 * H) / 3)} H${W}"/></g>`,
    `<path d="${bracket(m, m, 1, 1)} ${bracket(W - m, m, -1, 1)} ${bracket(m, H - m, 1, -1)} ${bracket(W - m, H - m, -1, -1)}" fill="none" stroke="#ffffff" stroke-opacity="0.8" stroke-width="${n(Math.max(2, u * 0.005))}" stroke-linecap="round"/>`,
    `<g fill="#ffffff"><circle cx="${n(W / 2)}" cy="${n(H / 2)}" r="${n(u * 0.004 + 1.5)}" fill-opacity="0.5"/></g>`,
    `<text x="${n(W / 2)}" y="${n(cy - titleSize * 1.2)}" font-family="${esc(FONT_SANS)}" font-size="${n(Math.max(10, u * 0.022))}" font-weight="600" fill="#ffffff" fill-opacity="0.75" text-anchor="middle" letter-spacing="${n(u * 0.006)}">PHOTO PLACEHOLDER · ${W}×${H}</text>`,
    ...lines.map((l, i) => `<text x="${n(W / 2)}" y="${n(cy + i * titleSize * 1.15 + titleSize * 0.35)}" font-family="${esc(FONT_SANS)}" font-size="${n(titleSize)}" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(l)}</text>`),
    ...wrapText(hint, hintSize, W * 0.8, 2).map((l, i) => `<text x="${n(W / 2)}" y="${n(H - m - u * 0.04 - (1 - i) * hintSize * 1.4)}" font-family="${esc(FONT_SANS)}" font-size="${n(hintSize)}" fill="#ffffff" fill-opacity="0.7" text-anchor="middle">${esc(l)}</text>`),
  ];
  return svgDoc(W, H, body.join("\n"), { title: `${title} (placeholder)`, desc: `Labelled placeholder for a photo of: ${subject}`, defs });
}

export function generatePhotoPlaceholderSvg(subject: string, palette: string[] | undefined, dest: string, width: number, height: number, opts: VectorOptions & { hint?: string } = {}): { width: number; height: number } {
  const W = Math.max(64, Math.round(width));
  const H = Math.max(64, Math.round(height));
  write(dest, photoPlaceholderSvg(subject, palette, W, H, opts));
  return { width: W, height: H };
}

// ════════════════════════════════════════════════════════════════════════════
// Storyboard frame (offline animatic for the video pipeline)
// ════════════════════════════════════════════════════════════════════════════

export interface StoryboardFrameInput {
  filmTitle: string;
  sceneHeading: string;
  shotId: string;
  shotNumber: number;
  shotCount: number;
  action: string;
  framing: string;
  cameraMovement: string;
  lighting: string;
  subjectPosition: string;
  palette: string[];
  durationSeconds: number;
  /** Subject keywords, used to pick a silhouette (tower, skyline, figure…). */
  keywords: string[];
  footer?: string;
}

type Silhouette = "figure" | "tower" | "skyline" | "peaks" | "trees" | "vehicle" | "orb";

function silhouetteFor(words: string[]): Silhouette {
  const hay = words.join(" ");
  if (hasAny(hay, ["lighthouse", "tower", "castle", "spire", "church", "monument"])) return "tower";
  if (hasAny(hay, ["city", "skyline", "street", "building", "urban", "downtown", "neon", "alley"])) return "skyline";
  if (hasAny(hay, ["mountain", "peak", "valley", "hill", "cliff", "canyon", "desert"])) return "peaks";
  if (hasAny(hay, ["forest", "tree", "woods", "jungle", "garden", "park"])) return "trees";
  if (hasAny(hay, ["car", "truck", "train", "bike", "motorcycle", "boat", "ship", "plane", "vehicle"])) return "vehicle";
  if (hasAny(hay, ["man", "woman", "girl", "boy", "person", "keeper", "hero", "detective", "character", "runner", "chef", "child", "friend", "father", "mother", "soldier", "dancer", "worker", "people", "crowd", "family", "astronaut", "robot"])) return "figure";
  return "orb";
}

function framingScale(framing: string): number {
  const f = framing.toLowerCase();
  if (f.includes("extreme close")) return 2.4;
  if (f.includes("close")) return 1.8;
  if (f.includes("over-the-shoulder")) return 1.3;
  if (f.includes("medium wide")) return 0.9;
  if (f.includes("medium")) return 1.2;
  if (f.includes("extreme wide")) return 0.45;
  return 0.65;
}

function positionX(pos: string, W: number): number {
  const p = pos.toLowerCase();
  if (p.includes("left")) return W / 3;
  if (p.includes("right")) return (2 * W) / 3;
  return W / 2;
}

export function storyboardFrameSvg(f: StoryboardFrameInput, width: number, height: number): string {
  const W = Math.max(160, Math.round(width));
  const H = Math.max(90, Math.round(height));
  const u = Math.min(W, H);
  const colors = f.palette.length ? f.palette : ["#0b1f3a", "#1e6091", "#e0fbfc"];
  const sorted = [...colors].sort((a, b) => luminance(a) - luminance(b));
  const dark = sorted[0]!;
  const mid = sorted[Math.floor(sorted.length / 2)]!;
  const light = sorted[sorted.length - 1]!;
  const uid = (seedFrom(f.shotId) % 1e6).toString(36);
  const rng = makeRng(seedFrom(`sb:${f.shotId}:${f.action}`));
  const defs = `<linearGradient id="g-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mix(dark, "#000000", 0.25)}"/><stop offset="0.62" stop-color="${mix(mid, dark, 0.35)}"/><stop offset="1" stop-color="${mix(dark, "#000000", 0.45)}"/></linearGradient>` +
    `<linearGradient id="shade-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0.5" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.75"/></linearGradient>` +
    `<radialGradient id="key-${uid}" cx="0.72" cy="0.28" r="0.55"><stop offset="0" stop-color="${light}" stop-opacity="0.35"/><stop offset="1" stop-color="${light}" stop-opacity="0"/></radialGradient>`;

  const scale = framingScale(f.framing);
  const sil = silhouetteFor([...f.keywords, f.action]);
  const sx = positionX(f.subjectPosition, W);
  const horizon = H * (scale > 1.5 ? 0.8 : 0.64);
  const ink = mix(dark, "#000000", 0.55);
  const art: string[] = [];
  art.push(`<rect x="0" y="${n(horizon)}" width="${W}" height="${n(H - horizon)}" fill="${ink}" fill-opacity="0.55"/>`);
  art.push(`<path d="${ridgePath(rng, W, H, horizon, H * 0.08, 3, true).d}" fill="${ink}" fill-opacity="0.5"/>`);
  const k = u * 0.22 * scale;
  switch (sil) {
    case "tower":
      art.push(`<polygon points="${n(sx - k * 0.22)},${n(horizon)} ${n(sx - k * 0.14)},${n(horizon - k * 1.6)} ${n(sx + k * 0.14)},${n(horizon - k * 1.6)} ${n(sx + k * 0.22)},${n(horizon)}" fill="${ink}"/>` +
        `<rect x="${n(sx - k * 0.12)}" y="${n(horizon - k * 1.82)}" width="${n(k * 0.24)}" height="${n(k * 0.22)}" fill="${light}" fill-opacity="0.9"/>` +
        `<polygon points="${n(sx)},${n(horizon - k * 1.72)} ${n(0)},${n(horizon - k * 2.3)} ${n(0)},${n(horizon - k * 1.3)}" fill="${light}" fill-opacity="0.12"/>`);
      break;
    case "skyline": {
      let x = sx - k * 1.6;
      const blocks: string[] = [];
      while (x < sx + k * 1.6) {
        const bw = k * range(rng, 0.18, 0.34);
        const bh = k * range(rng, 0.6, 1.6);
        blocks.push(`<rect x="${n(x)}" y="${n(horizon - bh)}" width="${n(bw)}" height="${n(bh + 1)}"/>`);
        x += bw + k * 0.03;
      }
      art.push(`<g fill="${ink}">${blocks.join("")}</g>`);
      break;
    }
    case "peaks":
      art.push(`<polygon points="${n(sx - k * 1.6)},${n(horizon)} ${n(sx - k * 0.2)},${n(horizon - k * 1.2)} ${n(sx + k * 1.2)},${n(horizon)}" fill="${ink}"/><polygon points="${n(sx)},${n(horizon)} ${n(sx + k * 0.8)},${n(horizon - k * 0.8)} ${n(sx + k * 1.8)},${n(horizon)}" fill="${mix(ink, mid, 0.25)}"/>`);
      break;
    case "trees":
      for (let i = -3; i <= 3; i++) art.push(pine(sx + i * k * 0.35, horizon + 2, k * range(rng, 0.7, 1.2), ink));
      break;
    case "vehicle":
      art.push(`<rect x="${n(sx - k * 0.8)}" y="${n(horizon - k * 0.42)}" width="${n(k * 1.6)}" height="${n(k * 0.32)}" rx="${n(k * 0.08)}" fill="${ink}"/><path d="M${n(sx - k * 0.45)} ${n(horizon - k * 0.42)} L${n(sx - k * 0.25)} ${n(horizon - k * 0.7)} L${n(sx + k * 0.35)} ${n(horizon - k * 0.7)} L${n(sx + k * 0.55)} ${n(horizon - k * 0.42)} Z" fill="${ink}"/><circle cx="${n(sx - k * 0.45)}" cy="${n(horizon - k * 0.1)}" r="${n(k * 0.15)}" fill="${ink}"/><circle cx="${n(sx + k * 0.45)}" cy="${n(horizon - k * 0.1)}" r="${n(k * 0.15)}" fill="${ink}"/>`);
      break;
    case "figure": {
      const hr = k * 0.2;
      const top = horizon - k * 1.25;
      art.push(`<g fill="${ink}"><circle cx="${n(sx)}" cy="${n(top + hr)}" r="${n(hr)}"/><path d="M${n(sx - k * 0.36)} ${n(horizon + k)} L${n(sx - k * 0.36)} ${n(top + hr * 3.2)} Q${n(sx - k * 0.36)} ${n(top + hr * 2.3)} ${n(sx)} ${n(top + hr * 2.3)} Q${n(sx + k * 0.36)} ${n(top + hr * 2.3)} ${n(sx + k * 0.36)} ${n(top + hr * 3.2)} L${n(sx + k * 0.36)} ${n(horizon + k)} Z"/></g>`);
      break;
    }
    case "orb":
    default:
      art.push(`<circle cx="${n(sx)}" cy="${n(horizon - k * 0.5)}" r="${n(k * 0.5)}" fill="${ink}"/><circle cx="${n(sx)}" cy="${n(horizon - k * 0.5)}" r="${n(k * 0.8)}" fill="none" stroke="${light}" stroke-opacity="0.25" stroke-width="${n(u * 0.004)}"/>`);
  }

  // Title-safe layout: all text sits in the TOP band inside ~9% margins, so the
  // bottom quarter stays clear for burned-in captions and Ken Burns motion
  // never crops a word.
  const mx = W * 0.09;
  const my = H * 0.08;
  const chip = u * 0.03;
  const bracket = (x: number, y: number, dx: number, dy: number) => `M${n(x)} ${n(y + dy * u * 0.05)} L${n(x)} ${n(y)} L${n(x + dx * u * 0.05)} ${n(y)}`;
  const headSize = u * 0.034;
  const actionSize = u * 0.04;
  const metaSize = u * 0.025;
  const textW = W * 0.64; // leave the top-right corner for duration, swatches and footer
  const action = wrapText(f.action, actionSize, textW, 3, true);
  const chipY = my;
  const headY = chipY + chip * 1.25 + headSize * 1.9;
  const actionY = headY + actionSize * 1.45;
  const metaY = actionY + (action.length - 1) * actionSize * 1.22 + metaSize * 2;
  const swatch = u * 0.03;
  const text = (x: number, y: number, s: string, size: number, weight: number, fill: string, anchor = "start", extra = "") =>
    `<text x="${n(x)}" y="${n(y)}" font-family="${esc(FONT_SANS)}" font-size="${n(size)}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${extra}>${esc(s)}</text>`;
  const meta = `${titleCase(f.framing)} · ${f.cameraMovement} · ${f.lighting}`;
  const metaLine = wrapText(meta, metaSize, textW, 1)[0] ?? meta;
  const topShade = `<linearGradient id="top-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0.7"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></linearGradient>`;
  const bm = u * 0.05;
  const chipLabel = `SHOT ${f.shotNumber}/${f.shotCount}`;
  const body = [
    `<defs>${topShade}</defs>`,
    `<rect width="${W}" height="${H}" fill="url(#g-${uid})"/>`,
    `<rect width="${W}" height="${H}" fill="url(#key-${uid})"/>`,
    ...art,
    `<rect width="${W}" height="${H}" fill="url(#shade-${uid})"/>`,
    `<rect width="${W}" height="${n(metaY + metaSize * 2.5)}" fill="url(#top-${uid})"/>`,
    `<g stroke="#ffffff" stroke-opacity="0.1" stroke-width="1"><path d="M${n(W / 3)} 0 V${H} M${n((2 * W) / 3)} 0 V${H} M0 ${n(H / 3)} H${W} M0 ${n((2 * H) / 3)} H${W}"/></g>`,
    `<path d="${bracket(bm, bm, 1, 1)} ${bracket(W - bm, bm, -1, 1)} ${bracket(bm, H - bm, 1, -1)} ${bracket(W - bm, H - bm, -1, -1)}" fill="none" stroke="#ffffff" stroke-opacity="0.45" stroke-width="${n(Math.max(1.5, u * 0.004))}"/>`,
    `<rect x="${n(mx)}" y="${n(chipY)}" width="${n(textWidth(chipLabel, chip * 0.62, { bold: true }) + chip * 1.2)}" height="${n(chip * 1.25)}" rx="${n(chip * 0.3)}" fill="${light}" fill-opacity="0.9"/>`,
    text(mx + chip * 0.6, chipY + chip * 0.85, chipLabel, chip * 0.62, 700, mix(dark, "#000000", 0.4), "start", ` letter-spacing="${n(chip * 0.06)}"`),
    text(W - mx, chipY + chip * 0.85, `${f.durationSeconds.toFixed(1)}s · ${f.filmTitle.toUpperCase()}`, chip * 0.62, 600, "#ffffff", "end", ` fill-opacity="0.8" letter-spacing="${n(chip * 0.06)}"`),
    text(mx, headY, f.sceneHeading.toUpperCase(), headSize, 700, light, "start", ` letter-spacing="${n(headSize * 0.08)}"`),
    ...action.map((l, i) => text(mx, actionY + i * actionSize * 1.22, l, actionSize, 700, "#ffffff")),
    text(mx, metaY, metaLine, metaSize, 400, "#ffffff", "start", ` fill-opacity="0.75"`),
    ...colors.slice(0, 4).map((c, i) => `<rect x="${n(W - mx - (colors.slice(0, 4).length - i) * (swatch + 6) + 6)}" y="${n(chipY + chip * 1.9)}" width="${n(swatch)}" height="${n(swatch)}" rx="${n(swatch * 0.2)}" fill="${c}" stroke="#ffffff" stroke-opacity="0.6" stroke-width="1.5"/>`),
    f.footer ? text(W - mx, chipY + chip * 1.9 + swatch + metaSize * 1.2, f.footer, metaSize * 0.72, 500, "#ffffff", "end", ` fill-opacity="0.55"`) : "",
  ];
  return svgDoc(W, H, body.filter(Boolean).join("\n"), {
    title: `${f.filmTitle} — ${f.shotId}`,
    desc: `Storyboard placeholder: ${f.action}`,
    defs,
  });
}

export function generateStoryboardFrameSvg(f: StoryboardFrameInput, dest: string, width: number, height: number): { width: number; height: number } {
  const svg = storyboardFrameSvg(f, width, height);
  write(dest, svg);
  return { width: Math.max(160, Math.round(width)), height: Math.max(90, Math.round(height)) };
}
