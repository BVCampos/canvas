import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Scene } from "./Scene";
import { SCENES, SCENE_FRAMES } from "./captions";

export const Walkthrough: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const progress = interpolate(frame, [0, durationInFrames - 1], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: "#0B0F17" }}>
      {SCENES.map((scene, i) => (
        <Sequence
          key={scene.shot}
          from={i * SCENE_FRAMES}
          durationInFrames={SCENE_FRAMES}
        >
          <Scene scene={scene} index={i} total={SCENES.length} />
        </Sequence>
      ))}

      {/* Top progress bar — always visible */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 4,
          background: "rgba(255,255,255,0.08)",
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: "100%",
            background:
              "linear-gradient(90deg, #6EE7F9 0%, #818CF8 50%, #F472B6 100%)",
            transition: "width 80ms linear",
          }}
        />
      </div>

      {/* Wordmark — bottom right */}
      <div
        style={{
          position: "absolute",
          right: 56,
          bottom: 38,
          fontSize: 18,
          color: "rgba(255,255,255,0.45)",
          fontFamily: "Inter, system-ui, -apple-system, sans-serif",
          fontWeight: 500,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        21x Canvas
      </div>
    </AbsoluteFill>
  );
};
