import React from "react";
import { Composition } from "remotion";
import {
  CinemaTimeline,
  calculateCinemaMetadata,
  defaultTimeline,
} from "./compositions/CinemaTimeline";

/**
 * Registers the CinemaTimeline composition. Duration and dimensions are computed
 * from the `timeline` prop via calculateMetadata, so the placeholders below are
 * only used for the empty Studio preview.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CinemaTimeline"
      component={CinemaTimeline}
      durationInFrames={defaultTimeline.durationInFrames}
      fps={defaultTimeline.fps}
      width={defaultTimeline.width}
      height={defaultTimeline.height}
      defaultProps={{ timeline: defaultTimeline }}
      calculateMetadata={calculateCinemaMetadata}
    />
  );
};
