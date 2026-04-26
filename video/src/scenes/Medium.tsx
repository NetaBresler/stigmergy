import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONTS } from "../theme";

// "Stigmergy replaces the manager with a shared medium."
// Diagram: agents around a central rectangle (the medium). Signals flow
// in from agents, then get re-read by other agents.
export const Medium: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const headlineIn = interpolate(frame, [0, fps * 0.7], [0, 1], {
    extrapolateRight: "clamp",
  });

  const cx = width / 2;
  const cy = height / 2 + 80;
  const mediumW = 900;
  const mediumH = 360;

  const agents = [
    { x: cx - 720, y: cy - 60, label: "EXPLORER" },
    { x: cx - 720, y: cy + 220, label: "WORKER" },
    { x: cx + 720, y: cy - 60, label: "VALIDATOR" },
    { x: cx + 720, y: cy + 220, label: "WORKER" },
  ];

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
          fontSize: 76,
          fontWeight: 700,
          letterSpacing: -2,
          opacity: headlineIn,
        }}
      >
        The medium <span style={{ color: COLORS.amber }}>is</span> the coordination.
      </div>

      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {/* Medium rectangle with rows of "signals" */}
        <rect
          x={cx - mediumW / 2}
          y={cy - mediumH / 2}
          width={mediumW}
          height={mediumH}
          rx={20}
          fill={COLORS.bgSoft}
          stroke={COLORS.amber}
          strokeWidth={3}
        />
        <text
          x={cx}
          y={cy - mediumH / 2 + 50}
          textAnchor="middle"
          fontFamily={FONTS.mono}
          fontSize={26}
          fill={COLORS.amber}
          letterSpacing={4}
        >
          MEDIUM · postgres
        </text>
        {/* Signal rows */}
        {Array.from({ length: 5 }).map((_, i) => {
          const rowY = cy - mediumH / 2 + 100 + i * 44;
          const visible = interpolate(
            frame,
            [fps * (0.8 + i * 0.18), fps * (1.4 + i * 0.18)],
            [0, 1],
            { extrapolateRight: "clamp" },
          );
          // Strength bar that decays slowly over the scene
          const decayStart = fps * (3 + i * 0.3);
          const strength = interpolate(frame, [decayStart, decayStart + fps * 6], [1, 0.35], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <g key={i} opacity={visible}>
              <rect
                x={cx - mediumW / 2 + 30}
                y={rowY - 18}
                width={mediumW - 60}
                height={36}
                rx={6}
                fill="rgba(245,241,234,0.04)"
              />
              <text
                x={cx - mediumW / 2 + 50}
                y={rowY + 8}
                fontFamily={FONTS.mono}
                fontSize={22}
                fill={COLORS.inkMuted}
              >
                {SIGNAL_LABELS[i]}
              </text>
              <rect
                x={cx + mediumW / 2 - 230}
                y={rowY - 8}
                width={180}
                height={16}
                rx={4}
                fill="rgba(245,241,234,0.08)"
              />
              <rect
                x={cx + mediumW / 2 - 230}
                y={rowY - 8}
                width={180 * strength}
                height={16}
                rx={4}
                fill={COLORS.amber}
                opacity={0.85}
              />
            </g>
          );
        })}

        {/* Agents */}
        {agents.map((a, i) => (
          <g key={i}>
            <rect
              x={a.x - 110}
              y={a.y - 40}
              width={220}
              height={80}
              rx={10}
              fill={COLORS.bgSoft}
              stroke={COLORS.rule}
              strokeWidth={1.5}
            />
            <text
              x={a.x}
              y={a.y + 8}
              textAnchor="middle"
              fontFamily={FONTS.mono}
              fontSize={22}
              fill={COLORS.ink}
              letterSpacing={2}
            >
              {a.label}
            </text>
            <FlowDot
              from={{ x: a.x + (a.x < cx ? 110 : -110), y: a.y }}
              to={{ x: a.x < cx ? cx - mediumW / 2 : cx + mediumW / 2, y: cy }}
              frame={frame}
              phase={i * 17}
              fps={fps}
            />
          </g>
        ))}
      </svg>
    </AbsoluteFill>
  );
};

const SIGNAL_LABELS = [
  "candidate · auth_bug · str=0.82",
  "claim    · agent_4   · str=0.70",
  "result   · backend   · str=0.91",
  "boost    · validator · str=0.55",
  "candidate · perf_drop · str=0.40",
];

const FlowDot: React.FC<{
  from: { x: number; y: number };
  to: { x: number; y: number };
  frame: number;
  phase: number;
  fps: number;
}> = ({ from, to, frame, phase, fps }) => {
  const period = fps * 2;
  const t = ((frame + phase) % period) / period;
  const x = from.x + (to.x - from.x) * t;
  const y = from.y + (to.y - from.y) * t;
  return <circle cx={x} cy={y} r={6} fill={COLORS.amber} opacity={0.9} />;
};
