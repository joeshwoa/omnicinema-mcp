/**
 * Script & Continuity Engine.
 *
 * Generates a multi-scene screenplay from a text prompt. Every shot carries an
 * explicit opening and closing ContinuityFrame; the engine guarantees that each
 * shot's opening frame is IDENTICAL to the previous shot's closing frame, so the
 * downstream montage cuts on matching frame descriptions ("continuity layout
 * matching preceding clip ending frames").
 *
 * The core generator is fully deterministic (seeded) so runs are reproducible
 * and testable offline. If ANTHROPIC_API_KEY is set, `enrichScreenplay` can call
 * the Anthropic Messages API to rewrite the scaffold into richer prose — this is
 * strictly optional and fails safe back to the deterministic output.
 */
import { env } from "../config.js";
import { log } from "../logger.js";
import type { ContinuityFrame, Scene, Screenplay, Shot } from "../types.js";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "with", "as", "by", "from", "into", "about", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "being", "been", "it", "its", "video",
  "cinematic", "scene", "clip", "make", "create", "generate", "show", "showing",
]);

const FRAMINGS = [
  "extreme wide", "wide establishing", "medium wide", "medium",
  "medium close-up", "close-up", "extreme close-up", "over-the-shoulder",
];

const MOVEMENTS = [
  "static locked-off", "slow push-in", "slow pull-out", "gentle pan left",
  "gentle pan right", "handheld drift", "crane up", "tracking follow",
];

const LIGHTINGS: { mood: string; time: string }[] = [
  { mood: "low-key blue dusk with a cold rim light", time: "DUSK" },
  { mood: "warm golden-hour backlight and long shadows", time: "GOLDEN HOUR" },
  { mood: "hard noon key with deep contrasty shadows", time: "DAY" },
  { mood: "soft overcast diffusion, flat and even", time: "DAY" },
  { mood: "neon magenta-and-cyan wash over wet surfaces", time: "NIGHT" },
  { mood: "cold moonlight filtering through haze", time: "NIGHT" },
  { mood: "candlelit amber glow, gentle flicker", time: "NIGHT" },
  { mood: "high-key studio softbox, clean and bright", time: "DAY" },
];

const PALETTES: string[][] = [
  ["#0b1f3a", "#1e6091", "#e0fbfc"],
  ["#3d1f00", "#c8791d", "#ffd6a5"],
  ["#1a1a2e", "#e94560", "#0f3460"],
  ["#2b2d42", "#8d99ae", "#edf2f4"],
  ["#22223b", "#4a4e69", "#f2e9e4"],
  ["#081c15", "#2d6a4f", "#95d5b2"],
  ["#03071e", "#dc2f02", "#ffba08"],
  ["#10002b", "#7b2cbf", "#e0aaff"],
];

const SUBJECT_POSITIONS = [
  "centered on the horizon line",
  "framed on the left third",
  "framed on the right third",
  "a foreground silhouette against depth",
  "small against a vast background",
  "filling the frame edge to edge",
  "entering from screen right",
  "settling into the lower third",
];

const CAMERA_ACTIONS = [
  "establishes the space",
  "reveals the subject",
  "follows the motion",
  "holds on a detail",
  "widens to context",
  "isolates a reaction",
  "drifts across the setting",
  "settles for a beat",
];

/** Deterministic RNG (mulberry32) so the same prompt yields the same film. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** Extract salient, de-duplicated keywords from a free-text prompt. */
export function keywordsFromPrompt(prompt: string): string[] {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out.length ? out : ["landscape", "atmosphere", "light"];
}

export interface ScriptOptions {
  prompt: string;
  sceneCount?: number;
  shotsPerScene?: number;
  shotDurationSeconds?: number;
  style?: string;
  fps: number;
  width: number;
  height: number;
}

function buildFrame(
  keywords: string[],
  rng: () => number,
  lighting: { mood: string; time: string },
  palette: string[],
): ContinuityFrame {
  const subject = keywords[Math.floor(rng() * keywords.length)] ?? "subject";
  return {
    composition: `${titleCase(subject)} ${pick(SUBJECT_POSITIONS, rng)}`,
    framing: pick(FRAMINGS, rng),
    lighting: lighting.mood,
    palette: [...palette],
    subjectPosition: pick(SUBJECT_POSITIONS, rng),
  };
}

/** Evolve a frame slightly to produce a plausible closing frame from an opening. */
function evolveFrame(frame: ContinuityFrame, rng: () => number): ContinuityFrame {
  return {
    composition: frame.composition,
    framing: pick(FRAMINGS, rng),
    lighting: frame.lighting, // lighting stays continuous within a shot
    palette: [...frame.palette],
    subjectPosition: pick(SUBJECT_POSITIONS, rng),
  };
}

/**
 * Build the deterministic screenplay scaffold. Guarantees global continuity:
 * for every shot after the first, openingFrame === previous shot's closingFrame.
 */
