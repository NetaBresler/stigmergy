import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONTS } from "../theme";

// "The bug": the manager-as-bottleneck. We draw a tree and pulse traffic
// through the manager so the bottleneck is felt, not just stated.
export const Hierarchy: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const headlineIn = interpolate(frame, [0, fps * 0.7], [0, 1], {
    extrapolateRight: "clamp",
  });
  const diagramIn = interpolate(frame, [fps * 0.4, fps * 1.2], [0, 1], {
    extrapolateRight: "clamp",
  });
  const overlayIn = interpolate(frame, [fps * 9, fps * 10], [0, 1], {
    extrapolateRight: "clamp",
  });

  const cx = width / 2;
  const managerY = 360;
  const workerY = 760;
  const workerXs = [cx - 540, cx - 180, cx + 180, cx + 540];

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg,
        fontFamily: FONTS.display,
        color: COLORS.ink,
      }}
    >
      <Headline opacity={headlineIn}>The manager is the bottleneck.</Headline>

      <svg
        width={width}
        height={height}
        style={{ position: "absolute", inset: 0, opacity: diagramIn }}
      >
        {workerXs.map((wx, i) => {
          const t = ((frame + i * 18) % 90) / 90;
          // Pulse goes worker -> manager -> worker (round trip).
          const px =
            t < 0.5 ? wx + (cx - wx) * (t * 2) : cx + (wx - cx) * ((t - 0.5) * 2);
          const py =
            t < 0.5
              ? workerY + (managerY - workerY) * (t * 2)
              : managerY + (workerY - managerY) * ((t - 0.5) * 2);
          return (
            <g key={i}>
              <line
                x1={cx}
                y1={managerY + 60}
                x2={wx}
                y2={workerY - 60}
                stroke={COLORS.rule}
                strokeWidth={2}
              />
              <circle cx={px} cy={py} r={8} fill={COLORS.amber} opacity={0.85} />
            </g>
          );
        })}

        <Node x={cx} y={managerY} label="MANAGER" muted={false} accent />
        {workerXs.map((wx, i) => (
          <Node key={i} x={wx} y={workerY} label={`AGENT ${i + 1}`} muted />
        ))}
      </svg>

      {/* Late overlay reinforcing the "context-window-shaped" line. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 80,
          textAlign: "center",
          fontFamily: FONTS.mono,
          fontSize: 30,
          color: COLORS.amberSoft,
          letterSpacing: 2,
          opacity: overlayIn,
        }}
      >
        every decision · one context window · single point of failure
      </div>
    </AbsoluteFill>
  );
};

const Headline: React.FC<{ opacity: number; children: React.ReactNode }> = ({
  opacity,
  children,
}) => (
  <div
    style={{
      position: "absolute",
      top: 120,
      left: 0,
      right: 0,
      textAlign: "center",
      fontSize: 84,
      fontWeight: 700,
      letterSpacing: -2,
      opacity,
    }}
  >
    {children}
  </div>
);

const Node: React.FC<{
  x: number;
  y: number;
  label: string;
  muted?: boolean;
  accent?: boolean;
}> = ({ x, y, label, muted, accent }) => {
  const w = 260;
  const h = 110;
  return (
    <g>
      <rect
        x={x - w / 2}
        y={y - h / 2}
        width={w}
        height={h}
        rx={14}
        fill={accent ? COLORS.amberFaint : COLORS.bgSoft}
        stroke={accent ? COLORS.amber : COLORS.rule}
        strokeWidth={accent ? 3 : 1.5}
      />
      <text
        x={x}
        y={y + 10}
        textAnchor="middle"
        fontSize={32}
        fontFamily={FONTS.mono}
        fontWeight={600}
        fill={muted ? COLORS.inkMuted : COLORS.ink}
        letterSpacing={2}
      >
        {label}
      </text>
    </g>
  );
};
