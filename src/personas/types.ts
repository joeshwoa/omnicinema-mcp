/**
 * Multi-agent consultation types.
 *
 * Before any asset is generated, the relevant specialist personas "consult": each
 * contributes directives, positive/negative prompt fragments, and technical
 * parameters. One persona leads per asset kind; the others advise. The result is
 * a compiled PromptBrief plus a transcript of the (deterministic) debate.
 */
export type AssetKind =
  | "cinematic-photo"
  | "logo"
  | "vector-art"
  | "texture"
  | "ui-mockup"
  | "voiceover"
  | "soundtrack"
  | "sfx";

export type PersonaId =
  | "director-of-photography"
  | "graphic-designer"
  | "voice-director"
  | "music-producer";

export type PersonaRole = "lead" | "advisor";

export interface ConsultationInput {
  assetKind: AssetKind;
  /** The subject/description of what to create. */
  subject: string;
  /** Optional style hint, e.g. "noir", "brutalist", "warm documentary". */
  style?: string;
  /** Optional aspect ratio override, e.g. "16:9", "1:1", "9:16". */
  aspectRatio?: string;
  /** Free-form extra constraints the personas should honor. */
  constraints?: string[];
}

export interface PersonaContribution {
  persona: PersonaId;
  role: PersonaRole;
  /** Human-readable directives (the persona's "reasoning"). */
  directives: string[];
  /** Prompt fragments to include. */
  positive: string[];
  /** Prompt fragments to exclude (negative prompt). */
  negative: string[];
  /** Technical parameters this persona dictates (heterogeneous; may nest). */
  params: Record<string, unknown>;
}

export interface DebateTurn {
  persona: PersonaId;
  role: PersonaRole;
  statement: string;
}

export interface PromptBrief {
  assetKind: AssetKind;
  subject: string;
  style: string;
  leadPersona: PersonaId;
  advisors: PersonaId[];
  /** Final compiled positive prompt (single string). */
  positivePrompt: string;
  /** Final compiled negative prompt (single string). */
  negativePrompt: string;
  /** Merged technical parameters (lead wins on conflicts). */
  params: Record<string, unknown>;
  /** The consultation transcript ("who said what"). */
  transcript: DebateTurn[];
  compiledAt: string;
}

export type MusicSectionName =
  | "intro" | "verse" | "chorus" | "bridge" | "outro" | "drop" | "break";

export interface MusicSection {
  name: MusicSectionName;
  bars: number;
}

export type MusicScale = "major" | "minor" | "dorian" | "phrygian" | "harmonic-minor";

/** A concrete, renderable musical arrangement (used by local MIDI synthesis). */
export interface MusicArrangement {
  genre: string;
  bpm: number;
  /** Tonic note name, e.g. "A", "C#". */
  keyRoot: string;
  scale: MusicScale;
  /** Chord roots as 1-based scale degrees, looped across the arrangement. */
  progression: number[];
  structure: MusicSection[];
  instruments: string[];
  /** Swing amount, 0 (straight) .. 0.3 (heavy). */
  swing: number;
  targetLufs: number;
}

export interface Persona {
  id: PersonaId;
  title: string;
  /** Asset kinds this persona leads. */
  leads: AssetKind[];
  /** Asset kinds this persona advises on (secondary voice). */
  advises: AssetKind[];
  contribute(input: ConsultationInput, role: PersonaRole): PersonaContribution;
}
