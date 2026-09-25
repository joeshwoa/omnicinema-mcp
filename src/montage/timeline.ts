/**
 * Auto-Montage Sequencer — timeline builder + validator.
 *
 * Lays every shot's clip end-to-end into a strictly tiled timeline: item i starts
 * exactly where item i-1 ends, so there are never gaps or overlaps.
 *
 * Editorial rules:
 *   - within a scene, shots HARD CUT (the screenplay's continuity frames are
 *     designed as match cuts);
 *   - between scenes, the incoming item dissolves over its first
 *     `transitionInFrames` (the composition holds the outgoing clip underneath,
 *     so it is a true crossfade, not a dip to black);
 *   - stills get gentle Ken Burns motion that matches the shot's camera move;
 *   - the film opens on a title card and fades out at the end.
 */
import fs from "node:fs";
import path from "node:path";
import type { AssetClip, AudioTrack, Caption, Screenplay, Timeline, TimelineItem } from "../types.js";

export interface BuildTimelineOptions {
  /** Crossfade length in frames at scene boundaries (default 0.6 s). */
  transitionFrames?: number;
  /** Also dissolve between shots inside a scene (default false = hard cuts). */
  dissolveWithinScenes?: boolean;
  /** Minimum frames per item, so a rounding-to-zero can never create a gap. */
  minItemFrames?: number;
  /** Show the title card (default true). */
  titleCard?: boolean;
}

export function motionFor(cameraMovement: string): NonNullable<TimelineItem["motion"]> {
  const m = cameraMovement.toLowerCase();
  if (m.includes("push") || m.includes("dolly in") || m.includes("zoom in")) return "push-in";
  if (m.includes("pull") || m.includes("zoom out")) return "pull-out";
  if (m.includes("crane") || m.includes("rise") || m.includes("tilt up")) return "rise";
  if (m.includes("pan left") || m.includes("left")) return "pan-left";
  if (m.includes("pan right") || m.includes("right") || m.includes("track")) return "pan-right";
  if (m.includes("handheld")) return "handheld";
  return "static";
}

export function buildTimeline(
  screenplay: Screenplay,
  clips: AssetClip[],
  opts: BuildTimelineOptions = {},
): Timeline {
  const fps = screenplay.fps;
  const transitionFrames = Math.max(0, opts.transitionFrames ?? Math.round(fps * 0.6));
  const minItemFrames = Math.max(1, opts.minItemFrames ?? 1);

  const clipByShot = new Map(clips.map((c) => [c.shotId, c]));
  const sceneOf = new Map<string, number>();
  screenplay.scenes.forEach((sc, i) => sc.shots.forEach((sh) => sceneOf.set(sh.id, i)));
  const shots = screenplay.scenes.flatMap((s) => s.shots);

  const items: TimelineItem[] = [];
  let cursor = 0;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i]!;
    const clip = clipByShot.get(shot.id);
    const durationInFrames = Math.max(minItemFrames, Math.round(shot.durationSeconds * fps));
    const kind: TimelineItem["kind"] = clip
      ? clip.kind === "video" ? "video" : clip.kind === "image" ? "image" : "placeholder"
      : "placeholder";
    const sceneIndex = sceneOf.get(shot.id) ?? 0;
    const prevScene = i === 0 ? sceneIndex : (sceneOf.get(shots[i - 1]!.id) ?? 0);
    const dissolve = i > 0 && (opts.dissolveWithinScenes || sceneIndex !== prevScene);

    items.push({
      id: `item-${i + 1}`,
      shotId: shot.id,
      clipId: clip?.id ?? null,
      startFrame: cursor,
      durationInFrames,
      src: clip?.localPath ?? "",
      kind,
      transitionInFrames: dissolve ? Math.min(transitionFrames, Math.floor(durationInFrames / 2)) : 0,
      motion: motionFor(shot.cameraMovement),
      sceneIndex,
    });
    cursor += durationInFrames;
  }

  const total = Math.max(1, cursor);
  const timeline: Timeline = {
    fps,
    width: screenplay.width,
    height: screenplay.height,
    durationInFrames: total,
    items,
    fadeOutFrames: Math.min(Math.round(fps * 0.8), Math.floor(total / 4)),
  };
  if (opts.titleCard !== false && screenplay.title) {
    timeline.titleCard = {
      title: screenplay.title,
      subtitle: screenplay.scenes[0]?.heading,
      durationInFrames: Math.min(Math.round(fps * 2.5), Math.floor(total / 2)),
    };
  }
  return timeline;
}

