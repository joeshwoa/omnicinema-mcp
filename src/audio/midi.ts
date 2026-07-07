/**
 * Minimal Standard MIDI File (Type 0) writer.
 *
 * Emits an editable .mid of the arrangement (chords + bass) alongside the rendered
 * WAV, so downstream DAWs can re-voice or re-instrument the composition. No deps.
 */
import fs from "node:fs";
import path from "node:path";
import type { MusicArrangement } from "../personas/types.js";
import { degreeSemitone, tonicMidi, triadMidi } from "./theory.js";

const TPQ = 480; // ticks per quarter note
const BEATS_PER_BAR = 4;

interface MidiEvent {
  tick: number;
  bytes: number[];
}

function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

export function writeArrangementMidi(arrangement: MusicArrangement, dest: string): { durationMs: number } {
  const { bpm, keyRoot, scale, progression, structure } = arrangement;
  const totalBars = structure.reduce((n, s) => n + s.bars, 0);
  const tonic = tonicMidi(keyRoot, 4);
  const events: MidiEvent[] = [];

  // Tempo meta (microseconds per quarter note).
  const usPerQuarter = Math.round(60_000_000 / bpm);
  events.push({ tick: 0, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] });

  const barTicks = BEATS_PER_BAR * TPQ;
  for (let bar = 0; bar < totalBars; bar++) {
    const degree = progression[bar % progression.length]!;
    const chord = triadMidi(tonic, scale, degree);
    const bass = tonic + degreeSemitone(scale, degree) - 24;
    const start = bar * barTicks;
    const end = start + barTicks;
    for (const note of [...chord, bass]) {
      const n = Math.max(0, Math.min(127, note));
      events.push({ tick: start, bytes: [0x90, n, 80] }); // note on, ch 0
      events.push({ tick: end, bytes: [0x80, n, 0] }); // note off
    }
  }

  // Stable sort by tick (note-offs before note-ons at the same tick).
  events.sort((a, b) => a.tick - b.tick || isOff(b) - isOff(a));

  const track: number[] = [];
  let lastTick = 0;
  for (const ev of events) {
    track.push(...vlq(ev.tick - lastTick), ...ev.bytes);
    lastTick = ev.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, // MThd, len 6
    0x00, 0x00, // format 0
    0x00, 0x01, // 1 track
    (TPQ >> 8) & 0xff, TPQ & 0xff, // division
  ]);
  const trackLen = track.length;
  const trackHeader = Buffer.from([0x4d, 0x54, 0x72, 0x6b, (trackLen >> 24) & 0xff, (trackLen >> 16) & 0xff, (trackLen >> 8) & 0xff, trackLen & 0xff]);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.concat([header, trackHeader, Buffer.from(track)]));

  const durationMs = Math.round((totalBars * BEATS_PER_BAR * 60_000) / bpm);
  return { durationMs };
}

function isOff(ev: MidiEvent): number {
  return (ev.bytes[0]! & 0xf0) === 0x80 ? 1 : 0;
}
