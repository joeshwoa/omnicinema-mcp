/**
 * Voice Director & Audio Engineer persona.
 *
 * Leads spoken-word asset kinds (voiceover, sfx). Advises on soundtracks (how the
 * music should duck and carve frequencies to make room for narration). Dictates
 * pacing (words per minute), emotional inflection, pauses, loudness targets, and
 * frequency treatment.
 */
import type { ConsultationInput, Persona, PersonaContribution, PersonaRole } from "./types.js";

function pacingFor(style: string): { wpm: number; tone: string; pauseMs: number } {
  const s = style.toLowerCase();
  if (s.includes("energetic") || s.includes("hype") || s.includes("commercial")) {
    return { wpm: 175, tone: "bright, energetic, forward", pauseMs: 180 };
  }
  if (s.includes("dramatic") || s.includes("cinematic") || s.includes("trailer")) {
    return { wpm: 110, tone: "deep, deliberate, gravitas", pauseMs: 420 };
  }
  if (s.includes("calm") || s.includes("meditative") || s.includes("documentary")) {
    return { wpm: 130, tone: "warm, measured, intimate", pauseMs: 300 };
  }
  return { wpm: 150, tone: "natural, conversational", pauseMs: 250 };
}

export const voiceDirector: Persona = {
  id: "voice-director",
  title: "Voice Director & Audio Engineer",
  leads: ["voiceover", "sfx"],
  advises: ["soundtrack"],

  contribute(input: ConsultationInput, role: PersonaRole): PersonaContribution {
    const style = input.style || "natural";
    const { wpm, tone, pauseMs } = pacingFor(style);

    if (role === "advisor") {
      // Advising a soundtrack: keep it out of the vocal range and duck under VO.
      return {
        persona: this.id,
        role,
        directives: [
          "Duck the music 8–12 dB whenever narration is present (sidechain to the VO bus).",
          "Carve 2–4 kHz in the music bed so the voice's presence range stays clear.",
          "Keep the bed below -20 LUFS under speech; let it breathe up in gaps.",
        ],
        positive: ["leaves headroom for narration", "gentle 2-4kHz dip", "sidechained ducking"],
        negative: ["masking the vocal range", "harsh 3kHz buildup"],
        params: { duckingDb: 10, duckRangeHz: [2000, 4000], bedLufsUnderSpeech: -22 },
      };
    }

    if (input.assetKind === "sfx") {
      return {
        persona: this.id,
        role,
        directives: [
          "Design a short, transient-rich effect with a clear attack and controlled tail.",
          "High-pass rumble below 40 Hz; keep it mono-compatible.",
        ],
        positive: ["punchy transient", "clean tail", "layered", "high fidelity"],
        negative: ["muddy low end", "clipping", "background hiss"],
        params: { sampleRate: 48000, targetLufs: -18, highPassHz: 40 },
      };
    }

    // Voiceover (lead).
    return {
      persona: this.id,
      role,
      directives: [
        `Deliver at ~${wpm} words/min in a ${tone} register.`,
        `Insert ~${pauseMs}ms breaths at sentence boundaries; lift emphasis on key nouns and verbs.`,
        "High-pass at 80 Hz, add a gentle presence lift at 3–5 kHz, and de-ess around 6–8 kHz.",
        "Master the voice bus to -16 LUFS with true-peak below -1.5 dBFS.",
      ],
      positive: [tone, "clear diction", "studio voiceover", "consistent proximity"],
      negative: ["robotic monotone", "background noise", "sibilance", "room echo"],
      params: {
        wpm,
        tone,
        pauseMs,
        targetLufs: -16,
        sampleRate: 24000,
        highPassHz: 80,
        presenceBoostHz: [3000, 5000],
        deEssHz: [6000, 8000],
        truePeakDbfs: -1.5,
      },
    };
  },
};
