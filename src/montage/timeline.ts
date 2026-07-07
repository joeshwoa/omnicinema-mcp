/**
 * Auto-Montage Sequencer — timeline builder + validator.
 *
 * Lays every shot's clip end-to-end into a strictly tiled timeline: item i starts
 * exactly where item i-1 ends, so there are never gaps or overlaps. Transitions
 * are expressed as a fade-in over each item's OWN leading frames (handled inside
 * the Remotion composition), which keeps the tiling exact while still dissolving
 * between shots.
 */
import fs from "node:fs";
import path from "node:path";
import type { AssetClip, AudioTrack, Screenplay, Timeline, TimelineItem } from "../types.js";

export interface BuildTimelineOptions {
  /** Crossfade length in frames applied at the head of each item after the first. */
  transitionFrames?: number;
  /** Minimum frames per item, so a rounding-to-zero can never create a gap. */
  minItemFrames?: number;
}

export function buildTimeline(
  screenplay: Screenplay,
  clips: AssetClip[],
  opts: BuildTimelineOptions = {},
): Timeline {
  const fps = screenplay.fps;
  const transitionFrames = Math.max(0, opts.transitionFrames ?? Math.round(fps * 0.4));
  const minItemFrames = Math.max(1, opts.minItemFrames ?? 1);

  const clipByShot = new Map(clips.map((c) => [c.shotId, c]));
  const shots = screenplay.scenes.flatMap((s) => s.shots);

  const items: TimelineItem[] = [];
  let cursor = 0;
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i]!;
    const clip = clipByShot.get(shot.id);
    const durationInFrames = Math.max(
      minItemFrames,
      Math.round(shot.durationSeconds * fps),
    );
    const kind: TimelineItem["kind"] = clip
      ? clip.kind === "video"
        ? "video"
        : clip.kind === "image"
          ? "image"
          : "placeholder"
      : "placeholder";

    items.push({
      id: `item-${i + 1}`,
      shotId: shot.id,
      clipId: clip?.id ?? null,
      startFrame: cursor,
      durationInFrames,
      src: clip?.localPath ?? "",
      kind,
      transitionInFrames: i === 0 ? 0 : Math.min(transitionFrames, durationInFrames),
    });
    cursor += durationInFrames;
  }

  return {
    fps,
    width: screenplay.width,
    height: screenplay.height,
    durationInFrames: Math.max(1, cursor),
    items,
  };
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
  soundtrack: 0.35, // ducked under narration
  sfx: 0.8,
};

/**
 * Attach audio tracks to a timeline, converting precise millisecond durations to
 * frame positions so audio and video stay locked. Returns a new Timeline.
 */
export function attachAudio(timeline: Timeline, attachments: AudioAttachment[]): Timeline {
  const audioTracks: AudioTrack[] = attachments.map((a, i) => ({
    id: `audio-${i + 1}`,
    src: a.src,
    role: a.role,
    startFrame: a.startFrame ?? 0,
    durationInFrames: framesFromMs(a.durationMs, timeline.fps),
    durationMs: a.durationMs,
    volume: a.volume ?? DEFAULT_VOLUME[a.role],
  }));
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
        message: `Audio "${track.role}" ends at frame ${end}, past the ${timeline.durationInFrames}-frame video (Remotion will trim it).`,
      });
    }
  }
  return issues;
}
