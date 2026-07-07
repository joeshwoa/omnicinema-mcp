/**
 * Shared domain types for the cinema pipeline.
 *
 * The data flows: prompt -> Screenplay (scenes -> shots, each shot carries an
 * opening + closing ContinuityFrame) -> AssetClip[] (one acquired clip per shot)
 * -> Timeline (frame-accurate, gap/overlap-free) -> rendered video.
 */

/** A precise description of a single frame, used to chain shot continuity. */
export interface ContinuityFrame {
  /** What is visible: composition, subject placement, framing. */
  composition: string;
  /** Camera framing, e.g. "wide", "medium", "close-up", "over-the-shoulder". */
  framing: string;
  /** Lighting description, e.g. "low-key blue dusk, rim light from left". */
  lighting: string;
  /** Dominant color palette, used to keep grading continuous. */
  palette: string[];
  /** Where the subject sits in frame at this instant. */
  subjectPosition: string;
}

export interface Shot {
  id: string;
  sceneId: string;
  index: number;
  /** One-line action description of the shot. */
  action: string;
  /** Camera movement, e.g. "slow push-in", "static", "pan left". */
  cameraMovement: string;
  durationSeconds: number;
  /**
   * The opening frame of this shot. For every shot after the first, this MUST
   * match the previous shot's closingFrame so cuts feel continuous.
   */
  openingFrame: ContinuityFrame;
  /** The final frame of this shot; the next shot opens from here. */
  closingFrame: ContinuityFrame;
  /** Keywords used to search stock providers / prompt generative providers. */
  keywords: string[];
  /** A ready-to-use search/generation query derived from the shot. */
  assetQuery: string;
}

export interface Scene {
  id: string;
  index: number;
  /** Screenplay slugline, e.g. "EXT. NEON ALLEY - NIGHT". */
  heading: string;
  summary: string;
  shots: Shot[];
}

export interface Screenplay {
  title: string;
  logline: string;
  prompt: string;
  style: string;
  fps: number;
  width: number;
  height: number;
  scenes: Scene[];
  /** True if an LLM enriched the deterministic scaffold. */
  enriched: boolean;
}

export type ClipSource = "stock" | "generative" | "placeholder" | "user";

export interface AssetClip {
  id: string;
  shotId: string;
  source: ClipSource;
  /** Provider slug, e.g. "pexels", "pixabay", "replicate", or "none". */
  provider: string;
  /** Remote URL the asset was fetched from (empty for placeholders). */
  remoteUrl: string;
  /** Path relative to the project directory (used by Remotion staticFile). */
  localPath: string;
  durationSeconds: number;
  kind: "video" | "image" | "placeholder";
  width: number;
  height: number;
  /** License string, e.g. "Pexels License". */
  license: string;
  /** Attribution string to satisfy provider requirements. */
  attribution: string;
}

export interface TimelineItem {
  id: string;
  shotId: string;
  clipId: string | null;
  /** Absolute start position on the timeline, in frames. */
  startFrame: number;
  /** Length of this item in frames. Consecutive items must tile with no gaps. */
  durationInFrames: number;
  /** Path relative to the project dir, consumed by the Remotion composition. */
  src: string;
  kind: "video" | "image" | "placeholder";
  /** Crossfade length in frames applied at the head of this item (0 = hard cut). */
  transitionInFrames: number;
}

export interface AudioTrack {
  id: string;
  /** Path relative to the project dir (Remotion staticFile). */
  src: string;
  role: "voiceover" | "soundtrack" | "sfx";
  startFrame: number;
  durationInFrames: number;
  /** Precise source duration, carried through from the audio engine. */
  durationMs: number;
  /** Linear volume 0..1 (soundtracks are ducked under narration). */
  volume: number;
}

export interface Timeline {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  items: TimelineItem[];
  /** Optional audio tracks locked to the video by frame position. */
  audioTracks?: AudioTrack[];
}

export type WorkflowMode = "fully_automated" | "interactive_montage";

export interface PipelineReport {
  projectId: string;
  projectPath: string;
  mode: WorkflowMode;
  title: string;
  logline: string;
  sceneCount: number;
  shotCount: number;
  screenplayPath: string;
  timelinePath: string;
  remotionProjectPath: string;
  renderedVideoPath: string | null;
  assets: {
    total: number;
    bySource: Record<string, number>;
  };
  /** Optional audio tracks attached to the timeline. */
  audio?: { role: string; src: string; durationMs: number }[];
  warnings: string[];
  nextSteps: string[];
  paused: boolean;
}
