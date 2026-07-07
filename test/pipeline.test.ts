/**
 * Evaluation / test suite (run: `npm run eval`).
 *
 * Verifies the two guarantees the pipeline must uphold:
 *   1. Shot-to-shot frame continuity — each shot opens on the previous shot's
 *      closing frame.
 *   2. A renderable timeline — strictly tiled (no gaps, no overlaps) with every
 *      referenced asset present on disk.
 *
 * The end-to-end case is hermetic: it clears provider keys so it runs fully
 * offline with generated placeholders and makes no network calls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { buildScreenplay, verifyContinuity } from "../src/pipeline/script-engine.js";
import { buildTimeline, validateTimeline } from "../src/montage/timeline.js";
import { runCinemaPipeline } from "../src/pipeline/runCinemaPipeline.js";
import type { AssetClip, Timeline } from "../src/types.js";

const BASE = {
  prompt: "a lone lighthouse keeper watching a storm roll in over a cold northern sea",
  fps: 30,
  width: 1920,
  height: 1080,
};

test("screenplay chains every shot's opening frame to the previous closing frame", () => {
  const sp = buildScreenplay({ ...BASE, sceneCount: 4, shotsPerScene: 3 });
  assert.equal(verifyContinuity(sp).length, 0, "verifyContinuity should report no breaks");

  const shots = sp.scenes.flatMap((s) => s.shots);
  assert.ok(shots.length >= 8, "expected several shots");
  for (let i = 1; i < shots.length; i++) {
    assert.deepEqual(
      shots[i]!.openingFrame,
      shots[i - 1]!.closingFrame,
      `shot ${i} must open on shot ${i - 1}'s closing frame`,
    );
  }
});

test("screenplay generation is deterministic for a given prompt", () => {
  const a = buildScreenplay({ ...BASE, sceneCount: 3, shotsPerScene: 2 });
  const b = buildScreenplay({ ...BASE, sceneCount: 3, shotsPerScene: 2 });
  assert.deepEqual(a, b, "same inputs must produce the same screenplay");
});

test("timeline tiles with no gaps or overlaps, and the validator catches a gap", () => {
  const sp = buildScreenplay({ ...BASE, sceneCount: 3, shotsPerScene: 2, shotDurationSeconds: 4 });
  const shots = sp.scenes.flatMap((s) => s.shots);
  const clips: AssetClip[] = shots.map((s) => ({
    id: `clip-${s.id}`,
    shotId: s.id,
    source: "placeholder",
    provider: "none",
    remoteUrl: "",
    localPath: `${s.id}.svg`,
    durationSeconds: s.durationSeconds,
    kind: "placeholder",
    width: sp.width,
    height: sp.height,
    license: "n/a",
    attribution: "test",
  }));

  const timeline = buildTimeline(sp, clips);
  // Validate structure only (no projectDir → skip file-existence check).
  const clean = validateTimeline(timeline);
  assert.equal(clean.filter((i) => i.level === "error").length, 0, "well-formed timeline has no errors");

  // Contiguity: each item starts exactly where the previous ended.
  const items = [...timeline.items].sort((a, b) => a.startFrame - b.startFrame);
  let cursor = 0;
  for (const it of items) {
    assert.equal(it.startFrame, cursor, `item ${it.id} must be contiguous`);
    cursor += it.durationInFrames;
  }
  assert.equal(cursor, timeline.durationInFrames, "declared duration equals sum of items");

  // Introduce a gap and confirm the validator flags it.
  const broken: Timeline = structuredClone(timeline);
  broken.items[1]!.startFrame += 5;
  const issues = validateTimeline(broken);
  assert.ok(
    issues.some((i) => i.level === "error" && /gap|overlap/.test(i.message)),
    "validator must detect a gap/overlap",
  );
});

test("end-to-end (offline placeholders): validates and writes all artifacts, no missing assets", async () => {
  // Force fully-offline placeholder mode: clear all provider keys.
  for (const k of [
    "PEXELS_API_KEY", "PIXABAY_API_KEY", "UNSPLASH_ACCESS_KEY",
    "REPLICATE_API_TOKEN", "REPLICATE_VIDEO_MODEL", "FAL_API_KEY", "FAL_VIDEO_MODEL",
    "HUGGINGFACE_API_TOKEN", "HF_VIDEO_MODEL", "ANTHROPIC_API_KEY",
  ]) {
    delete process.env[k];
  }

  const report = await runCinemaPipeline({
    prompt: BASE.prompt,
    workflow_mode: "fully_automated",
    sceneCount: 3,
    shotsPerScene: 2,
    fps: 24,
    render: false,
    enrich: false,
  });

  assert.ok(report.shotCount >= 6, "expected at least 6 shots");
  assert.ok(fs.existsSync(report.screenplayPath), "screenplay.md written");
  assert.ok(fs.existsSync(report.timelinePath), "timeline.json written");
  assert.ok(fs.existsSync(path.join(report.projectPath, "manifest.json")), "manifest.json written");
  assert.ok(fs.existsSync(path.join(report.projectPath, "attributions.txt")), "attributions written");

  const timeline = JSON.parse(fs.readFileSync(report.timelinePath, "utf8")) as Timeline;
  const issues = validateTimeline(timeline, report.projectPath);
  const errors = issues.filter((i) => i.level === "error");
  assert.equal(errors.length, 0, `timeline must be valid; got: ${JSON.stringify(errors)}`);

  // Every referenced asset exists on disk (no missing assets).
  for (const item of timeline.items) {
    assert.ok(
      fs.existsSync(path.join(report.projectPath, item.src)),
      `asset must exist: ${item.src}`,
    );
  }
});

test("interactive_montage mode pauses after acquisition and does not render", async () => {
  const report = await runCinemaPipeline({
    prompt: BASE.prompt,
    workflow_mode: "interactive_montage",
    sceneCount: 2,
    shotsPerScene: 2,
    render: false,
    enrich: false,
  });
  assert.equal(report.paused, true, "interactive mode must pause");
  assert.equal(report.renderedVideoPath, null, "must not render while paused");
  assert.ok(
    report.nextSteps.some((s) => s.includes("compile_montage")),
    "next steps should point to compile_montage",
  );
});

test("optional narration + soundtrack lock audio tracks to the timeline", async () => {
  const report = await runCinemaPipeline({
    prompt: BASE.prompt,
    workflow_mode: "fully_automated",
    sceneCount: 2,
    shotsPerScene: 2,
    fps: 24,
    render: false,
    enrich: false,
    narration: "The lighthouse held its ground against the black water.",
    soundtrack: true,
    musicStyle: "cinematic orchestral",
  });

  assert.ok(report.audio && report.audio.length === 2, "voiceover + soundtrack attached");
  for (const track of report.audio!) {
    assert.ok(track.durationMs > 0, `${track.role} has a duration`);
    assert.ok(fs.existsSync(path.join(report.projectPath, track.src)), `audio file exists: ${track.src}`);
  }

  const timeline = JSON.parse(fs.readFileSync(report.timelinePath, "utf8")) as Timeline & {
    audioTracks?: { role: string; startFrame: number; durationInFrames: number }[];
  };
  assert.ok(timeline.audioTracks && timeline.audioTracks.length === 2, "timeline carries audio tracks");
  assert.ok(timeline.audioTracks!.every((t) => t.durationInFrames > 0), "audio tracks have frame durations");
});
