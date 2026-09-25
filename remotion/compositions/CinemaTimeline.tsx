/**
 * CinemaTimeline — the Remotion composition rendered by the pipeline.
 *
 * Data-driven: the whole film is the `timeline` prop (the pipeline writes
 * `render-props.json` = { timeline }). `calculateCinemaMetadata` reads it so
 * fps, size and duration always match the data.
 *
 * - Items tile exactly; an item with transitionInFrames > 0 dissolves in OVER
 *   the previous item, which is held (frozen on its last frame if it is a
 *   video) for those frames — a true crossfade.
 * - Stills get Ken Burns motion matching the shot's camera move.
 * - Soundtrack: fade in/out + ducking under the voiceover. Captions and an
 *   opening title card are drawn on top; the film fades to black at the end.
 */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  Freeze,
  Img,
  OffthreadVideo,
  Sequence,
  staticFile,
  interpolate,
  useCurrentFrame,
  Easing,
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
  motion?: "push-in" | "pull-out" | "pan-left" | "pan-right" | "rise" | "handheld" | "static";
  sceneIndex?: number;
}

export interface AudioTrackData {
  id: string;
  src: string;
  role: "voiceover" | "soundtrack" | "sfx";
  startFrame: number;
  durationInFrames: number;
  volume: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  duckUnderVoiceover?: boolean;
  duckTo?: number;
}

export interface CaptionData {
  text: string;
  startFrame: number;
  durationInFrames: number;
}

export interface TimelineData {
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  items: TimelineItem[];
  audioTracks?: AudioTrackData[];
  captions?: CaptionData[];
  titleCard?: { title: string; subtitle?: string; durationInFrames: number };
  fadeOutFrames?: number;
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
    { id: "item-1", shotId: "demo", clipId: null, startFrame: 0, durationInFrames: 90, src: "", kind: "placeholder", transitionInFrames: 0 },
  ],
};

const fill: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
const FONT = "Poppins, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Ken Burns transform for a still over `total` frames. */
function kenBurns(motion: TimelineItem["motion"], frame: number, total: number): string {
  const p = interpolate(frame, [0, Math.max(1, total)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  switch (motion) {
    case "push-in": return `scale(${1.01 + 0.07 * p})`;
    case "pull-out": return `scale(${1.08 - 0.07 * p})`;
    case "pan-left": return `scale(1.07) translateX(${2.5 - 5 * p}%)`;
    case "pan-right": return `scale(1.07) translateX(${-2.5 + 5 * p}%)`;
    case "rise": return `scale(1.07) translateY(${2.5 - 5 * p}%)`;
    case "handheld": return `scale(1.05) translate(${Math.sin(frame / 9) * 0.5}%, ${Math.cos(frame / 13) * 0.4}%)`;
    default: return `scale(${1.02 + 0.03 * p})`;
  }
}

const Clip: React.FC<{ item: TimelineItem; holdFrames: number }> = ({ item, holdFrames }) => {
  const frame = useCurrentFrame();
  const t = Math.min(item.transitionInFrames, item.durationInFrames);
  const opacity = t > 0 ? interpolate(frame, [0, t], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const src = item.src ? staticFile(item.src) : "";
  const total = item.durationInFrames + holdFrames;

  let media: React.ReactNode;
  if (item.kind === "video" && src) {
    const video = <OffthreadVideo src={src} muted style={fill} />;
    // Past the item's own duration we are only the "under" layer of the next
    // item's crossfade: freeze on the last frame instead of reading past EOF.
    media = frame >= item.durationInFrames ? <Freeze frame={item.durationInFrames - 1}>{video}</Freeze> : video;
  } else if (src) {
    media = (
      <AbsoluteFill style={{ transform: kenBurns(item.motion, frame, total), transformOrigin: "50% 50%" }}>
        <Img src={src} style={fill} />
      </AbsoluteFill>
    );
  } else {
    media = (
      <AbsoluteFill style={{ background: "linear-gradient(135deg,#111827,#374151)", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontFamily: FONT, fontSize: 40 }}>
        {item.shotId}
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ opacity, backgroundColor: "#000", overflow: "hidden" }}>{media}</AbsoluteFill>;
};

const TitleCard: React.FC<{ title: string; subtitle?: string; duration: number; width: number }> = ({ title, subtitle, duration, width }) => {
  const frame = useCurrentFrame();
  const inF = Math.min(12, duration / 4);
  const outF = Math.min(18, duration / 3);
  const opacity = interpolate(frame, [0, inF, duration - outF, duration], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const rise = interpolate(frame, [0, duration], [12, 0], { extrapolateRight: "clamp" });
  const u = width / 1920;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity, background: "radial-gradient(ellipse at center, rgba(0,0,0,0.45), rgba(0,0,0,0) 70%)" }}>
      <div style={{ transform: `translateY(${rise * u}px)`, textAlign: "center", color: "#fff", fontFamily: FONT }}>
        <div style={{ fontSize: 96 * u, fontWeight: 700, letterSpacing: 2 * u, textShadow: "0 4px 24px rgba(0,0,0,0.6)" }}>{title}</div>
        {subtitle ? <div style={{ marginTop: 18 * u, fontSize: 28 * u, letterSpacing: 8 * u, opacity: 0.8, textTransform: "uppercase" }}>{subtitle}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

const CaptionView: React.FC<{ text: string; duration: number; width: number }> = ({ text, duration, width }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 4, duration - 4, duration], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const u = width / 1920;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 80 * u, opacity }}>
      <div style={{ maxWidth: "80%", textAlign: "center", color: "#fff", fontFamily: FONT, fontSize: 44 * u, fontWeight: 600, lineHeight: 1.3, padding: `${10 * u}px ${24 * u}px`, borderRadius: 10 * u, background: "rgba(0,0,0,0.55)" }}>
        {text}
      </div>
    </AbsoluteFill>
  );
};

