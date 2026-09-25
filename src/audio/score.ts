/**
 * Composition: MusicArrangement → a concrete score of note events.
 *
 * Shared by the WAV synthesizer and the MIDI writer so the rendered audio and
 * the editable MIDI are the same piece. Deterministic per arrangement.
 *
 * Musical decisions:
 *   - voice-led chords (closest inversion to the previous chord), with diatonic
 *     7ths for jazzy genres (lo-fi, hip-hop);
 *   - per-genre bass and drum patterns (boom-bap, trap half-time with hat rolls,
 *     rock 8ths, four-on-the-floor, orchestral timpani);
 *   - a seeded 2-bar melodic motif that snaps to the current chord's tones on
 *     strong beats, restated and varied across sections;
 *   - section-aware density: intro/break thin out, chorus/drop are full, fills
 *     lead into big sections, the outro strips back to a final ringing chord.
 */
import type { MusicArrangement, MusicSectionName } from "../personas/types.js";
import { degreeSemitone, tonicMidi } from "./theory.js";

export type Part = "pad" | "bass" | "lead" | "arp" | "kick" | "snare" | "clap" | "hat" | "openhat" | "crash" | "timpani";

export interface NoteEvent {
  part: Part;
  /** Start and length in beats (quarter notes). */
  start: number;
  dur: number;
  midi: number;
  /** 0..1 */
  vel: number;
}

export interface Score {
  events: NoteEvent[];
  totalBeats: number;
  /** Section boundaries in beats, for the mixer (e.g. reverb swells). */
  sections: { name: MusicSectionName; startBeat: number; bars: number }[];
  style: GenreStyle;
}

export type GenreStyle = "hip-hop" | "trap" | "orchestral" | "rock" | "lofi" | "electronic" | "ambient";

export function styleOf(genre: string): GenreStyle {
  const g = genre.toLowerCase();
  if (g.includes("trap") || g.includes("rap")) return "trap";
  if (g.includes("hip")) return "hip-hop";
  if (g.includes("orchestral") || g.includes("cinematic")) return "orchestral";
  if (g.includes("rock")) return "rock";
  if (g.includes("lo-fi") || g.includes("lofi")) return "lofi";
  if (g.includes("electronic") || g.includes("edm") || g.includes("house")) return "electronic";
  return "ambient";
}

interface Density { pad: number; bass: number; drums: number; lead: number; arp: number }

function densityFor(section: MusicSectionName, style: GenreStyle): Density {
  const base: Record<MusicSectionName, Density> = {
    intro: { pad: 0.7, bass: 0, drums: 0, lead: 0, arp: 0.6 },
    verse: { pad: 0.8, bass: 1, drums: 0.7, lead: 0.5, arp: 0.4 },
    chorus: { pad: 1, bass: 1, drums: 1, lead: 1, arp: 0.8 },
    drop: { pad: 0.9, bass: 1, drums: 1, lead: 1, arp: 1 },
    bridge: { pad: 1, bass: 0.6, drums: 0.3, lead: 0.7, arp: 0 },
    break: { pad: 1, bass: 0, drums: 0, lead: 0.4, arp: 0.7 },
    outro: { pad: 0.8, bass: 0.6, drums: 0.4, lead: 0.3, arp: 0 },
  };
  const d = { ...base[section] };
  if (style === "orchestral" || style === "ambient") d.arp *= style === "ambient" ? 1 : 0.5;
  if (style === "rock") d.arp = 0;
  return d;
}

