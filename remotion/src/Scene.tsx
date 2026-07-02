import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Scene as SceneType } from "./captions";

type Props = {
  scene: SceneType;
  index: number;
  total: number;
};

export const Scene: React.FC<Props> = ({ scene, index, total }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Ken Burns: slow zoom from 1.00 → 1.04 over the scene
  const zoom = interpolate(frame, [0, durationInFrames], [1.0, 1.04], {
    extrapolateRight: "clamp",
  });

  // Caption rises + fades in over the first ~14 frames
  const captionSpring = spring({
    frame,
    fps,
    config: { damping: 20, mass: 0.6 },
    durationInFrames: 18,
  });
  const captionTranslate = interpolate(captionSpring, [0, 1], [40, 0]);

  // Whole scene fades in over 6 frames and out over the last 6
  const sceneOpacity = interpolate(
    frame,
    [0, 6, durationInFrames - 6, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateRight: "clamp" },
  );

  // Step badge pop-in
  const badgeScale = spring({
    frame,
    fps,
    config: { damping: 12, mass: 0.5 },
    durationInFrames: 14,
  });

  return (
    <AbsoluteFill
      style={{
        background: "#0B0F17",
        opacity: sceneOpacity,
      }}
    >
      {/* Screenshot, with subtle Ken Burns and a soft shadow */}
      <AbsoluteFill
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 80,
        }}
      >
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            transform: `scale(${zoom})`,
            transformOrigin: "center center",
            borderRadius: 14,
            overflow: "hidden",
            boxShadow:
              "0 30px 80px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)",
          }}
        >
          <Img
            src={staticFile(`shots/${scene.shot}`)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              objectPosition: "center",
              display: "block",
              background: "white",
            }}
          />
        </div>
      </AbsoluteFill>

      {/* Dark gradient at the bottom so the caption is always readable */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(11,15,23,0) 55%, rgba(11,15,23,0.85) 90%, rgba(11,15,23,0.95) 100%)",
          pointerEvents: "none",
        }}
      />

      {/* Step badge — top left */}
      <div
        style={{
          position: "absolute",
          top: 48,
          left: 64,
          display: "flex",
          alignItems: "center",
          gap: 14,
          transform: `scale(${badgeScale})`,
          transformOrigin: "left center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 38,
            height: 38,
            borderRadius: 10,
            background: "rgba(255,255,255,0.10)",
            color: "white",
            fontWeight: 600,
            fontSize: 18,
            backdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          {index + 1}
        </div>
        <div
          style={{
            color: "rgba(255,255,255,0.65)",
            fontSize: 16,
            fontWeight: 500,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontFamily: "Inter, system-ui, -apple-system, sans-serif",
          }}
        >
          {scene.step} · {index + 1} / {total}
        </div>
      </div>

      {/* Caption block — bottom left */}
      <div
        style={{
          position: "absolute",
          left: 80,
          right: 80,
          bottom: 80,
          transform: `translateY(${captionTranslate}px)`,
          opacity: captionSpring,
          color: "white",
          fontFamily: "Inter, system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 64,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            lineHeight: 1.08,
            color: "white",
            marginBottom: 14,
            textShadow: "0 2px 30px rgba(0,0,0,0.45)",
          }}
        >
          {scene.caption}
        </div>
        <div
          style={{
            fontSize: 28,
            fontWeight: 400,
            lineHeight: 1.35,
            color: "rgba(255,255,255,0.78)",
            maxWidth: 1200,
          }}
        >
          {scene.detail}
        </div>
      </div>
    </AbsoluteFill>
  );
};