/** Soundtrack/sfx gain envelope: fades + duck under the voiceover. */
function trackVolume(track: AudioTrackData, voRanges: [number, number][], localFrame: number): number {
  const global = track.startFrame + localFrame;
  let v = track.volume;
  const fi = track.fadeInFrames ?? 0;
  const fo = track.fadeOutFrames ?? 0;
  if (fi > 0) v *= interpolate(localFrame, [0, fi], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (fo > 0) v *= interpolate(localFrame, [track.durationInFrames - fo, track.durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (track.duckUnderVoiceover) {
    const ramp = 8;
    let duck = 0;
    for (const [a, b] of voRanges) {
      duck = Math.max(duck, interpolate(global, [a - ramp, a, b, b + ramp * 2], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
    }
    v *= 1 - duck * (1 - (track.duckTo ?? 0.35));
  }
  return Math.max(0, Math.min(1, v));
}

export const CinemaTimeline: React.FC<CinemaProps> = ({ timeline }) => {
  const data = timeline ?? defaultTimeline;
  const frame = useCurrentFrame();
  const voRanges: [number, number][] = (data.audioTracks ?? []).filter((t) => t.role === "voiceover").map((t) => [t.startFrame, t.startFrame + t.durationInFrames]);
  const fo = data.fadeOutFrames ?? 0;
  const endFade = fo > 0 ? interpolate(frame, [data.durationInFrames - fo, data.durationInFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {data.items.map((item, i) => {
        const next = data.items[i + 1];
        const hold = next ? Math.min(next.transitionInFrames, next.durationInFrames) : 0;
        return (
          <Sequence key={item.id} from={item.startFrame} durationInFrames={item.durationInFrames + hold} name={item.shotId}>
            <Clip item={item} holdFrames={hold} />
          </Sequence>
        );
      })}
      {(data.captions ?? []).map((c, i) => (
        <Sequence key={`cap-${i}`} from={c.startFrame} durationInFrames={c.durationInFrames} name="caption">
          <CaptionView text={c.text} duration={c.durationInFrames} width={data.width} />
        </Sequence>
      ))}
      {data.titleCard ? (
        <Sequence from={0} durationInFrames={data.titleCard.durationInFrames} name="title">
          <TitleCard title={data.titleCard.title} subtitle={data.titleCard.subtitle} duration={data.titleCard.durationInFrames} width={data.width} />
        </Sequence>
      ) : null}
      {(data.audioTracks ?? []).map((track) => (
        <Sequence key={track.id} from={track.startFrame} durationInFrames={track.durationInFrames} name={track.role}>
          {track.src ? <Audio src={staticFile(track.src)} volume={(f) => trackVolume(track, voRanges, f)} /> : null}
        </Sequence>
      ))}
      {fo > 0 ? <AbsoluteFill style={{ backgroundColor: "#000", opacity: endFade }} /> : null}
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
