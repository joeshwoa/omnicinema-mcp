/**
 * Montage: editorial rules in the timeline (hard cuts in-scene, dissolves at
 * scene changes, Ken Burns motion), audio attach (trim/fade/duck), captions,
 * narration extension, reorder re-tiling, and the ffmpeg assembly fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { attachAudio, buildCaptions, buildTimeline, extendToCover, motionFor, validateTimeline } from "../src/montage/timeline.js";
import { assembleWithFfmpeg } from "../src/montage/assemble.js";
import { retile } from "../src/pipeline/runCinemaPipeline.js";
import { buildScreenplay } from "../src/pipeline/script-engine.js";
import { generateStoryboardFrameSvg } from "../src/assets/vector.js";
import { rasterizeSvg } from "../src/assets/raster.js";
import { writeWavPcm16 } from "../src/audio/wav.js";
import type { AssetClip } from "../src/types.js";
import { hasBinary } from "./helpers.js";

const SP = buildScreenplay({ prompt: "a keeper watching a storm over the sea", sceneCount: 2, shotsPerScene: 2, shotDurationSeconds: 2, fps: 12, width: 320, height: 180 });
const clips: AssetClip[] = SP.scenes.flatMap((s) => s.shots).map((s) => ({
  id: `clip-${s.id}`, shotId: s.id, source: "placeholder", provider: "offline-storyboard", remoteUrl: "", localPath: `${s.id}.png`,
  durationSeconds: s.durationSeconds, kind: "image", width: 320, height: 180, license: "MIT", attribution: "test",
}));

test("hard cuts inside a scene, dissolve only at the scene change", () => {
  const t = buildTimeline(SP, clips);
  assert.deepEqual(t.items.map((i) => i.transitionInFrames > 0), [false, false, true, false]);
  assert.equal(validateTimeline(t).filter((i) => i.level === "error").length, 0);
  assert.ok(t.titleCard && t.titleCard.durationInFrames > 0);
  assert.ok((t.fadeOutFrames ?? 0) > 0);
});

test("Ken Burns motion follows the camera move", () => {
  assert.equal(motionFor("slow push-in"), "push-in");
  assert.equal(motionFor("slow pull-out"), "pull-out");
  assert.equal(motionFor("crane up and pull back"), "pull-out");
  assert.equal(motionFor("gentle pan left"), "pan-left");
  assert.equal(motionFor("handheld follow"), "handheld");
  assert.equal(motionFor("static locked-off"), "static");
});

test("soundtrack is trimmed to the picture, faded, and ducked under voiceover", () => {
  const t = buildTimeline(SP, clips);
  const withAudio = attachAudio(t, [
    { src: "vo.wav", role: "voiceover", durationMs: 3000, startFrame: 6 },
    { src: "music.wav", role: "soundtrack", durationMs: 120_000 },
  ]);
  const music = withAudio.audioTracks!.find((a) => a.role === "soundtrack")!;
  assert.equal(music.durationInFrames, t.durationInFrames, "music never runs past the picture");
  assert.ok(music.fadeInFrames! > 0 && music.fadeOutFrames! > 0);
  assert.equal(music.duckUnderVoiceover, true);
});

test("captions cover the narration span exactly, in order", () => {
  const caps = buildCaptions("Every night for forty years, he kept the light burning. Tonight, the sea wanted it back.", 10, 140);
  assert.equal(caps.length, 2);
  assert.equal(caps[0]!.startFrame, 10);
  assert.equal(caps[caps.length - 1]!.startFrame + caps[caps.length - 1]!.durationInFrames, 150);
  for (let i = 1; i < caps.length; i++) assert.equal(caps[i]!.startFrame, caps[i - 1]!.startFrame + caps[i - 1]!.durationInFrames);
  const long = buildCaptions("word ".repeat(40).trim(), 0, 100, 40);
  assert.ok(long.every((c) => c.text.length <= 40));
});

test("extendToCover holds the last shot and keeps perfect tiling", () => {
  const t = buildTimeline(SP, clips);
  const { timeline, addedFrames } = extendToCover(t, t.durationInFrames + 20, 5);
  assert.equal(addedFrames, 25);
  assert.equal(validateTimeline(timeline).filter((i) => i.level === "error").length, 0);
  assert.equal(extendToCover(t, 10, 0).addedFrames, 0);
});

test("reordering re-derives transitions from the new neighbours", () => {
  const t = buildTimeline(SP, clips);
  const reversed = retile(t, [...t.items].reverse());
  assert.equal(validateTimeline(reversed).filter((i) => i.level === "error").length, 0);
  assert.deepEqual(reversed.items.map((i) => i.transitionInFrames > 0), [false, false, true, false]);
});

test("ffmpeg assembly renders the exact frame count with audio (skips without ffmpeg)", async (t) => {
  if (!hasBinary("ffmpeg")) return t.skip("ffmpeg not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-asm-"));
  for (const [i, shot] of SP.scenes.flatMap((s) => s.shots).entries()) {
    const svg = path.join(dir, `${shot.id}.svg`);
    generateStoryboardFrameSvg({ filmTitle: "T", sceneHeading: "EXT. SEA — DUSK", shotId: shot.id, shotNumber: i + 1, shotCount: 4, action: shot.action, framing: shot.closingFrame.framing, cameraMovement: shot.cameraMovement, lighting: "dusk", subjectPosition: "left", palette: shot.closingFrame.palette, durationSeconds: 2, keywords: shot.keywords }, svg, 320, 180);
    if (!(await rasterizeSvg(svg, path.join(dir, `${shot.id}.png`), 320, 180))) return t.skip("no SVG rasterizer");
  }
  const sr = 48000;
  const tone = new Float32Array(sr * 3).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / sr));
  writeWavPcm16(path.join(dir, "music.wav"), tone, sr);
  let tl = buildTimeline(SP, clips);
  tl = attachAudio(tl, [{ src: "music.wav", role: "soundtrack", durationMs: 3000 }]);
  tl.captions = buildCaptions("Hello there. General test.", 3, 30);
  const out = path.join(dir, "out.mp4");
  const res = await assembleWithFfmpeg(tl, dir, out);
  assert.ok(res.ok, `${res.reason} ${res.log}`);
  const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,width,height", "-of", "compact", out]).stdout.toString();
  assert.match(probe, /codec_type=video\|width=320\|height=180\|nb_read_frames=96/, probe);
  assert.match(probe, /codec_type=audio/);
});