export function buildScreenplay(opts: ScriptOptions): Screenplay {
  const keywords = keywordsFromPrompt(opts.prompt);
  const rng = makeRng(seedFromString(opts.prompt));

  const sceneCount = clamp(opts.sceneCount ?? defaultSceneCount(keywords.length), 1, 12);
  const shotsPerScene = clamp(opts.shotsPerScene ?? 2, 1, 6);
  const shotDuration = clamp(opts.shotDurationSeconds ?? 4, 1, 30);
  const style = opts.style?.trim() || "modern cinematic";

  const title = titleCase(keywords.slice(0, 3).join(" ")) || "Untitled Film";
  const logline = `A ${style} short built from the concept: "${opts.prompt.trim()}".`;

  const scenes: Scene[] = [];
  // The running continuity frame: each new shot opens exactly where the last closed.
  let carryFrame: ContinuityFrame | null = null;
  let globalShotIndex = 0;

  for (let s = 0; s < sceneCount; s++) {
    const lighting = pick(LIGHTINGS, rng);
    const palette = pick(PALETTES, rng);
    const locWord = keywords[(s + 1) % keywords.length] ?? "location";
    const interiorExterior = rng() > 0.5 ? "EXT." : "INT.";
    const heading = `${interiorExterior} ${titleCase(locWord)} — ${lighting.time}`;
    const sceneId = `scene-${s + 1}`;
    const shots: Shot[] = [];

    for (let k = 0; k < shotsPerScene; k++) {
      const shotId = `${sceneId}-shot-${k + 1}`;
      const opening: ContinuityFrame =
        carryFrame ?? buildFrame(keywords, rng, lighting, palette);
      const closing = evolveFrame(
        // Re-key the opening's lighting/palette to this scene for shot 1 of a scene.
        k === 0 && carryFrame
          ? { ...opening, lighting: lighting.mood, palette: [...palette] }
          : opening,
        rng,
      );

      const subjectKw = keywords[(globalShotIndex) % keywords.length] ?? "subject";
      const shotKeywords = dedupe([
        subjectKw,
        locWord,
        ...keywords.slice(0, 2),
        style.split(" ")[0] ?? "cinematic",
      ]);

      const shot: Shot = {
        id: shotId,
        sceneId,
        index: globalShotIndex,
        action: `Camera ${pick(MOVEMENTS, rng)} — ${pick(CAMERA_ACTIONS, rng)} of ${subjectKw}, ${lighting.mood}.`,
        cameraMovement: pick(MOVEMENTS, rng),
        durationSeconds: shotDuration,
        openingFrame: opening,
        closingFrame: closing,
        keywords: shotKeywords,
        assetQuery: `${subjectKw} ${locWord} ${style}`.trim(),
      };
      shots.push(shot);
      carryFrame = closing; // next shot opens here → guaranteed continuity
      globalShotIndex++;
    }

    scenes.push({
      id: sceneId,
      index: s,
      heading,
      summary: `${titleCase(locWord)} sequence: ${shotsPerScene} shot(s) under ${lighting.mood}.`,
      shots,
    });
  }

  return {
    title,
    logline,
    prompt: opts.prompt.trim(),
    style,
    fps: opts.fps,
    width: opts.width,
    height: opts.height,
    scenes,
    enriched: false,
  };
}

function defaultSceneCount(keywordCount: number): number {
  return clamp(Math.round(keywordCount / 2), 2, 5);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

/**
 * Verify the continuity invariant across the whole screenplay. Returns a list of
 * violations (empty means every cut matches on its frame description).
 */
export function verifyContinuity(screenplay: Screenplay): string[] {
  const violations: string[] = [];
  const flat: Shot[] = screenplay.scenes.flatMap((sc) => sc.shots);
  for (let i = 1; i < flat.length; i++) {
    const prev = flat[i - 1]!;
    const cur = flat[i]!;
    if (frameKey(prev.closingFrame) !== frameKey(cur.openingFrame)) {
      violations.push(
        `Continuity break between ${prev.id} (closing) and ${cur.id} (opening).`,
      );
    }
  }
  return violations;
}

function frameKey(f: ContinuityFrame): string {
  return JSON.stringify([f.composition, f.framing, f.lighting, f.palette, f.subjectPosition]);
}

/**
 * Optional LLM enrichment via the Anthropic Messages API. Rewrites the logline,
 * scene summaries, and shot actions into richer prose while preserving structure
 * and the continuity frames. Fails safe: on any error the input is returned.
 */
export async function enrichScreenplay(screenplay: Screenplay): Promise<Screenplay> {
  const key = env.anthropic();
  if (!key) return screenplay;

  const model = env.anthropicModel();
  const shotList = screenplay.scenes
    .flatMap((sc) => sc.shots.map((sh) => `${sh.id}: ${sh.action}`))
    .join("\n");

  const system =
    "You are a film script doctor. Rewrite the given logline, scene summaries, " +
    "and shot actions into vivid, concise, production-ready prose. Preserve all " +
    "ids exactly. Respond with STRICT JSON only, no markdown.";
  const userPrompt =
    `Concept: ${screenplay.prompt}\nStyle: ${screenplay.style}\n\n` +
    `Logline: ${screenplay.logline}\n\nShots:\n${shotList}\n\n` +
    `Return JSON: {"logline": string, "shots": {"<id>": "<rewritten action>"}}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      log.warn(`LLM enrichment skipped: HTTP ${res.status}`);
      return screenplay;
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(extractJson(text)) as {
      logline?: string;
      shots?: Record<string, string>;
    };
    const next: Screenplay = structuredClone(screenplay);
    if (parsed.logline) next.logline = parsed.logline;
    if (parsed.shots) {
      for (const scene of next.scenes) {
        for (const shot of scene.shots) {
          const rewritten = parsed.shots[shot.id];
          if (rewritten) shot.action = rewritten;
        }
      }
    }
    next.enriched = true;
    log.info("Screenplay enriched via Anthropic API.");
    return next;
  } catch (err) {
    log.warn("LLM enrichment failed; using deterministic scaffold.", String(err));
    return screenplay;
  }
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return "{}";
  return text.slice(start, end + 1);
}
