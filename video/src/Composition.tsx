import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import { FPS, SCRIPT, type SceneId } from "./narration";
import { Title } from "./scenes/Title";
import { Hierarchy } from "./scenes/Hierarchy";
import { Termites } from "./scenes/Termites";
import { Principle } from "./scenes/Principle";
import { Medium } from "./scenes/Medium";
import { Decay } from "./scenes/Decay";
import { Primitives } from "./scenes/Primitives";
import { Claim } from "./scenes/Claim";

const SCENE_COMPONENTS: Record<SceneId, React.FC> = {
  title: Title,
  hierarchy: Hierarchy,
  termites: Termites,
  principle: Principle,
  medium: Medium,
  decay: Decay,
  primitives: Primitives,
  claim: Claim,
};

// Padding lets each scene's visuals breathe past the end of the audio so
// the cut doesn't feel rushed. Tuned by feel, not by math.
const SCENE_TAIL_PADDING_SECONDS = 0.6;

export type SceneTiming = {
  id: SceneId;
  durationInFrames: number;
  hasAudio: boolean;
};

export type CompositionProps = {
  scenes: SceneTiming[];
};

export const StigmergyExplainer: React.FC<CompositionProps> = ({ scenes }) => {
  let cursor = 0;
  return (
    <AbsoluteFill>
      {scenes.map((scene) => {
        const Scene = SCENE_COMPONENTS[scene.id];
        const start = cursor;
        cursor += scene.durationInFrames;
        return (
          <Sequence
            key={scene.id}
            from={start}
            durationInFrames={scene.durationInFrames}
            name={scene.id}
          >
            <Scene />
            {scene.hasAudio && (
              <Audio src={staticFile(`narration/${scene.id}.mp3`)} />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

type Manifest = {
  scenes: { id: SceneId; file: string; durationSeconds: number }[];
};

// Pulls per-scene durations from public/narration/manifest.json when it exists,
// so the composition timing matches the actual ElevenLabs audio. Falls back to
// the script's fallback durations for studio preview before audio is generated.
export const calculateMetadata: CalculateMetadataFunction<CompositionProps> = async () => {
  let manifest: Manifest | null = null;
  try {
    const res = await fetch(staticFile("narration/manifest.json"));
    if (res.ok) {
      manifest = (await res.json()) as Manifest;
    }
  } catch {
    // No manifest yet — that's fine.
  }

  const scenes: SceneTiming[] = SCRIPT.map((scene) => {
    const entry = manifest?.scenes.find((s) => s.id === scene.id);
    const seconds = entry
      ? entry.durationSeconds + SCENE_TAIL_PADDING_SECONDS
      : scene.fallbackSeconds;
    return {
      id: scene.id,
      durationInFrames: Math.max(1, Math.round(seconds * FPS)),
      hasAudio: Boolean(entry),
    };
  });

  const total = scenes.reduce((s, sc) => s + sc.durationInFrames, 0);
  return {
    durationInFrames: total,
    props: { scenes },
  };
};
