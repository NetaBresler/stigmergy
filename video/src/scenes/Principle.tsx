import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONTS } from "../theme";

// Big-type definition: stigma + ergon. The etymology is the visual.
export const Principle: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const stigmaIn = interpolate(frame, [0, fps * 0.7], [0, 1], {
    extrapolateRight: "clamp",
  });
  const ergonIn = interpolate(frame, [fps * 1.2, fps * 1.9], [0, 1], {
    extrapolateRight: "clamp",
  });
  const equalsIn = interpolate(frame, [fps * 2.4, fps * 3.1], [0, 1], {
    extrapolateRight: "clamp",
  });
  const tagIn = interpolate(frame, [fps * 4, fps * 4.8], [0, 1], {
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
        padding: 100,
      }}
    >
      <div style={{ display: "flex", gap: 64, alignItems: "baseline" }}>
        <Word
          opacity={stigmaIn}
          translate={(1 - stigmaIn) * 30}
          word="stigma"
          gloss="mark, sign"
        />
        <Plus opacity={Math.min(stigmaIn, ergonIn)} />
        <Word
          opacity={ergonIn}
          translate={(1 - ergonIn) * 30}
          word="ergon"
          gloss="work"
        />
      </div>

      <div
        style={{
          marginTop: 80,
          fontSize: 58,
          fontWeight: 600,
          color: COLORS.inkMuted,
          opacity: equalsIn,
        }}
      >
        =
      </div>

      <div
        style={{
          marginTop: 40,
          fontSize: 110,
          fontWeight: 800,
          letterSpacing: -3,
          color: COLORS.amber,
          opacity: equalsIn,
        }}
      >
        work that guides work
      </div>

      <div
        style={{
          marginTop: 80,
          fontSize: 34,
          color: COLORS.ink,
          maxWidth: 1200,
          textAlign: "center",
          lineHeight: 1.4,
          opacity: tagIn,
        }}
      >
        The shape of what already exists tells the next agent what belongs next.
      </div>
    </AbsoluteFill>
  );
};

const Word: React.FC<{
  word: string;
  gloss: string;
  opacity: number;
  translate: number;
}> = ({ word, gloss, opacity, translate }) => (
  <div
    style={{
      opacity,
      transform: `translateY(${translate}px)`,
      textAlign: "center",
    }}
  >
    <div
      style={{
        fontSize: 140,
        fontWeight: 700,
        letterSpacing: -4,
        fontStyle: "italic",
      }}
    >
      {word}
    </div>
    <div
      style={{
        fontSize: 30,
        fontFamily: FONTS.mono,
        color: COLORS.inkMuted,
        marginTop: 6,
        letterSpacing: 2,
      }}
    >
      {gloss}
    </div>
  </div>
);

const Plus: React.FC<{ opacity: number }> = ({ opacity }) => (
  <div
    style={{
      fontSize: 100,
      fontWeight: 300,
      color: COLORS.amber,
      opacity,
      paddingBottom: 30,
    }}
  >
    +
  </div>
);
