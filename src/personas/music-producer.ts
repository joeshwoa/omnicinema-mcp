/**
 * Music Producer & Beats Engineer persona (audio add-on).
 *
 * Leads soundtrack/music production. Before any prompt reaches a music generator,
 * it analyzes structural musical elements — tempo (BPM), key, verse/chorus
 * arrangement, and instrumentation — and emits a concrete MusicArrangement that
 * the audio engine can either send to a generative model OR render locally via
 * deterministic MIDI synthesis (no API required).
 */
import type {
  ConsultationInput,
  MusicArrangement,
  MusicSection,
  Persona,
  PersonaContribution,
  PersonaRole,
} from "./types.js";

interface GenreProfile {
  genre: string;
  bpm: number;
  scale: MusicArrangement["scale"];
  progression: number[];
  instruments: string[];
  swing: number;
  keyRoot: string;
  structure: MusicSection[];
}

const VERSE_CHORUS: MusicSection[] = [
  { name: "intro", bars: 4 },
  { name: "verse", bars: 8 },
  { name: "chorus", bars: 8 },
  { name: "verse", bars: 8 },
  { name: "chorus", bars: 8 },
  { name: "outro", bars: 4 },
];

const EDM_STRUCTURE: MusicSection[] = [
  { name: "intro", bars: 8 },
  { name: "verse", bars: 8 },
  { name: "drop", bars: 8 },
  { name: "break", bars: 8 },
  { name: "drop", bars: 8 },
  { name: "outro", bars: 8 },
];

const CINEMATIC_STRUCTURE: MusicSection[] = [
  { name: "intro", bars: 8 },
  { name: "verse", bars: 8 },
  { name: "bridge", bars: 8 },
  { name: "chorus", bars: 8 },
  { name: "outro", bars: 8 },
];

const GENRES: GenreProfile[] = [
  {
    genre: "hip-hop", bpm: 88, scale: "minor", progression: [1, 6, 4, 5],
    instruments: ["808 sub bass", "boom-bap drums", "rhodes piano", "vinyl hats"],
    swing: 0.14, keyRoot: "A", structure: VERSE_CHORUS,
  },
  {
    genre: "rap-trap", bpm: 140, scale: "harmonic-minor", progression: [1, 1, 6, 7],
    instruments: ["808 glide bass", "trap hi-hats", "dark piano", "brass stabs"],
    swing: 0.08, keyRoot: "F", structure: VERSE_CHORUS,
  },
  {
    genre: "cinematic-orchestral", bpm: 72, scale: "minor", progression: [1, 6, 3, 7],
    instruments: ["legato strings", "french horns", "timpani", "choir pads"],
    swing: 0, keyRoot: "D", structure: CINEMATIC_STRUCTURE,
  },
  {
    genre: "rock", bpm: 128, scale: "major", progression: [1, 5, 6, 4],
    instruments: ["distorted guitars", "bass guitar", "live drums", "hammond organ"],
    swing: 0, keyRoot: "E", structure: VERSE_CHORUS,
  },
  {
    genre: "lo-fi", bpm: 78, scale: "dorian", progression: [1, 4, 2, 5],
    instruments: ["rhodes chords", "upright bass", "soft brush drums", "vinyl crackle"],
    swing: 0.2, keyRoot: "F", structure: VERSE_CHORUS,
  },
  {
    genre: "electronic", bpm: 126, scale: "minor", progression: [1, 6, 7, 5],
    instruments: ["saw lead", "sub bass", "four-on-the-floor kick", "pluck arp"],
    swing: 0, keyRoot: "A", structure: EDM_STRUCTURE,
  },
];

const DEFAULT_PROFILE: GenreProfile = {
  genre: "ambient-score", bpm: 90, scale: "minor", progression: [1, 4, 6, 5],
  instruments: ["warm pads", "sub bass", "soft percussion", "piano"],
  swing: 0.05, keyRoot: "C", structure: CINEMATIC_STRUCTURE,
};

export function detectGenre(input: ConsultationInput): GenreProfile {
  const hay = `${input.style ?? ""} ${input.subject}`.toLowerCase();
  const alias: Record<string, string> = {
    "hip hop": "hip-hop", hiphop: "hip-hop", boom: "hip-hop",
    trap: "rap-trap", rap: "rap-trap",
    orchestral: "cinematic-orchestral", cinematic: "cinematic-orchestral", epic: "cinematic-orchestral", score: "cinematic-orchestral",
    rock: "rock", metal: "rock", punk: "rock",
    lofi: "lo-fi", "lo-fi": "lo-fi", chill: "lo-fi", jazzy: "lo-fi",
    edm: "electronic", electronic: "electronic", house: "electronic", techno: "electronic", synth: "electronic",
  };
  for (const [needle, genre] of Object.entries(alias)) {
    if (hay.includes(needle)) {
      const p = GENRES.find((g) => g.genre === genre);
      if (p) return p;
    }
  }
  return DEFAULT_PROFILE;
}

