import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS } from "./theme";

// A faint always-on layer of drifting amber motes — visual continuity
// across scenes so the frame never feels static, even on the long
// title/quote scenes.
export const AmbientField: React.FC<{ density?: number; opacity?: number }> = ({
  density = 24,
  opacity = 0.18,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
      {Array.from({ length: density }, (_, i) => {
        // Deterministic pseudo-random spawn point per particle.
        const seed = i * 9301 + 49297;
        const baseX = seed % width;
        const baseY = (seed * 7) % height;
        const phase = i * 13;
        const drift = Math.sin((frame + phase) / 80) * 24;
        const driftY = Math.cos((frame + phase) / 90) * 20;
        // Slow brightness pulse, individually phased.
        const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((frame + phase) / 40));
        const r = 2 + (i % 6);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: baseX + drift,
              top: baseY + driftY,
              width: r * 2,
              height: r * 2,
              borderRadius: "50%",
              background: COLORS.amber,
              opacity: opacity * pulse,
              filter: "blur(8px)",
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
