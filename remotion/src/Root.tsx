import { Composition } from "remotion";
import { Walkthrough } from "./Walkthrough";
import { FPS, HEIGHT, TOTAL_FRAMES, WIDTH } from "./captions";

export const Root: React.FC = () => {
  return (
    <Composition
      id="Walkthrough"
      component={Walkthrough}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
};
