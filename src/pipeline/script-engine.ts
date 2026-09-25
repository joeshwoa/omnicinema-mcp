/**
 * Script & Continuity Engine.
 *
 * Turns a one-line concept into a coherent multi-scene screenplay, fully
 * offline and deterministically (seeded by the prompt):
 *
 *   1. Parse the concept into subject ("lone lighthouse keeper"), action
 *      ("watching a storm roll in…"), setting ("cold northern sea"), a story
 *      element ("storm"), and mood cues.
 *   2. Pick ONE lighting look for the film (storm, night, neon, golden, cold,
 *      natural, noir, cinematic) and progress it across scenes (e.g. dusk →
 *      storm night → grey dawn) with matching palettes.
 *   3. Lay scenes on a story arc (setup → inciting → rising → climax →
 *      resolution) and shots on film grammar (establishing → medium → close).
 *   4. Chain continuity: every shot's opening frame is IDENTICAL to the
 *      previous shot's closing frame; each shot's camera move is derived from
 *      the framing change it has to make (tighter = push-in, looser =
 *      pull-out/crane), and screen direction is held (180° rule).
 *
 * If ANTHROPIC_API_KEY is set, `enrichScreenplay` can optionally rewrite the
 * prose via the Anthropic API — strictly opt-in and fail-safe.
 */
import { env } from "../config.js";
import { log } from "../logger.js";
import type { ContinuityFrame, Scene, Screenplay, Shot } from "../types.js";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "with", "as", "by", "from", "into", "about", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "being", "been", "it", "its", "video",
  "cinematic", "scene", "clip", "make", "create", "generate", "show", "showing",
  "over", "under", "through", "across", "near", "while", "who", "his", "her", "their",
]);

const PREPOSITIONS = new Set([
  "in", "on", "at", "over", "across", "through", "under", "near", "inside", "beneath", "by", "along",
  "into", "from", "above", "during", "against", "among", "around", "beside", "below", "within", "toward", "towards", "past",
]);
const DETERMINERS = new Set(["a", "an", "the", "his", "her", "their", "its", "our", "my", "some", "one", "two", "three"]);
const VERBS = new Set([
  "is", "are", "was", "walks", "runs", "watches", "stands", "sits", "waits", "looks", "flies", "drives", "rides",
  "finds", "meets", "fights", "dances", "sings", "plays", "races", "climbs", "falls", "rises", "wanders", "explores",
  "discovers", "returns", "leaves", "builds", "makes", "cooks", "paints", "writes", "reads", "sails", "swims",
  "chases", "escapes", "searches", "tries", "learns", "keeps", "guards", "crosses", "hides", "who", "that", "which",
  "roll", "rolls", "comes", "goes", "moves", "drifts", "glows", "burns", "shines",
]);
const ING_NOUNS = new Set(["building", "morning", "evening", "king", "ring", "thing", "painting", "wedding", "ceiling", "ending", "spring", "string", "clothing", "wing", "sibling", "pudding", "ceiling", "lightning", "offering", "setting"]);
const TIME_WORDS = new Set(["night", "midnight", "dawn", "dusk", "sunset", "sunrise", "morning", "evening", "noon", "day", "twilight", "tonight"]);
const PERSON = new Set([
  "man", "woman", "girl", "boy", "child", "kid", "person", "people", "keeper", "hero", "heroine", "detective", "character",
  "runner", "chef", "friend", "father", "mother", "dad", "mom", "soldier", "dancer", "worker", "family", "astronaut",
  "robot", "sailor", "fisherman", "artist", "musician", "pilot", "driver", "farmer", "doctor", "nurse", "student",
  "teacher", "traveler", "traveller", "explorer", "stranger", "couple", "grandmother", "grandfather", "knight",
  "warrior", "wizard", "witch", "queen", "princess", "prince", "monk", "surfer", "climber", "skater", "cyclist",
  "photographer", "scientist", "engineer", "baker", "barista", "guard", "hunter", "thief", "spy", "cowboy", "samurai",
  "ninja", "pirate", "captain", "boxer", "athlete", "singer", "writer", "poet", "painter", "old", "lady", "gentleman",
]);
const PLACES = new Set([
  "lighthouse", "house", "cabin", "cafe", "coffee", "bar", "office", "studio", "station", "church", "library", "shop", "store",
  "city", "forest", "desert", "ocean", "sea", "beach", "harbor", "harbour", "mountain", "village", "farm", "school",
  "hospital", "lab", "laboratory", "garden", "kitchen", "castle", "temple", "market", "street", "alley", "rooftop",
  "bridge", "island", "ship", "train", "subway", "space", "planet", "moon", "river", "lake", "valley", "jungle",
]);
const INTERIORS = new Set(["house", "cabin", "cafe", "coffee", "bar", "office", "studio", "station", "church", "library", "shop", "store", "school", "hospital", "lab", "laboratory", "kitchen", "castle", "temple", "lighthouse", "ship", "train", "subway", "room", "apartment", "garage", "warehouse", "museum", "theater", "theatre"]);

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

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
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