function rng(seed: number): () => number {
  let a = seed >>> 0 || 7;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(a: MusicArrangement): number {
  const s = `${a.genre}|${a.bpm}|${a.keyRoot}|${a.scale}|${a.progression.join(",")}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Chord tones (as MIDI) for a degree, optionally with the diatonic 7th. */
function chordTones(tonic: number, a: MusicArrangement, degree: number, seventh: boolean): number[] {
  const tones = [0, 2, 4, ...(seventh ? [6] : [])].map((k) => tonic + degreeSemitone(a.scale, degree + k));
  return tones;
}

/** Choose the inversion (octave placement of each tone) closest to `prev`. */
function voiceLead(tones: number[], prev: number[] | null, center: number): number[] {
  const place = (n: number, target: number) => {
    let x = n;
    while (x - target > 6) x -= 12;
    while (target - x > 6) x += 12;
    return x;
  };
  const target = prev ? prev.reduce((s, v) => s + v, 0) / prev.length : center;
  return tones.map((t) => place(t, target)).sort((x, y) => x - y);
}

export function composeScore(a: MusicArrangement): Score {
  const style = styleOf(a.genre);
  const r = rng(seedOf(a));
  const tonic = tonicMidi(a.keyRoot, 4);
  const seventh = style === "lofi" || style === "hip-hop" || style === "ambient";
  const events: NoteEvent[] = [];
  const sections: Score["sections"] = [];
  const push = (e: NoteEvent) => events.push(e);
  const swing = Math.max(0, Math.min(0.3, a.swing));
  const sw = (beatPos: number) => (Math.abs((beatPos % 1) - 0.5) < 1e-6 ? swing * 0.5 : Math.abs((beatPos % 0.5) - 0.25) < 1e-6 && style !== "trap" ? swing * 0.25 : 0);

  // Melodic motif: 2 bars of (beat offset, duration, scale-step) choices.
  const rhythms = [
    [[0, 1], [1, 0.5], [1.5, 0.5], [2, 1.5], [4, 1], [5, 1], [6, 2]],
    [[0, 0.5], [0.5, 0.5], [1, 1], [2.5, 0.5], [3, 1], [4, 1.5], [5.5, 0.5], [6, 1.5]],
    [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1], [4, 0.5], [4.5, 0.5], [5, 1], [6, 2]],
  ];
  const motifRhythm = rhythms[Math.floor(r() * rhythms.length)]!;
  const motifSteps = motifRhythm.map((_, i) => (i === 0 ? 0 : Math.round((r() - 0.45) * 4)));

  let beat = 0;
  let prevChord: number[] | null = null;
  let barIndex = 0;
  let melodyStep = 4; // scale-degree cursor for the melody (0 = tonic)
  for (let si = 0; si < a.structure.length; si++) {
    const sec = a.structure[si]!;
    const d = densityFor(sec.name, style);
    const nextSec = a.structure[si + 1];
    const big = (n?: MusicSectionName) => n === "chorus" || n === "drop";
    sections.push({ name: sec.name, startBeat: beat, bars: sec.bars });
    if (big(sec.name) && style !== "ambient") push({ part: style === "orchestral" ? "timpani" : "crash", start: beat, dur: style === "orchestral" ? 2 : 4, midi: style === "orchestral" ? tonic - 24 : 49, vel: 0.9 });

    for (let b = 0; b < sec.bars; b++, barIndex++) {
      const bar0 = beat + b * 4;
      const degree = a.progression[barIndex % a.progression.length]!;
      const chord = voiceLead(chordTones(tonic, a, degree, seventh), prevChord, tonic - 2);
      prevChord = chord;
      const root = tonic + degreeSemitone(a.scale, degree);
      const bassRoot = ((root - 36) % 12 + 12) % 12 + 36; // E2..D#3 range → 36..47
      const lastBarOfSection = b === sec.bars - 1;
      const outroTail = sec.name === "outro" && lastBarOfSection;

      // Pad / chords.
      if (d.pad > 0) {
        if (style === "rock") {
          // Power-chord guitar 8ths (root+5th+octave) — rendered distorted.
          for (let e = 0; e < 8; e++) {
            const t = bar0 + e * 0.5;
            for (const n of [root - 12, root - 5, root]) push({ part: "pad", start: t, dur: 0.45, midi: n, vel: (e % 2 ? 0.55 : 0.75) * d.pad });
          }
        } else if (style === "lofi" || style === "hip-hop") {
          // Rhodes comping: chord on 1 and a push on the "and" of 2.
          for (const [t, len, v] of [[0, 1.5, 0.75], [1.5 + swing * 0.5, 2.4, 0.6]] as const) {
            for (const n of chord) push({ part: "pad", start: bar0 + t, dur: len, midi: n, vel: v * d.pad });
          }
        } else {
          for (const n of chord) push({ part: "pad", start: bar0, dur: outroTail ? 6 : 4, midi: n, vel: 0.6 * d.pad });
          if (style === "orchestral" && d.pad >= 1) push({ part: "pad", start: bar0, dur: 4, midi: chord[0]! + 12, vel: 0.45 });
        }
      }

      // Bass.
      if (d.bass > 0 && !(outroTail && style !== "orchestral")) {
        const v = 0.85 * d.bass;
        const hits: [number, number, number][] =
          style === "trap" ? [[0, 1.5, 0], [2.5, 1, 0], [3.5, 0.5, 7]] :
          style === "hip-hop" ? [[0, 1.4, 0], [1.75, 0.5, 0], [2.5, 1, 7], [3.5, 0.5, 5]] :
          style === "rock" ? Array.from({ length: 8 }, (_, e) => [e * 0.5, 0.45, 0] as [number, number, number]) :
          style === "electronic" ? Array.from({ length: 4 }, (_, e) => [e + 0.5, 0.4, e === 3 ? 12 : 0] as [number, number, number]) :
          style === "lofi" ? [[0, 1.5, 0], [2, 1, 7], [3, 0.75, 5]] :
          [[0, 4, 0]];
        for (const [t, len, iv] of hits) {
          const note = bassRoot + (iv === 7 ? 7 : iv === 5 ? 5 : iv === 12 ? 12 : 0);
          push({ part: "bass", start: bar0 + t + sw(t), dur: len, midi: style === "trap" || style === "hip-hop" ? note - 12 : note, vel: v });
        }
      }

      // Drums.
      if (d.drums > 0 && style !== "ambient") {
        const dv = d.drums;
        if (style === "orchestral") {
          if (b % 2 === 0 && dv >= 0.7) push({ part: "timpani", start: bar0, dur: 1.5, midi: tonic - 24, vel: 0.7 * dv });
          if (dv >= 1) push({ part: "timpani", start: bar0 + 3, dur: 0.5, midi: tonic - 24 + 7, vel: 0.45 });
        } else {
          const pat = drumPattern(style);
          for (const [part, steps, vel] of pat) {
            for (const st of steps) {
              const t = st / 4;
              if (outroTail && t >= 2) continue;
              push({ part, start: bar0 + t + sw(t), dur: 0.25, midi: 0, vel: vel * dv * (part === "hat" ? 0.85 + 0.15 * r() : 1) });
            }
          }
          // Trap hat roll at the end of every 2nd bar.
          if (style === "trap" && b % 2 === 1) for (let k = 0; k < 6; k++) push({ part: "hat", start: bar0 + 3.25 + k * (0.75 / 6), dur: 0.1, midi: 0, vel: 0.35 + k * 0.05 });
          // Fill into a big section.
          if (lastBarOfSection && big(nextSec?.name)) for (let k = 0; k < 4; k++) push({ part: "snare", start: bar0 + 3 + k * 0.25, dur: 0.2, midi: 0, vel: 0.5 + k * 0.12 });
        }
      }

      // Arpeggio.
      if (d.arp > 0 && !outroTail) {
        const stepLen = style === "electronic" ? 0.25 : 0.5;
        const up = [...chord, chord[0]! + 12];
        for (let k = 0; k < 4 / stepLen; k++) {
          const n = up[k % up.length]! + 12;
          push({ part: "arp", start: bar0 + k * stepLen + sw(k * stepLen), dur: stepLen * 0.9, midi: n, vel: (k % 2 ? 0.45 : 0.6) * d.arp });
        }
      }

      // Melody: the motif across bar pairs, snapped to chord tones on strong beats.
      if (d.lead > 0 && !outroTail) {
        const half = b % 2; // which bar of the 2-bar motif
        const octave = sec.name === "chorus" || sec.name === "drop" ? 12 : 0;
        motifRhythm.forEach(([off, len], i) => {
          if (Math.floor(off! / 4) !== half) return;
          if (d.lead < 1 && i % 2 === 1 && r() < 0.6) return; // sparser in verses
          melodyStep += motifSteps[i]!;
          melodyStep = Math.max(0, Math.min(9, melodyStep));
          let pitch = tonic + degreeSemitone(a.scale, 1 + melodyStep) + octave;
          const strong = (off! % 1) === 0 && ((off! % 4) === 0 || (off! % 4) === 2);
          if (strong) pitch = nearestChordTone(pitch, chord);
          const t = bar0 + (off! % 4);
          push({ part: "lead", start: t + sw(off! % 4), dur: len! * 0.95, midi: pitch, vel: (strong ? 0.8 : 0.65) * Math.min(1, d.lead + 0.2) });
        });
      }
    }
    beat += sec.bars * 4;
  }
  return { events, totalBeats: beat, sections, style };
}

function nearestChordTone(pitch: number, chord: number[]): number {
  let best = pitch;
  let dist = 99;
  for (const c of chord) {
    for (let o = -24; o <= 24; o += 12) {
      const cand = c + o;
      const dd = Math.abs(cand - pitch);
      if (dd < dist) { dist = dd; best = cand; }
    }
  }
  return best;
}

type DrumLine = [Part, number[], number];

/** 16th-note step patterns (0..15) per genre. */
function drumPattern(style: GenreStyle): DrumLine[] {
  switch (style) {
    case "hip-hop": return [["kick", [0, 7, 10], 0.95], ["snare", [4, 12], 0.85], ["hat", [0, 2, 4, 6, 8, 10, 12, 14], 0.4]];
    case "trap": return [["kick", [0, 6, 10], 1], ["clap", [8], 0.9], ["hat", [0, 2, 4, 6, 8, 10, 12, 14], 0.35]];
    case "rock": return [["kick", [0, 6, 8], 0.95], ["snare", [4, 12], 0.9], ["hat", [0, 2, 4, 6, 8, 10, 12, 14], 0.45]];
    case "lofi": return [["kick", [0, 10], 0.75], ["snare", [4, 12], 0.5], ["hat", [0, 2, 4, 6, 8, 10, 12, 14], 0.3]];
    case "electronic": return [["kick", [0, 4, 8, 12], 1], ["clap", [4, 12], 0.75], ["openhat", [2, 6, 10, 14], 0.4], ["hat", [1, 3, 5, 7, 9, 11, 13, 15], 0.25]];
    default: return [["kick", [0, 8], 0.6], ["hat", [4, 12], 0.25]];
  }
}
