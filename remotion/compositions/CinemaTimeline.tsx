/**
 * CinemaTimeline — the Remotion composition rendered by the pipeline.
 *
 * It is data-driven: the whole film is described by a `timeline` prop (the
 * pipeline's timeline.json). `calculateCinemaMetadata` reads that prop so the
 * composition's fps, dimensions, and total duration always match the data. Each
 * item becomes a <Sequence> placed at its exact startFrame, so playback tiles
 * with no gaps or overlaps.
 */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
  interpolate,
  useCurrentFrame,
} from "remotion";

export interface TimelineItem {
  id: string;
  shotId: string;
  clipId: string | null;
  startFrame: number;
  durationInFrames: number;
  src: string;
  kind: "video" | "image" | "placeholder";
  transitionInFrames: number;
}

export interface AudioTrackData {
  id: string;
  src: string;
  role: "voiceover" | "soundtrack" | "sfx";
  startFrame: number;
  durationInFrames: number;
  volume: number;
}

export interface TimelineData {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  items: TimelineItem[];
  audioTracks?: AudioTrackData[];
}

export interface CinemaProps {
  timeline: TimelineData;
}

export const defaultTimeline: TimelineData = {
  fps: 30,
  width: 1920,
  height: 1080,
  durationInFrames: 90,
  items: [
    {
      id: "item-1",
      shotId: "demo",
      clipId: null,
      startFrame: 0,
      durationInFrames: 90,
      src: "",
      kind: "placeholder",
      transitionInFrames: 0,
    },
  ],
};

const Clip: React.FC<{ item: TimelineItem }> = ({ item }) => {
  const frame = useCurrentFrame();
  const opacity =
    item.transitionInFrames > 0
      ? interpolate(frame, [0, item.transitionInFrames], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;

  const src = item.src ? staticFile(item.src) : "";

  return (
    <AbsoluteFill style={{ opacity, backgroundColor: "#000" }}>
      {item.kind === "video" && src ? (
        <OffthreadVideo src={src} muted style={fill} />
      ) : src ? (
        <Img src={src} style={fill} />
      ) : (
        <AbsoluteFill
          style={{
            background: "linear-gradient(135deg,#111827,#374151)",
            alignItems: "center",
            justifyContent: "center",
            color: "#9ca3af",
            fontFamily: "Helvetica, Arial, sans-serif",
            fontSize: 40,
          }}
        >
          {item.shotId}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

const fill: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
};

export const CinemaTimeline: React.FC<CinemaProps> = ({ timeline }) => {
  const data = timeline ?? defaultTimeline;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {data.items.map((item) => (
        <Sequence
          key={item.id}
          from={item.startFrame}
          durationInFrames={item.durationInFrames}
          name={item.shotId}
        >
          <Clip item={item} />
        </Sequence>
      ))}
      {(data.audioTracks ?? []).map((track) => (
        <Sequence
          key={track.id}
          from={track.startFrame}
          durationInFrames={track.durationInFrames}
          name={track.role}
        >
          {track.src ? <Audio src={staticFile(track.src)} volume={track.volume} /> : null}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

/** Remotion calculateMetadata: the timeline prop drives duration + dimensions. */
export const calculateCinemaMetadata = ({ props }: { props: CinemaProps }) => {
  const t = props.timeline ?? defaultTimeline;
  return {
    durationInFrames: Math.max(1, t.durationInFrames),
    fps: t.fps,
    width: t.width,
    height: t.height,
  };
};
