import { Composition } from "remotion";
import {
  StigmergyExplainer,
  calculateMetadata,
  type CompositionProps,
} from "./Composition";
import { FPS, HEIGHT, SCRIPT, WIDTH } from "./narration";

// defaultProps used until calculateMetadata resolves (and as a fallback when
// no manifest is present). Durations come from the script's fallbackSeconds.
const defaultScenes: CompositionProps["scenes"] = SCRIPT.map((s) => ({
  id: s.id,
  durationInFrames: Math.max(1, Math.round(s.fallbackSeconds * FPS)),
  hasAudio: false,
}));

const defaultDuration = defaultScenes.reduce(
  (sum, s) => sum + s.durationInFrames,
  0,
);

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="StigmergyExplainer"
      component={StigmergyExplainer}
      width={WIDTH}
      height={HEIGHT}
      fps={FPS}
      durationInFrames={defaultDuration}
      defaultProps={{ scenes: defaultScenes }}
      calculateMetadata={calculateMetadata}
    />
  );
};
