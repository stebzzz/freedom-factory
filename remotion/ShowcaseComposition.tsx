import { AbsoluteFill, Audio, Img, Sequence, useCurrentFrame, interpolate } from "remotion";

export interface ShowcaseScene {
  index: number;
  imageTime: number;
  voStart: number;
  voEnd: number;
  sceneEnd: number;
  text: string;
  imageFile: string;
}

export interface ShowcaseCompositionProps {
  scenes: ShowcaseScene[];
  framesDir: string;
  audioUrl: string;
  fps: number;
}

function toFrame(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

const Caption: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" });
  return (
    <div
      style={{
        position: "absolute",
        left: 60,
        right: 60,
        bottom: 64,
        opacity,
        textAlign: "center",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 34,
        fontWeight: 700,
        color: "#fff",
        lineHeight: 1.25,
        textShadow: "0 2px 12px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9)",
      }}
    >
      {text}
    </div>
  );
};

export const ShowcaseComposition: React.FC<ShowcaseCompositionProps> = ({
  scenes,
  framesDir,
  audioUrl,
  fps,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {scenes.map((scene) => {
        const from = toFrame(scene.imageTime, fps);
        const to = toFrame(scene.sceneEnd, fps);
        const duration = Math.max(1, to - from);
        return (
          <Sequence key={scene.index} from={from} durationInFrames={duration} layout="none">
            <AbsoluteFill>
              <Img
                src={`${framesDir}/${scene.imageFile}`}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
              <AbsoluteFill
                style={{
                  background:
                    "linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.15) 35%, rgba(0,0,0,0) 60%)",
                }}
              />
              <Caption text={scene.text} />
            </AbsoluteFill>
          </Sequence>
        );
      })}
      <Audio src={audioUrl} />
    </AbsoluteFill>
  );
};
