/**
 * Standard MIDI File (Type 1) writer.
 *
 * Writes the SAME score the synthesizer renders (see score.ts), one track per
 * part with General MIDI programs, drums on channel 10, tempo + key + time
 * signature meta events and track names — so a DAW opens it ready to
 * re-voice. No dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import type { MusicArrangement } from "../personas/types.js";
import { composeScore, type GenreStyle, type NoteEvent, type Part } from "./score.js";

const TPQ = 480; // ticks per quarter note

interface MidiEvent { tick: number; bytes: number[] }

export function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

const GM_DRUM: Partial<Record<Part, number>> = { kick: 36, snare: 38, clap: 39, hat: 42, openhat: 46, crash: 49 };

function program(part: Part, style: GenreStyle): number {
  switch (part) {
    case "pad": return style === "lofi" || style === "hip-hop" ? 4 : style === "rock" ? 30 : style === "orchestral" ? 48 : 89;
    case "bass": return style === "trap" || style === "hip-hop" ? 38 : style === "rock" ? 33 : style === "orchestral" ? 42 : 38;
    case "lead": return style === "orchestral" ? 60 : style === "rock" ? 29 : style === "trap" ? 14 : style === "electronic" ? 81 : 73;
    case "arp": return style === "orchestral" ? 45 : style === "lofi" || style === "hip-hop" ? 11 : 46;
    case "timpani": return 47;
    default: return 0;
  }
}

function track(name: string, events: MidiEvent[]): Buffer {
  const nameBytes = [...Buffer.from(name, "utf8")];
  const all: MidiEvent[] = [{ tick: 0, bytes: [0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes] }, ...events];
  all.sort((a, b) => a.tick - b.tick || isOff(b) - isOff(a));
  const out: number[] = [];
  let last = 0;
  for (const ev of all) {
    out.push(...vlq(Math.max(0, ev.tick - last)), ...ev.bytes);
    last = Math.max(last, ev.tick);
  }
  out.push(0x00, 0xff, 0x2f, 0x00);
  const len = out.length;
  return Buffer.concat([Buffer.from([0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]), Buffer.from(out)]);
}

function isOff(ev: MidiEvent): number {
  return (ev.bytes[0]! & 0xf0) === 0x80 ? 1 : 0;
}

const KEY_SHARPS: Record<string, number> = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7, F: -1, BB: -2, "A#": -2, EB: -3, "D#": -3, AB: -4, "G#": -4, DB: -5, GB: -6 };

export function writeArrangementMidi(arrangement: MusicArrangement, dest: string): { durationMs: number; tracks: number } {
  const score = composeScore(arrangement);
  const usPerQuarter = Math.round(60_000_000 / arrangement.bpm);
  const minor = arrangement.scale !== "major";
  // Key signature: minor keys use the relative major's accidentals.
  const rootUpper = arrangement.keyRoot.toUpperCase();
  const sharps = KEY_SHARPS[rootUpper] ?? 0;
  const sf = minor ? ((sharps - 3 + 7 + 12) % 12) - 7 : sharps;
  const sfClamped = Math.max(-7, Math.min(7, sf));
  const conductor = track("Conductor", [
    { tick: 0, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] },
    { tick: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
    { tick: 0, bytes: [0xff, 0x59, 0x02, sfClamped & 0xff, minor ? 1 : 0] },
    ...score.sections.map((s) => {
      const text = [...Buffer.from(s.name, "utf8")];
      return { tick: Math.round(s.startBeat * TPQ), bytes: [0xff, 0x06, ...vlq(text.length), ...text] };
    }),
  ]);

  const parts = [...new Set(score.events.map((e) => e.part))];
  const melodic = parts.filter((p) => !(p in GM_DRUM));
  const drums = parts.filter((p) => p in GM_DRUM);
  const tracks: Buffer[] = [conductor];
  let ch = 0;
  for (const p of melodic) {
    if (ch === 9) ch++;
    const channel = ch++ & 0x0f;
    const evs: MidiEvent[] = [{ tick: 0, bytes: [0xc0 | channel, program(p, score.style) & 0x7f] }];
    for (const e of score.events.filter((x) => x.part === p)) evs.push(...noteOnOff(e, channel, e.midi));
    tracks.push(track(p, evs));
  }
  if (drums.length) {
    const evs: MidiEvent[] = [];
    for (const e of score.events.filter((x) => drums.includes(x.part))) evs.push(...noteOnOff(e, 9, GM_DRUM[e.part]!));
    tracks.push(track("drums", evs));
  }

  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x01, // format 1
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (TPQ >> 8) & 0xff, TPQ & 0xff,
  ]);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.concat([header, ...tracks]));
  return { durationMs: Math.round((score.totalBeats * 60_000) / arrangement.bpm), tracks: tracks.length };
}

function noteOnOff(e: NoteEvent, channel: number, note: number): MidiEvent[] {
  const n = Math.max(0, Math.min(127, Math.round(note)));
  const vel = Math.max(1, Math.min(127, Math.round(e.vel * 110)));
  const on = Math.round(e.start * TPQ);
  const off = Math.max(on + 1, Math.round((e.start + e.dur) * TPQ));
  return [{ tick: on, bytes: [0x90 | channel, n, vel] }, { tick: off, bytes: [0x80 | channel, n, 0] }];
}