export interface ValidationIssue {
  level: "error" | "warning";
  itemId: string | null;
  message: string;
}

/**
 * Verify the timeline tiles perfectly (no gaps, no overlaps), every item has a
 * positive duration, the declared total matches the sum, and — when projectDir is
 * given — every referenced asset file actually exists on disk (no missing assets).
 */
export function validateTimeline(timeline: Timeline, projectDir?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!timeline.items.length) {
    issues.push({ level: "error", itemId: null, message: "Timeline has no items." });
    return issues;
  }

  const sorted = [...timeline.items].sort((a, b) => a.startFrame - b.startFrame);
  if (sorted[0]!.startFrame !== 0) {
    issues.push({ level: "error", itemId: sorted[0]!.id, message: `First item must start at frame 0 (starts at ${sorted[0]!.startFrame}).` });
  }

  let expected = 0;
  for (const item of sorted) {
    if (item.durationInFrames < 1) {
      issues.push({ level: "error", itemId: item.id, message: `Non-positive duration (${item.durationInFrames}).` });
    }
    if (item.startFrame !== expected) {
      const kind = item.startFrame > expected ? "gap" : "overlap";
      issues.push({
        level: "error",
        itemId: item.id,
        message: `Timeline ${kind}: item starts at ${item.startFrame} but previous content ends at ${expected}.`,
      });
    }
    expected = item.startFrame + item.durationInFrames;

    if (!item.src) {
      issues.push({ level: "error", itemId: item.id, message: "Item has no source asset." });
    } else if (projectDir) {
      const abs = path.join(projectDir, item.src);
      if (!fs.existsSync(abs)) {
        issues.push({ level: "error", itemId: item.id, message: `Missing asset file: ${item.src}` });
      }
    }
    if (item.transitionInFrames > item.durationInFrames) {
      issues.push({ level: "warning", itemId: item.id, message: "Transition longer than the item; will be clamped at render." });
    }
  }

  if (expected !== timeline.durationInFrames) {
    issues.push({
      level: "error",
      itemId: null,
      message: `Declared durationInFrames (${timeline.durationInFrames}) != sum of items (${expected}).`,
    });
  }

  if (projectDir) {
    for (const t of timeline.audioTracks ?? []) {
      if (!fs.existsSync(path.join(projectDir, t.src))) {
        issues.push({ level: "error", itemId: t.id, message: `Missing audio file: ${t.src}` });
      }
    }
  }

  return issues;
}

export function writeTimeline(projectDir: string, timeline: Timeline): string {
  const dest = path.join(projectDir, "timeline.json");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(timeline, null, 2), "utf8");
  return dest;
}

/** Convert a millisecond duration to a frame count at the timeline's fps. */
export function framesFromMs(ms: number, fps: number): number {
  return Math.max(1, Math.round((ms / 1000) * fps));
}

export interface AudioAttachment {
  src: string;
  role: "voiceover" | "soundtrack" | "sfx";
  durationMs: number;
  startFrame?: number;
  volume?: number;
}

const DEFAULT_VOLUME: Record<AudioAttachment["role"], number> = {
  voiceover: 1,
  soundtrack: 0.5,
  sfx: 0.8,
};

