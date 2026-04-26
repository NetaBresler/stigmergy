import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONTS } from "../theme";

// Grassé, 1959. We draw a column of "deposits" rising over time — no
// communication between agents, but structure emerges.
export const Termites: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const headlineIn = interpolate(frame, [0, fps * 0.7], [0, 1], {
    extrapolateRight: "clamp",
  });

  const layers = 32;
  const groundY = height - 220;
  const layerHeight = 18;

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 50% 100%, #2a1d10 0%, ${COLORS.bg} 70%)`,
        fontFamily: FONTS.display,
        color: COLORS.ink,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 100,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 64,
          fontWeight: 700,
          letterSpacing: -1,
          opacity: headlineIn,
        }}
      >
        No conversation. No orders.
      </div>
      <div
        style={{
          position: "absolute",
          top: 200,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 40,
          fontWeight: 400,
          letterSpacing: 1,
          color: COLORS.amber,
          opacity: headlineIn,
        }}
      >
        Each one works as if alone.
      </div>

      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {/* Ground */}
        <line
          x1={0}
          x2={width}
          y1={groundY}
          y2={groundY}
          stroke={COLORS.rule}
          strokeWidth={2}
        />

        {/* Mound built up over time, layer by layer. */}
        {Array.from({ length: layers }).map((_, i) => {
          const startFrame = fps * 1.2 + i * 5;
          const opacity = interpolate(frame, [startFrame, startFrame + 12], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const widthFactor = 1 - i / layers;
          const w = 600 * Math.pow(widthFactor, 0.7);
          const y = groundY - (i + 1) * layerHeight;
          // Layer color modulates faintly so the mound has texture.
          const tint = i % 2 === 0 ? COLORS.amber : COLORS.amberSoft;
          return (
            <rect
              key={i}
              x={width / 2 - w / 2}
              y={y}
              width={w}
              height={layerHeight - 1}
              rx={3}
              fill={tint}
              opacity={opacity * 0.72}
            />
          );
        })}

        {/* Wandering "termites" — independent random walkers on the mound. */}
        {Array.from({ length: 6 }).map((_, i) => {
          const seed = i * 37 + 13;
          const phase = frame / 12 + i * 1.7;
          const x = width / 2 + Math.sin(phase) * (220 - i * 20);
          const reachedLayers = Math.min(
            layers,
            Math.max(0, Math.floor((frame - fps * 1.2) / 5)),
          );
          const y = groundY - Math.max(8, reachedLayers * layerHeight) + Math.sin(phase * 2) * 6;
          return (
            <circle
              key={i}
              cx={x}
              cy={y - 14}
              r={5}
              fill={COLORS.ink}
              opacity={0.85 - (seed % 5) * 0.05}
            />
          );
        })}
      </svg>

      <div
        style={{
          position: "absolute",
          bottom: 80,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 26,
          color: COLORS.inkMuted,
          fontFamily: FONTS.mono,
          letterSpacing: 4,
        }}
      >
        Grassé · 1959
      </div>
    </AbsoluteFill>
  );
};
