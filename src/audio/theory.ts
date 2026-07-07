/**
 * Minimal music-theory helpers shared by the local synthesizer and MIDI writer.
 */
import type { MusicScale } from "../personas/types.js";

const NOTE_SEMITONE: Record<string, number> = {
  C: 0, "C#": 1, DB: 1, D: 2, "D#": 3, EB: 3, E: 4, F: 5, "F#": 6,
  GB: 6, G: 7, "G#": 8, AB: 8, A: 9, "A#": 10, BB: 10, B: 11,
};

const SCALE_INTERVALS: Record<MusicScale, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  "harmonic-minor": [0, 2, 3, 5, 7, 8, 11],
};

/** MIDI note number for a tonic name at a given octave (C4 = 60). */
export function tonicMidi(keyRoot: string, octave: number): number {
  const semitone = NOTE_SEMITONE[keyRoot.toUpperCase()] ?? 0;
  return 12 * (octave + 1) + semitone;
}

/** Semitone offset (from the tonic) of a 1-based scale degree, spanning octaves. */
export function degreeSemitone(scale: MusicScale, degree: number): number {
  const intervals = SCALE_INTERVALS[scale];
  const idx = ((degree - 1) % 7 + 7) % 7;
  const octaves = Math.floor((degree - 1) / 7);
  return intervals[idx]! + 12 * octaves;
}

/** Build a diatonic triad (root/third/fifth) MIDI notes for a scale degree. */
export function triadMidi(tonic: number, scale: MusicScale, degree: number): [number, number, number] {
  return [
    tonic + degreeSemitone(scale, degree),
    tonic + degreeSemitone(scale, degree + 2),
    tonic + degreeSemitone(scale, degree + 4),
  ];
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
