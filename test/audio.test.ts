/**
 * Audio engine tests: local music synthesis duration accuracy, valid WAV/MIDI
 * output, voiceover duration estimation, genre routing, and duration measurement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSoundtrack, generateVoiceover, estimateSpeechMs, measureDurationMs } from "../src/pipeline/audio-engine.js";
import { isHalt } from "../src/pipeline/asset-results.js";
import { readWavInfo } from "../src/audio/wav.js";
import type { MusicArrangement } from "../src/personas/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-audio-"));

test("local soundtrack synthesis: exact duration, valid WAV + MIDI", async () => {
  const r = await generateSoundtrack({ assetKind: "soundtrack", subject: "night drive", style: "lo-fi", outDir: tmp });
  assert.ok(!isHalt(r));
  if (isHalt(r)) return;
  assert.equal(r.provider, "local-synth");
  const arr = r.meta!.arrangement as MusicArrangement;
  const totalBars = arr.structure.reduce((n, s) => n + s.bars, 0);
  const expectedMs = Math.round((totalBars * 4 * 60_000) / arr.bpm);
  assert.equal(r.durationMs, expectedMs, "engine duration must equal arrangement math");

  const wav = readWavInfo(r.path);
  assert.ok(wav, "output must be a valid WAV");
  assert.equal(wav!.durationMs, expectedMs, "WAV header duration must match");

  const midiPath = r.meta!.midiPath as string;
  assert.ok(fs.existsSync(midiPath), "MIDI file written");
  assert.equal(fs.readFileSync(midiPath).slice(0, 4).toString("ascii"), "MThd", "valid MIDI header");
});

test("genre routing selects the right tempo/key", async () => {
  const hh = await generateSoundtrack({ assetKind: "soundtrack", subject: "boom bap", style: "hip hop", outDir: tmp });
  assert.ok(!isHalt(hh));
  if (isHalt(hh)) return;
  const arr = hh.meta!.arrangement as MusicArrangement;
  assert.equal(arr.genre, "hip-hop");
  assert.equal(arr.bpm, 88);
});

test("offline voiceover returns a valid WAV with a positive duration", async () => {
  const r = await generateVoiceover({ assetKind: "voiceover", subject: "In a world of silence, one signal remained.", style: "dramatic", outDir: tmp });
  assert.ok(!isHalt(r));
  if (isHalt(r)) return;
  assert.equal(r.provider, "offline-tone");
  assert.ok((r.durationMs ?? 0) > 0);
  assert.ok(readWavInfo(r.path), "valid WAV");
});

test("estimateSpeechMs scales with words and pacing", () => {
  const fast = estimateSpeechMs("one two three four five six", 180, 0);
  const slow = estimateSpeechMs("one two three four five six", 90, 0);
  assert.ok(slow > fast, "slower pacing yields a longer estimate");
  assert.ok(estimateSpeechMs("hi", 150, 0) >= 800, "there is a sensible minimum");
});

test("measureDurationMs reads a WAV header exactly", async () => {
  const r = await generateSoundtrack({ assetKind: "soundtrack", subject: "measure me", style: "electronic", outDir: tmp });
  assert.ok(!isHalt(r));
  if (isHalt(r)) return;
  const measured = await measureDurationMs(r.path);
  assert.equal(measured, r.durationMs);
});
