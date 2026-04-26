import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONTS } from "../theme";

// The closing line. Two-clause split for emphasis.
export const Claim: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const firstIn = interpolate(frame, [0, fps * 1], [0, 1], {
    extrapolateRight: "clamp",
  });
  const secondIn = interpolate(frame, [fps * 1.6, fps * 2.6], [0, 1], {
    extrapolateRight: "clamp",
  });
  const wmIn = interpolate(frame, [fps * 4, fps * 5], [0, 1], {
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
        flexDirection: "column",
        padding: 120,
      }}
    >
      <div
        style={{
          fontSize: 96,
          fontWeight: 800,
          letterSpacing: -3,
          textAlign: "center",
          opacity: firstIn,
          transform: `translateY(${(1 - firstIn) * 20}px)`,
        }}
      >
        Stop managing the agents.
      </div>
      <div
        style={{
          fontSize: 96,
          fontWeight: 800,
          letterSpacing: -3,
          textAlign: "center",
          color: COLORS.amber,
          marginTop: 24,
          opacity: secondIn,
          transform: `translateY(${(1 - secondIn) * 20}px)`,
        }}
      >
        Shape the landscape they walk on.
      </div>
      <div
        style={{
          marginTop: 140,
          fontSize: 28,
          color: COLORS.inkMuted,
          fontFamily: FONTS.mono,
          letterSpacing: 4,
          opacity: wmIn,
        }}
      >
        github.com/NetaBresler/stigmergy
      </div>
    </AbsoluteFill>
  );
};