/**
 * Attach audio tracks to a timeline, converting precise millisecond durations to
 * frame positions so audio and video stay locked. Soundtracks are trimmed to the
 * picture, faded in/out, and ducked under any voiceover. Returns a new Timeline.
 */
export function attachAudio(timeline: Timeline, attachments: AudioAttachment[]): Timeline {
  const fps = timeline.fps;
  const hasVo = attachments.some((a) => a.role === "voiceover");
  const audioTracks: AudioTrack[] = attachments.map((a, i) => {
    const startFrame = a.startFrame ?? 0;
    const natural = framesFromMs(a.durationMs, fps);
    const track: AudioTrack = {
      id: `audio-${i + 1}`,
      src: a.src,
      role: a.role,
      startFrame,
      durationInFrames: natural,
      durationMs: a.durationMs,
      volume: a.volume ?? DEFAULT_VOLUME[a.role],
    };
    if (a.role === "soundtrack") {
      track.durationInFrames = Math.max(1, Math.min(natural, timeline.durationInFrames - startFrame));
      track.fadeInFrames = Math.round(fps * 1);
      track.fadeOutFrames = Math.min(Math.round(fps * 2), Math.floor(track.durationInFrames / 3));
      if (hasVo) {
        track.duckUnderVoiceover = true;
        track.duckTo = 0.35; // ≈ −9 dB under narration
      }
    }
    return track;
  });
  return { ...timeline, audioTracks };
}

/** Warn if audio runs past the video (or vice-versa) so the operator can trim. */
export function auditAudioSync(timeline: Timeline): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const track of timeline.audioTracks ?? []) {
    const end = track.startFrame + track.durationInFrames;
    if (end > timeline.durationInFrames) {
      issues.push({
        level: "warning",
        itemId: track.id,
        message: `Audio "${track.role}" ends at frame ${end}, past the ${timeline.durationInFrames}-frame video (it will be cut at the end).`,
      });
    }
  }
  return issues;
}

/**
 * Extend the final item so the picture covers `endFrame` (+ a tail), keeping
 * the tiling exact. Used when narration runs longer than the cut.
 */
export function extendToCover(timeline: Timeline, endFrame: number, tailFrames: number): { timeline: Timeline; addedFrames: number } {
  const need = endFrame + tailFrames - timeline.durationInFrames;
  if (need <= 0 || !timeline.items.length) return { timeline, addedFrames: 0 };
  const items = timeline.items.map((it, i) => (i === timeline.items.length - 1 ? { ...it, durationInFrames: it.durationInFrames + need } : it));
  return { timeline: { ...timeline, items, durationInFrames: timeline.durationInFrames + need }, addedFrames: need };
}

/**
 * Split narration into caption cues across [startFrame, startFrame+duration),
 * timed proportionally to each phrase's length (≈ speech rate).
 */
export function buildCaptions(text: string, startFrame: number, durationInFrames: number, maxChars = 64): Caption[] {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  const cues: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChars) {
      cues.push(s);
      continue;
    }
    // Break long sentences at commas/spaces into ≤ maxChars chunks.
    let cur = "";
    for (const w of s.split(" ")) {
      if ((cur + " " + w).trim().length > maxChars && cur) {
        cues.push(cur.trim());
        cur = w;
      } else cur = `${cur} ${w}`;
    }
    if (cur.trim()) cues.push(cur.trim());
  }
  if (!cues.length) return [];
  const weights = cues.map((c) => c.length + 8);
  const total = weights.reduce((a, b) => a + b, 0);
  const out: Caption[] = [];
  let cursor = startFrame;
  cues.forEach((c, i) => {
    const len = i === cues.length - 1 ? startFrame + durationInFrames - cursor : Math.max(1, Math.round((weights[i]! / total) * durationInFrames));
    out.push({ text: c, startFrame: cursor, durationInFrames: Math.max(1, len) });
    cursor += len;
  });
  return out;
}
