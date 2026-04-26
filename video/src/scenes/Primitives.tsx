import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONTS } from "../theme";

const ITEMS = [
  { n: "1", title: "Medium", sub: "one place to read & write" },
  { n: "2", title: "Decay", sub: "every signal evaporates" },
  { n: "3", title: "Roles", sub: "what kind of work" },
  { n: "4", title: "Agents", sub: "stable identity, shifting function" },
  { n: "5", title: "Locality", sub: "see only what's near" },
  { n: "6", title: "Validated reinforcement", sub: "quality beats speed" },
];

// Six cards reveal in sequence. Bottom payoff line is the through-thesis.
export const Primitives: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headlineIn = interpolate(frame, [0, fps * 0.7], [0, 1], {
    extrapolateRight: "clamp",
  });
  const finalIn = interpolate(frame, [fps * 7, fps * 8], [0, 1], {
    extrapolateRight: "clamp",
  });

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
          top: 90,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 84,
          fontWeight: 700,
          letterSpacing: -2,
          opacity: headlineIn,
        }}
      >
        Six primitives.
      </div>

      <div
        style={{
          position: "absolute",
          top: 260,
          left: 160,
          right: 160,
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gridTemplateRows: "1fr 1fr",
          gap: 32,
        }}
      >
        {ITEMS.map((item, i) => {
          const start = fps * (1 + i * 0.5);
          const opacity = interpolate(frame, [start, start + fps * 0.5], [0, 1], {
            extrapolateRight: "clamp",
          });
          const lift = interpolate(frame, [start, start + fps * 0.5], [20, 0], {
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={i}
              style={{
                padding: 36,
                borderRadius: 18,
                backgroundColor: COLORS.bgSoft,
                border: `2px solid ${COLORS.amberFaint}`,
                opacity,
                transform: `translateY(${lift}px)`,
              }}
            >
              <div
                style={{
                  fontFamily: FONTS.mono,
                  fontSize: 26,
                  color: COLORS.amber,
                  letterSpacing: 4,
                  marginBottom: 12,
                }}
              >
                0{item.n}
              </div>
              <div
                style={{
                  fontSize: 52,
                  fontWeight: 700,
                  letterSpacing: -1,
                  marginBottom: 12,
                }}
              >
                {item.title}
              </div>
              <div
                style={{
                  fontSize: 26,
                  color: COLORS.inkMuted,
                  fontFamily: FONTS.mono,
                }}
              >
                {item.sub}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 80,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 36,
          color: COLORS.amberSoft,
          opacity: finalIn,
          letterSpacing: 1,
        }}
      >
        no manager · no orchestrator · the medium <span style={{ color: COLORS.amber }}>is</span> the plan
      </div>
    </AbsoluteFill>
  );
};
