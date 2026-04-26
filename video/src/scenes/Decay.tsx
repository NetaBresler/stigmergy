import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONTS } from "../theme";

// Decay is the load-bearing primitive. Show four signals; one gets
// reinforced, three fade away. No words explain what's happening — the
// visual does.
export const Decay: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const headlineIn = interpolate(frame, [0, fps * 0.7], [0, 1], {
    extrapolateRight: "clamp",
  });

  const signals = [
    { label: "candidate · doc_typo", reinforced: false },
    { label: "candidate · auth_bug", reinforced: true },
    { label: "candidate · stale_pr", reinforced: false },
    { label: "candidate · todo_old", reinforced: false },
  ];

  const t = Math.max(0, (frame - fps * 1) / (fps * 8));

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        fontFamily: FONTS.display,
        color: COLORS.ink,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 110,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 76,
          fontWeight: 700,
          letterSpacing: -2,
          opacity: headlineIn,
        }}
      >
        Stale signals <span style={{ color: COLORS.amber }}>evaporate.</span>
      </div>

      <div
        style={{
          position: "absolute",
          top: 220,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 30,
          color: COLORS.inkMuted,
          fontFamily: FONTS.mono,
          letterSpacing: 2,
        }}
      >
        strength × 0.9 per tick · unless reinforced
      </div>

      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {signals.map((s, i) => {
          const rowY = 380 + i * 130;
          // Reinforced signal stays at ~1.0 — actually pulses higher.
          const strength = s.reinforced
            ? 0.95 + 0.05 * Math.sin(frame / 8)
            : Math.max(0.05, Math.pow(0.9, t * 30));
          const opacity = s.reinforced ? 1 : Math.max(0.2, strength + 0.2);
          const barW = 1100 * strength;
          return (
            <g key={i} opacity={opacity}>
              <text
                x={width / 2 - 600}
                y={rowY - 24}
                fontFamily={FONTS.mono}
                fontSize={28}
                fill={s.reinforced ? COLORS.amberSoft : COLORS.inkMuted}
              >
                {s.label}
              </text>
              <text
                x={width / 2 + 480}
                y={rowY - 24}
                fontFamily={FONTS.mono}
                fontSize={28}
                fill={s.reinforced ? COLORS.amberSoft : COLORS.inkMuted}
                textAnchor="end"
              >
                str={strength.toFixed(2)}
              </text>
              <rect
                x={width / 2 - 600}
                y={rowY - 8}
                width={1100}
                height={28}
                rx={6}
                fill="rgba(245,241,234,0.05)"
              />
              <rect
                x={width / 2 - 600}
                y={rowY - 8}
                width={barW}
                height={28}
                rx={6}
                fill={s.reinforced ? COLORS.amber : COLORS.inkMuted}
              />
              {s.reinforced && (
                <text
                  x={width / 2 + 540}
                  y={rowY + 14}
                  fontSize={28}
                  fill={COLORS.green}
                  fontFamily={FONTS.mono}
                >
                  ✓ reinforced
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
