/**
 * Music + SFX synthesis quality checks that do not need ears: section-aware
 * arrangement, melody and chord content, loudness/peak targets, a valid
 * multi-track MIDI that matches the score, duration fitting, and SFX recipes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeScore, styleOf } from "../src/audio/score.js";
import { gatedRmsDb, renderArrangementBuffers } from "../src/audio/synth.js";
import { writeArrangementMidi } from "../src/audio/midi.js";
import { chooseRecipe, renderSfx } from "../src/audio/sfx.js";
import { readWavInfo } from "../src/audio/wav.js";
import { fitArrangementToDuration, planMusic } from "../src/personas/music-producer.js";
import { generateSoundtrack } from "../src/pipeline/audio-engine.js";
import { isHalt } from "../src/pipeline/asset-results.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-music-"));
const short = (style: string) => fitArrangementToDuration(planMusic({ assetKind: "soundtrack", subject: "x", style }), 20_000);

test("sections change the arrangement: intro is sparse, chorus/drop is full", () => {
  const a = planMusic({ assetKind: "soundtrack", subject: "x", style: "electronic" });
  const s = composeScore(a);
  const inSection = (name: string) => {
    const sec = s.sections.find((x) => x.name === name)!;
    return s.events.filter((e) => e.start >= sec.startBeat && e.start < sec.startBeat + sec.bars * 4);
  };
  const intro = inSection("intro");
  const drop = inSection("drop");
  assert.equal(intro.filter((e) => e.part === "kick").length, 0, "no kick in the intro");
  assert.ok(drop.filter((e) => e.part === "kick").length >= 30, "four-on-the-floor in the drop");
  assert.ok(drop.some((e) => e.part === "lead"), "melody in the drop");
  assert.ok(drop.length > intro.length * 2);
});

test("every genre has chords, bass and a melody in key", () => {
  for (const style of ["hip hop", "trap", "cinematic orchestral", "rock", "lo-fi", "electronic", "ambient"]) {
    const a = planMusic({ assetKind: "soundtrack", subject: "x", style });
    const s = composeScore(a);
    for (const part of ["pad", "bass", "lead"] as const) assert.ok(s.events.some((e) => e.part === part), `${style}: has ${part}`);
    assert.equal(s.totalBeats, a.structure.reduce((n, x) => n + x.bars, 0) * 4);
    assert.ok(styleOf(a.genre));
  }
});

test("mastering: ~-14 LUFS proxy, no clipping, stereo", () => {
  for (const style of ["lo-fi", "electronic", "cinematic orchestral"]) {
    const { L, R } = renderArrangementBuffers(short(style), 22050);
    let peak = 0;
    let diff = 0;
    for (let i = 0; i < L.length; i++) {
      peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
      diff += Math.abs(L[i]! - R[i]!);
    }
    assert.ok(peak <= 0.9, `${style}: peak ${peak.toFixed(3)} under -1 dBFS`);
    const loud = gatedRmsDb({ L, R } as never, 22050);
    assert.ok(loud > -20 && loud < -12, `${style}: loudness proxy ${loud.toFixed(1)} dB`);
    assert.ok(diff / L.length > 0.001, `${style}: real stereo image`);
  }
});

test("MIDI is Type-1 multi-track with tempo, key and drums on channel 10", () => {
  const a = short("hip hop");
  const dest = path.join(tmp, "x.mid");
  const r = writeArrangementMidi(a, dest);
  const buf = fs.readFileSync(dest);
  assert.equal(buf.subarray(0, 4).toString(), "MThd");
  assert.equal(buf.readUInt16BE(8), 1, "format 1");
  assert.equal(buf.readUInt16BE(10), r.tracks);
  assert.ok(r.tracks >= 5, "conductor + parts + drums");
  let off = 14;
  let tracks = 0;
  let drumNotes = 0;
  while (off < buf.length) {
    assert.equal(buf.subarray(off, off + 4).toString(), "MTrk");
    const len = buf.readUInt32BE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    for (let i = 0; i < body.length - 2; i++) if (body[i] === 0x99 && body[i + 1] === 36) drumNotes++;
    off += 8 + len;
    tracks++;
  }
  assert.equal(tracks, r.tracks, "chunk lengths are consistent");
  assert.ok(drumNotes > 0, "kick on channel 10");
  assert.ok(buf.includes(Buffer.from([0xff, 0x51, 0x03])), "tempo meta");
  assert.ok(buf.includes(Buffer.from([0xff, 0x59, 0x02])), "key signature meta");
});

test("fitArrangementToDuration lands on whole bars at or just above the target", () => {
  for (const ms of [8_000, 24_000, 61_000, 180_000]) {
    const a = fitArrangementToDuration(planMusic({ assetKind: "soundtrack", subject: "x", style: "rock" }), ms);
    const total = (a.structure.reduce((n, s) => n + s.bars, 0) * 4 * 60_000) / a.bpm;
    assert.ok(total >= ms && total - ms < (4 * 60_000) / a.bpm + 1, `${ms}: got ${total}`);
    assert.equal(a.structure[0]!.name, "intro");
    assert.equal(a.structure[a.structure.length - 1]!.name, "outro");
  }
});

test("generate_soundtrack honors targetDurationMs", async () => {
  const r = await generateSoundtrack({ assetKind: "soundtrack", subject: "night", style: "lo-fi", outDir: tmp, targetDurationMs: 15_000 });
  assert.ok(!isHalt(r));
  if (isHalt(r)) return;
  assert.ok(r.durationMs! >= 15_000 && r.durationMs! < 19_000);
  assert.equal(readWavInfo(r.path)!.channels, 2);
});

test("SFX recipes match the request and render distinct, non-silent sounds", () => {
  assert.equal(chooseRecipe("whoosh transition"), "whoosh");
  assert.equal(chooseRecipe("heavy rain ambience"), "rain");
  assert.equal(chooseRecipe("distant thunder"), "thunder");
  assert.equal(chooseRecipe("notification chime"), "ding");
  assert.equal(chooseRecipe("button click"), "click");
  assert.equal(chooseRecipe("something weird"), "impact");
  const sizes = new Set<number>();
  for (const s of ["whoosh", "rain", "thunder", "wind", "impact", "riser", "click", "ding", "beep", "fire", "footsteps", "ocean", "heartbeat"]) {
    const { info } = renderSfx(s, path.join(tmp, `${s}.wav`));
    assert.ok(info.durationMs > 50, s);
    const buf = fs.readFileSync(path.join(tmp, `${s}.wav`));
    let peak = 0;
    for (let i = 44; i < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
    assert.ok(peak > 8000 && peak < 32767, `${s}: audible and unclipped (peak ${peak})`);
    sizes.add(info.durationMs);
  }
  assert.ok(sizes.size >= 6, "recipes differ");
});