/** Produce the concrete, renderable arrangement for a soundtrack request. */
export function planMusic(input: ConsultationInput): MusicArrangement {
  const p = detectGenre(input);
  return {
    genre: p.genre,
    bpm: p.bpm,
    keyRoot: p.keyRoot,
    scale: p.scale,
    progression: [...p.progression],
    structure: p.structure.map((s) => ({ ...s })),
    instruments: [...p.instruments],
    swing: p.swing,
    targetLufs: -14,
  };
}

export const musicProducer: Persona = {
  id: "music-producer",
  title: "Music Producer & Beats Engineer",
  leads: ["soundtrack"],
  advises: [],

  contribute(input: ConsultationInput, role: PersonaRole): PersonaContribution {
    const plan = planMusic(input);
    const totalBars = plan.structure.reduce((n, s) => n + s.bars, 0);
    return {
      persona: this.id,
      role,
      directives: [
        `Genre: ${plan.genre}. Set tempo to ${plan.bpm} BPM in ${plan.keyRoot} ${plan.scale}.`,
        `Arrange ${totalBars} bars: ${plan.structure.map((s) => `${s.name}(${s.bars})`).join(" → ")}.`,
        `Instrumentation: ${plan.instruments.join(", ")}. Progression (scale degrees): ${plan.progression.join("–")}.`,
        `Master to ${plan.targetLufs} LUFS with controlled low end and clear stereo image.`,
      ],
      positive: [
        `${plan.genre} instrumental`,
        `${plan.bpm} BPM`,
        `${plan.keyRoot} ${plan.scale}`,
        ...plan.instruments,
        "well-structured arrangement",
        "studio quality",
        "clean mix",
      ],
      negative: ["vocals", "out of tune", "clipping", "low quality", "abrupt cutoff"],
      params: {
        bpm: plan.bpm,
        keyRoot: plan.keyRoot,
        scale: plan.scale,
        swing: plan.swing,
        targetLufs: plan.targetLufs,
        instruments: plan.instruments,
        arrangement: plan,
      },
    };
  },
};

/**
 * Re-flow an arrangement's structure so it lasts ~`targetMs` (rounded UP to
 * whole bars, so the music never ends before the picture). Keeps the intro and
 * outro, scales the body sections proportionally, and drops body sections when
 * the target is very short.
 */
export function fitArrangementToDuration(arr: MusicArrangement, targetMs: number): MusicArrangement {
  const barMs = (4 * 60_000) / arr.bpm;
  const need = Math.max(2, Math.ceil(targetMs / barMs));
  const src = arr.structure;
  const total = src.reduce((n, s) => n + s.bars, 0);
  let sections = src.map((s) => ({ ...s }));
  // Too short for every section: keep intro, the strongest section, and outro.
  if (need < sections.length * 2) {
    const peak = sections.find((s) => s.name === "chorus" || s.name === "drop") ?? sections[Math.floor(sections.length / 2)]!;
    sections = [sections[0]!, { ...peak }, sections[sections.length - 1]!].filter((s, i, a) => a.indexOf(s) === i);
  }
  const base = sections.reduce((n, s) => n + s.bars, 0) || total;
  let bars = sections.map((s) => Math.max(1, Math.round((s.bars / base) * need)));
  let diff = need - bars.reduce((a, b) => a + b, 0);
  // Adjust the longest body section until the sum is exact.
  while (diff !== 0) {
    const order = bars.map((b, i) => [b, i] as const).filter(([, i]) => i !== 0 && i !== bars.length - 1 || bars.length <= 2).sort((a, b) => b[0] - a[0]);
    const i = order[0]?.[1] ?? 0;
    if (diff > 0) { bars[i]! += 1; diff--; } else if (bars[i]! > 1) { bars[i]! -= 1; diff++; } else break;
  }
  bars = bars.map((b) => Math.max(1, b));
  return { ...arr, structure: sections.map((s, i) => ({ name: s.name, bars: bars[i]! })) };
}