// ── Concept parsing ─────────────────────────────────────────────────────────

export interface Concept {
  /** Noun phrase without determiner, e.g. "lone lighthouse keeper". */
  subject: string;
  /** Head noun, e.g. "keeper". */
  head: string;
  /** Verb phrase (often a gerund), e.g. "watching a storm roll in over a cold northern sea". */
  action: string;
  /** Setting noun phrase, e.g. "cold northern sea" ("" when none). */
  setting: string;
  settingHead: string;
  /** A secondary story element from the action, e.g. "storm". */
  element: string;
  /** A place word inside the subject ("lighthouse" in "lighthouse keeper"). */
  place: string;
  isPerson: boolean;
  keywords: string[];
}

const LEADING_FILLER = /^\s*(?:please\s+)?(?:make|create|generate|show|render|produce|film)?\s*(?:me\s+)?(?:a|an)?\s*(?:short\s+|cinematic\s+|epic\s+)*(?:film|video|movie|clip|trailer|ad|story|montage|reel)?\s*(?:about|of|where|showing|featuring)?\s*/i;

function isVerbish(w: string): boolean {
  if (VERBS.has(w)) return true;
  if (w.endsWith("ing") && w.length > 4 && !ING_NOUNS.has(w)) return true;
  return false;
}

function stripDet(words: string[]): string[] {
  let i = 0;
  while (i < words.length && DETERMINERS.has(words[i]!)) i++;
  return words.slice(i);
}

