import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONTS } from "../theme";

export const Title: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleIn = spring({ frame, fps, config: { damping: 200 } });
  const subOpacity = interpolate(frame, [fps * 0.6, fps * 1.4], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        fontFamily: FONTS.display,
        color: COLORS.ink,
        alignItems: "center",
        justifyContent: "center",
        padding: 120,
      }}
    >
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <PheromoneField frame={frame} />
      </AbsoluteFill>

      <div
        style={{
          transform: `translateY(${(1 - titleIn) * 40}px)`,
          opacity: titleIn,
          textAlign: "center",
          zIndex: 1,
        }}
      >
        <div
          style={{
            fontSize: 220,
            fontWeight: 800,
            letterSpacing: -8,
            lineHeight: 0.95,
            color: COLORS.ink,
          }}
        >
          Stigmergy
        </div>
        <div
          style={{
            fontSize: 36,
            fontWeight: 400,
            color: COLORS.amber,
            marginTop: 28,
            letterSpacing: 4,
            textTransform: "uppercase",
            opacity: subOpacity,
          }}
        >
          coordinating agents without a manager
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Slow drifting amber dots — visual nod to a pheromone field.
const PheromoneField: React.FC<{ frame: number }> = ({ frame }) => {
  const dots = Array.from({ length: 60 }, (_, i) => {
    const seed = i * 9301 + 49297;
    const x = (seed % 1920) | 0;
    const y = ((seed * 7) % 1080) | 0;
    const drift = Math.sin((frame + i * 11) / 60) * 14;
    const pulse =
      0.25 + 0.55 * (0.5 + 0.5 * Math.sin((frame + i * 17) / 30));
    const r = 4 + (i % 5);
    return (
      <div
        key={i}
        style={{
          position: "absolute",
          left: x + drift,
          top: y - drift,
          width: r * 2,
          height: r * 2,
          borderRadius: "50%",
          background: COLORS.amber,
          opacity: pulse * 0.4,
          filter: "blur(6px)",
        }}
      />
    );
  });
  return <>{dots}</>;
};