export function parseConcept(prompt: string): Concept {
  const clean = prompt.replace(LEADING_FILLER, "").replace(/[^A-Za-z0-9\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const words = clean.toLowerCase().split(" ").filter(Boolean);
  // Proper nouns keep their casing ("Cairo"): a capitalised word that is not
  // the first word of the prompt.
  const proper = new Map<string, string>();
  clean.split(" ").filter(Boolean).forEach((w, k) => {
    if (k > 0 && /^[A-Z][a-z]/.test(w)) proper.set(w.toLowerCase(), w);
  });
  const body = stripDet(words);

  let i = 0;
  while (i < body.length && !isVerbish(body[i]!) && !PREPOSITIONS.has(body[i]!)) i++;
  let subjectWords = body.slice(0, i);
  if (subjectWords.length > 5) subjectWords = subjectWords.slice(-4);
  let rest = body.slice(i);
  if (rest[0] && ["who", "that", "which"].includes(rest[0])) rest = rest.slice(1);

  // Setting: the last prepositional phrase that is not just a time ("at night").
  let setting: string[] = [];
  for (let j = rest.length - 1; j >= 0; j--) {
    if (!PREPOSITIONS.has(rest[j]!)) continue;
    // The noun phrase ends at the next verb or preposition: "in cairo opening
    // his cart" → "cairo", not "cairo opening his cart".
    const after = stripDet(rest.slice(j + 1));
    const np: string[] = [];
    for (const w of after) {
      if (PREPOSITIONS.has(w) || isVerbish(w)) break;
      np.push(w);
    }
    const nonTime = np.filter((w) => !TIME_WORDS.has(w));
    if (nonTime.length) {
      setting = nonTime.slice(0, 4);
      break;
    }
  }
  const action = rest.join(" ").trim();
  // Story element: first noun-ish word after a determiner inside the action.
  let element = "";
  for (let j = 0; j < rest.length - 1; j++) {
    if (DETERMINERS.has(rest[j]!) && !setting.includes(rest[j + 1]!)) {
      const w = rest[j + 1]!;
      if (!isVerbish(w) && !PREPOSITIONS.has(w)) {
        // Prefer the head of a short noun phrase ("a violent storm" → "storm").
        const np = [w];
        for (let k = j + 2; k < rest.length && np.length < 3 && !isVerbish(rest[k]!) && !PREPOSITIONS.has(rest[k]!) && !VERBS.has(rest[k]!); k++) np.push(rest[k]!);
        element = np[np.length - 1]!;
        break;
      }
    }
  }
  // No prepositional setting: a place-like object of the action is the setting
  // ("opening a tiny coffee shop" → setting "tiny coffee shop").
  if (!setting.length && element && PLACES.has(element)) {
    const at = rest.lastIndexOf(element);
    let st = at;
    while (st > 0 && !DETERMINERS.has(rest[st - 1]!) && !isVerbish(rest[st - 1]!) && !PREPOSITIONS.has(rest[st - 1]!)) st--;
    setting = rest.slice(st, at + 1);
    element = "";
  }
  if (!subjectWords.length) subjectWords = keywordsFromPrompt(clean).slice(0, 2);
  const head = subjectWords[subjectWords.length - 1] ?? "subject";
  const place = subjectWords.slice(0, -1).find((w) => PLACES.has(w)) ?? (PLACES.has(head) ? head : "");
  const settingHead = setting[setting.length - 1] ?? "";
  const isPerson = PERSON.has(head) || (/(?:er|or|ist|ian)$/.test(head) && !/(?:water|river|tower|center|centre|computer|flower|paper|poster|monitor|mirror|corridor|harbor|harbour|motor|tractor|container|thunder|winter|summer|shelter|river)$/.test(head));
  const cased = (ws: string[]): string => ws.map((w) => proper.get(w) ?? w).join(" ");
  return {
    subject: subjectWords.join(" "),
    head,
    action: cased(action.split(" ")),
    setting: cased(setting),
    settingHead,
    element: element && element !== head ? element : "",
    place: place === head && !isPerson ? head : place,
    isPerson,
    keywords: keywordsFromPrompt(clean),
  };
}

// ── Looks: one lighting world per film, progressed across scenes ────────────

interface LightState { mood: string; time: string; short: string; palette: string[]; weather?: string }

const LOOKS: Record<string, LightState[]> = {
  storm: [
    { mood: "cold steel-blue dusk under a lowering sky", short: "a bruised dusk sky", time: "DUSK", palette: ["#1b263b", "#415a77", "#778da9"], weather: "gathering storm" },
    { mood: "storm-dark night, rain-lashed, lit by lightning and a sweeping beam", short: "lightning and driving rain", time: "NIGHT", palette: ["#0b132b", "#1c2541", "#5bc0be"], weather: "storm" },
    { mood: "pale grey dawn breaking through thinning cloud", short: "a pale grey dawn", time: "DAWN", palette: ["#2b2d42", "#8d99ae", "#edf2f4"], weather: "clearing sky" },
  ],
  night: [
    { mood: "deep blue hour, the last light draining from the sky", short: "the blue hour", time: "BLUE HOUR", palette: ["#14213d", "#3a5a98", "#a3bffa"] },
    { mood: "cold moonlight filtering through haze", short: "cold moonlight", time: "NIGHT", palette: ["#0d1b2a", "#1b263b", "#e0e1dd"] },
    { mood: "sodium-orange practicals against black shadows", short: "pools of sodium light", time: "NIGHT", palette: ["#03071e", "#6a040f", "#faa307"] },
  ],
  neon: [
    { mood: "violet dusk with the first neon signs flickering on", short: "violet dusk and first neon", time: "DUSK", palette: ["#10002b", "#5a189a", "#e0aaff"] },
    { mood: "neon magenta-and-cyan wash over wet streets", short: "neon on wet asphalt", time: "NIGHT", palette: ["#1a1a2e", "#e94560", "#0f3460"] },
    { mood: "cyan pre-dawn glow as the signs switch off", short: "cyan pre-dawn", time: "DAWN", palette: ["#0b132b", "#3a506b", "#5bc0be"] },
  ],
  noir: [
    { mood: "hard low-key key light, venetian-blind shadows", short: "hard slatted shadows", time: "NIGHT", palette: ["#0a0a0a", "#3d3d3d", "#e5e5e5"] },
    { mood: "single bare bulb, deep chiaroscuro", short: "a single bare bulb", time: "NIGHT", palette: ["#111111", "#4a4a4a", "#f5f5f5"] },
    { mood: "grey rain-streaked morning light", short: "grey morning rain", time: "MORNING", palette: ["#1c1c1c", "#6b6b6b", "#d4d4d4"] },
  ],
  dawn: [
    { mood: "cool blue pre-dawn with the first practicals glowing", short: "the blue pre-dawn", time: "PRE-DAWN", palette: ["#14213d", "#3a5a98", "#fca311"] },
    { mood: "low golden sunrise raking across the frame", short: "a low golden sunrise", time: "SUNRISE", palette: ["#3d1f00", "#e76f51", "#ffd6a5"] },
    { mood: "soft bright morning, gentle and clean", short: "soft morning light", time: "MORNING", palette: ["#264653", "#2a9d8f", "#e9f5db"] },
  ],
  golden: [
    { mood: "warm golden-hour backlight and long shadows", short: "golden-hour light", time: "GOLDEN HOUR", palette: ["#3d1f00", "#c8791d", "#ffd6a5"] },
    { mood: "blazing sunset, the sky on fire", short: "a blazing sunset", time: "SUNSET", palette: ["#370617", "#dc2f02", "#ffba08"] },
    { mood: "soft violet afterglow of dusk", short: "violet afterglow", time: "DUSK", palette: ["#22223b", "#9a8c98", "#f2e9e4"] },
  ],
  cold: [
    { mood: "flat white overcast, breath visible in the air", short: "white overcast", time: "DAY", palette: ["#1d3557", "#a8dadc", "#f1faee"] },
    { mood: "icy blue twilight over snow", short: "icy twilight", time: "DUSK", palette: ["#0b1f3a", "#1e6091", "#e0fbfc"] },
    { mood: "clear frozen sunrise, low pink sun", short: "a frozen sunrise", time: "DAWN", palette: ["#2b2d42", "#ef8a9f", "#edf2f4"] },
  ],
  natural: [
    { mood: "soft morning light through mist", short: "misty morning light", time: "MORNING", palette: ["#081c15", "#2d6a4f", "#95d5b2"] },
    { mood: "dappled midday sun through leaves", short: "dappled sunlight", time: "DAY", palette: ["#1b4332", "#52b788", "#d8f3dc"] },
    { mood: "warm late-afternoon glow", short: "late-afternoon glow", time: "AFTERNOON", palette: ["#283618", "#bc6c25", "#fefae0"] },
  ],
  cinematic: [
    { mood: "soft naturalistic morning key with gentle rim light", short: "soft morning light", time: "MORNING", palette: ["#22223b", "#4a4e69", "#f2e9e4"] },
    { mood: "crisp daylight with motivated contrast", short: "crisp daylight", time: "DAY", palette: ["#2b2d42", "#8d99ae", "#edf2f4"] },
    { mood: "warm golden-hour backlight and long shadows", short: "golden-hour light", time: "GOLDEN HOUR", palette: ["#3d1f00", "#c8791d", "#ffd6a5"] },
    { mood: "deep blue hour with practical lights coming on", short: "the blue hour", time: "BLUE HOUR", palette: ["#0b1f3a", "#1e6091", "#e0fbfc"] },
  ],
};

export function chooseLook(prompt: string, style: string): string {
  const h = ` ${`${prompt} ${style}`.toLowerCase().replace(/[^a-z]+/g, " ")} `;
  const has = (...w: string[]) => w.some((x) => h.includes(` ${x} `) || h.includes(` ${x}s `) || h.includes(` ${x}y `));
  if (has("noir", "detective")) return "noir";
  if (has("storm", "thunder", "tempest", "hurricane", "rain", "rainy")) return "storm";
  if (has("neon", "cyberpunk", "cyber")) return "neon";
  if (has("night", "midnight", "moon", "moonlit", "stars", "nocturnal")) return "night";
  if (has("dawn", "sunrise", "daybreak")) return "dawn";
  if (has("sunset", "golden", "warm", "summer", "desert")) return "golden";
  if (has("snow", "winter", "cold", "ice", "icy", "arctic", "northern", "frozen")) return "cold";
  if (has("forest", "nature", "garden", "spring", "meadow", "jungle", "morning")) return "natural";
  return "cinematic";
}

// ── Film grammar ────────────────────────────────────────────────────────────

const TIGHTNESS: Record<string, number> = {
  "extreme wide": 0, "wide establishing": 1, "medium wide": 2, "medium": 3, "over-the-shoulder": 3.5,
  "medium close-up": 4, "close-up": 5, "extreme close-up": 6,
};

type ShotType = "establishing" | "wide" | "medium" | "over-the-shoulder" | "medium-close" | "close" | "detail";

const FRAMING_OF: Record<ShotType, string> = {
  establishing: "wide establishing", wide: "medium wide", medium: "medium", "over-the-shoulder": "over-the-shoulder",
  "medium-close": "medium close-up", close: "close-up", detail: "extreme close-up",
};

function shotTypesFor(beat: string, k: number): ShotType[] {
  if (k === 1) return [beat === "setup" || beat === "moment" ? "establishing" : beat === "climax" ? "medium-close" : "medium"];
  const first: ShotType = beat === "setup" || beat === "resolution" || beat === "moment" ? "establishing" : "wide";
  const last: ShotType = beat === "climax" ? "detail" : "close";
  const middle: ShotType[] = ["medium", beat === "climax" || beat === "rising" ? "over-the-shoulder" : "medium-close", "medium", "detail"];
  const out: ShotType[] = [first];
  for (let i = 0; i < k - 2; i++) out.push(middle[i % middle.length]!);
  out.push(last);
  return out;
}

const ENERGY: Record<string, number> = { moment: 0.4, setup: 0.2, inciting: 0.5, rising: 0.65, climax: 0.95, resolution: 0.15 };

function arcFor(n: number): string[] {
  if (n === 1) return ["moment"];
  if (n === 2) return ["setup", "resolution"];
  if (n === 3) return ["setup", "climax", "resolution"];
  if (n === 4) return ["setup", "inciting", "climax", "resolution"];
  return ["setup", "inciting", ...Array.from({ length: n - 4 }, () => "rising"), "climax", "resolution"];
}

function cameraMove(from: string, to: string, energy: number, type: ShotType, side: string, rng: () => number): string {
  const d = (TIGHTNESS[to] ?? 3) - (TIGHTNESS[from] ?? 3);
  if (d >= 2) return energy > 0.6 ? "fast push-in" : "slow push-in";
  if (d > 0) return energy > 0.6 ? "handheld push-in" : "gentle push-in";
  if (d <= -3) return type === "establishing" ? "crane up and pull back" : "slow pull-out";
  if (d < 0) return energy > 0.6 ? "handheld pull-back" : "slow pull-out";
  if (energy > 0.6) return "handheld follow";
  return rng() < 0.5 ? `gentle pan ${side === "left" ? "left" : "right"}` : "static locked-off";
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

interface Voice {
  S: string; // "the lone lighthouse keeper"
  H: string; // "keeper"
  A: string; // action phrase or ""
  SET: string; // "the cold northern sea"
  EL: string; // "the storm"
  detail: (rng: () => number) => string;
}

function lineFor(beat: string, type: ShotType, v: Voice, light: LightState, sideText: string, rng: () => number, person: boolean): string {
  if (!person) return objectLine(beat, type, v, light, rng);
  const wide = type === "establishing" || type === "wide";
  const close = type === "close" || type === "detail" || type === "medium-close";
  const d = v.detail(rng);
  const hasAction = Boolean(v.A);
  switch (beat) {
    case "setup":
    case "moment":
      if (wide) return `Wide on ${v.SET} in ${light.short}. ${cap(v.S)} is a small figure ${sideText}.`;
      if (close) return `Close on ${v.S}'s ${d} — calm, attentive, waiting.`;
      return hasAction ? `We find ${v.S} ${v.A}.` : `${cap(v.S)} takes in ${v.SET}, unhurried.`;
    case "inciting":
      if (wide) return `${cap(v.SET)} stirs; ${v.EL} begins to make itself felt.`;
      if (close) return `${cap(v.S)}'s ${d}: the first flicker of unease.`;
      return `${cap(v.S)} notices ${v.EL} and does not look away.`;
    case "rising":
      if (wide) return `${cap(v.EL)} closes in across ${v.SET}, ${light.short} all around.`;
      if (type === "over-the-shoulder") return `Over ${v.S}'s shoulder: ${v.EL}, nearer now.`;
      if (close) return `${cap(v.S)}'s ${d}, set with resolve.`;
      return hasAction ? `${cap(v.S)} holds on, ${v.A}.` : `${cap(v.S)} pushes forward as ${v.EL} builds.`;
    case "climax":
      if (wide) return `${cap(v.EL)} at its height over ${v.SET} — ${light.short}.`;
      if (type === "over-the-shoulder") return `Over ${v.S}'s shoulder into the heart of ${v.EL}.`;
      if (close) return `Extreme detail: ${v.S}'s ${d}. Everything rests on this moment.`;
      return `${cap(v.S)} braces against ${v.EL} and stands firm.`;
    case "resolution":
    default:
      if (wide) return `${cap(v.SET)} falls still under ${light.short}; ${v.EL} has passed.`;
      if (close) return `A final beat on ${v.S}'s ${d}. Hold, then fade.`;
      return `${cap(v.S)} lets out a long breath as calm returns.`;
  }
}

/** Lines for a non-person subject (a city, a forest, an object). */
function objectLine(beat: string, type: ShotType, v: Voice, light: LightState, rng: () => number): string {
  const wide = type === "establishing" || type === "wide";
  const close = type === "close" || type === "detail" || type === "medium-close";
  const d = v.detail(rng);
  const act = v.A ? (PREPOSITIONS.has(v.A.split(" ")[0]!) ? `, ${v.A}` : ` ${v.A}`) : "";
  switch (beat) {
    case "setup":
    case "moment":
      if (wide) return `Wide on ${v.S}${act}, in ${light.short}.`;
      if (close) return `Detail of ${v.S}'s ${d} in ${light.short}.`;
      return `${cap(v.S)} comes into focus${act}.`;
    case "inciting":
      if (wide) return `${cap(v.EL)} begins to change ${v.S}.`;
      if (close) return `Close on ${v.S}'s ${d} as ${v.EL} shifts.`;
      return `Movement picks up across ${v.S}.`;
    case "rising":
      if (wide) return `${cap(v.EL)} builds across ${v.S}.`;
      if (type === "over-the-shoulder") return `Looking out across ${v.S} toward ${v.EL}.`;
      if (close) return `${cap(v.S)}'s ${d}, alive with ${light.short}.`;
      return `${cap(v.S)} comes fully alive.`;
    case "climax":
      if (wide) return `${cap(v.S)} at its most intense — ${light.short}.`;
      if (close) return `Extreme detail: ${v.S}'s ${d}, at its peak.`;
      return `${cap(v.S)} at full intensity; ${v.EL} everywhere.`;
    case "resolution":
    default:
      if (wide) return `${cap(v.S)} settles under ${light.short}.`;
      if (close) return `A final detail of ${v.S}. Hold, then fade.`;
      return `Stillness returns to ${v.S}.`;
  }
}

function summaryFor(beat: string, v: Voice, person: boolean): string {
  if (!person) {
    switch (beat) {
      case "setup": case "moment": return `Establish ${v.S}${v.A ? `, ${v.A}` : ""}.`;
      case "inciting": return `${cap(v.EL)} begins to transform ${v.S}.`;
      case "rising": return `${cap(v.EL)} builds across ${v.S}.`;
      case "climax": return `${cap(v.S)} at its peak.`;
      default: return `Aftermath: ${v.S} settles.`;
    }
  }
  switch (beat) {
    case "setup": return `Establish ${v.SET} and ${v.S}${v.A ? `, ${v.A}` : ""}.`;
    case "moment": return `A single moment: ${v.S}${v.A ? ` ${v.A}` : ""}.`;
    case "inciting": return `${cap(v.EL)} arrives and ${v.S} takes notice.`;
    case "rising": return `${cap(v.EL)} builds; the pressure on ${v.S} rises.`;
    case "climax": return `${cap(v.EL)} peaks and ${v.S} holds their ground.`;
    default: return `Aftermath: calm returns to ${v.SET}.`;
  }
}

/**
 * Build the deterministic screenplay. Guarantees global continuity: for every
 * shot after the first, openingFrame deep-equals the previous closingFrame.
 */
export function buildScreenplay(opts: ScriptOptions): Screenplay {
  const concept = parseConcept(opts.prompt);
  const keywords = concept.keywords;
  const rng = makeRng(seedFromString(opts.prompt));

  const sceneCount = clamp(opts.sceneCount ?? defaultSceneCount(keywords.length), 1, 12);
  const shotsPerScene = clamp(opts.shotsPerScene ?? 2, 1, 6);
  const shotDuration = clampNum(opts.shotDurationSeconds ?? 4, 1, 30);
  const style = opts.style?.trim() || "modern cinematic";
  const look = LOOKS[chooseLook(opts.prompt, style)] ?? LOOKS.cinematic!;
  const arc = arcFor(sceneCount);

  const lookName = chooseLook(opts.prompt, style);
  const subjectPhrase = concept.subject || "subject";
  const settingPhrase = concept.setting || (!concept.isPerson ? subjectPhrase : "") || (concept.place && concept.place !== concept.head ? concept.place : "") || "the world around them";
  const LOOK_ELEMENT: Record<string, string> = { storm: "storm", night: "night", noir: "night", neon: "city's glow", golden: "fading light", dawn: "new day", cold: "cold", natural: "changing light", cinematic: "day" };
  const elementWord = concept.element || LOOK_ELEMENT[lookName] || "moment";
  const voice: Voice = {
    S: `the ${subjectPhrase}`,
    H: concept.head,
    A: concept.action,
    // A proper-noun setting takes no article ("Cairo", not "the Cairo").
    SET: settingPhrase.startsWith("the ") || /^[A-Z]/.test(settingPhrase) ? settingPhrase : `the ${settingPhrase}`,
    EL: `the ${elementWord}`,
    detail: (r) => concept.isPerson ? pick(["eyes", "hands", "face", "profile"], r) : pick(["silhouette", "surface", "outline", "details"], r),
  };
  // Screen direction is fixed for the whole film (180° rule).
  const side = rng() < 0.5 ? "left" : "right";
  const sideText = `on the ${side} third`;

  const title = (concept.isPerson ? `The ${titleCase(subjectPhrase)}` : titleCase(subjectPhrase)) || "Untitled Film";
  const logline = `A ${style} short in ${sceneCount} scene${sceneCount > 1 ? "s" : ""}: ${subjectPhrase}${concept.action ? ` ${concept.action}` : ""} (${arc.join(" → ")}).`;

  // Locations alternate between the setting and the subject's own place.
  const locations = [concept.setting || (!concept.isPerson ? subjectPhrase : ""), concept.place && concept.place !== concept.settingHead && concept.place !== concept.head ? concept.place : ""].filter(Boolean);
  if (!locations.length) locations.push(keywords[0] ?? "location");

  const scenes: Scene[] = [];
  let carryFrame: ContinuityFrame | null = null;
  let globalShotIndex = 0;

  for (let s = 0; s < sceneCount; s++) {
    const beat = arc[s]!;
    const energy = ENERGY[beat] ?? 0.4;
    const light = look[sceneCount === 1 ? 0 : Math.round((s * (look.length - 1)) / (sceneCount - 1))]!;
    const loc = locations[s % locations.length]!;
    const locHead = loc.split(" ").pop() ?? loc;
    // A single interior location opens outside, then moves in; otherwise
    // interior-type places are INT.
    const interior = INTERIORS.has(locHead) && !(locations.length === 1 && s === 0);
    const heading = `${interior ? "INT." : "EXT."} ${loc.toUpperCase()} — ${light.time}`;
    const sceneId = `scene-${s + 1}`;
    const shots: Shot[] = [];
    const types = shotTypesFor(beat, shotsPerScene);

    for (let k = 0; k < shotsPerScene; k++) {
      const type = types[k]!;
      const framing = FRAMING_OF[type];
      const shotId = `${sceneId}-shot-${k + 1}`;
      const opening: ContinuityFrame = carryFrame ?? {
        composition: `${cap(voice.S)} far off, ${voice.SET} filling the frame`,
        framing: "extreme wide",
        lighting: light.mood,
        palette: [...light.palette],
        subjectPosition: `small against a vast background, ${sideText}`,
      };
      const position = type === "close" || type === "detail" ? "centered, filling the frame" : type === "establishing" ? `small against a vast background, ${sideText}` : type === "over-the-shoulder" ? `foreground shoulder ${side === "left" ? "right" : "left"}, looking toward the ${side} third` : `${sideText}, eyeline toward frame ${side === "left" ? "right" : "left"}`;
      const composition =
        !concept.isPerson && (type === "establishing" || type === "wide") ? `${cap(voice.S)} spread across the frame` :
        type === "establishing" ? `${cap(voice.S)} small in ${voice.SET}` :
        type === "wide" ? `${cap(voice.S)} full-figure within ${voice.SET}` :
        type === "over-the-shoulder" ? `Over ${voice.S}'s shoulder toward ${voice.EL}` :
        type === "close" || type === "detail" ? `${cap(voice.S)}'s ${voice.detail(rng)}` :
        `${cap(voice.S)}, waist-up, ${voice.SET} behind`;
      // The closing frame is this shot's intended framing, in this scene's light.
      const closing: ContinuityFrame = { composition, framing, lighting: light.mood, palette: [...light.palette], subjectPosition: position };
      const movement = cameraMove(opening.framing, framing, energy, type, side, rng);
      const action = lineFor(beat, type, voice, light, sideText, rng, concept.isPerson);

      const queryWords =
        type === "establishing" || type === "wide"
          ? [light.weather?.split(" ").pop() ?? "", concept.setting.split(" ").slice(-2).join(" ") || concept.place || concept.head, light.time.toLowerCase()]
          : type === "close" || type === "detail"
            ? [concept.head, concept.isPerson ? "portrait" : "close up"]
            : [concept.place && concept.place !== concept.head ? concept.place : "", concept.head, concept.settingHead];
      const assetQuery = dedupe(queryWords.filter(Boolean)).join(" ").trim() || keywords.slice(0, 2).join(" ");
      const shotKeywords = dedupe([...assetQuery.split(" "), ...keywords.slice(0, 3)]).filter((w) => w.length > 2);

      shots.push({
        id: shotId,
        sceneId,
        index: globalShotIndex,
        action,
        cameraMovement: movement,
        durationSeconds: shotDuration,
        openingFrame: opening,
        closingFrame: closing,
        keywords: shotKeywords,
        assetQuery,
        shotType: type,
      });
      carryFrame = closing; // next shot opens here → guaranteed continuity
      globalShotIndex++;
    }

    scenes.push({ id: sceneId, index: s, heading, summary: `${summaryFor(beat, voice, concept.isPerson)} Light: ${light.mood}.`, beat, shots });
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
  return clamp(Math.round(keywordCount / 2), 3, 5);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function clampNum(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
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
