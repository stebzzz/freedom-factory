import type { ComponentType } from "react";
import { Composition } from "remotion";
import { MontageComposition } from "./MontageComposition";
import { ShowcaseComposition } from "./ShowcaseComposition";
import type { ShowcaseCompositionProps } from "./ShowcaseComposition";
import type { MontageCompositionProps } from "./types";
import { FPS, WIDTH, HEIGHT } from "./types";

// Sane defaults so the Root can mount without input — actual props are
// passed by the Player (defaultProps + inputProps) and by renderMedia.
const DEFAULT_PROPS: MontageCompositionProps = {
  clips: [],
  keepClipAudio: false,
  voiceoverVolume: 1.0,
  musicVolume: 0.15,
  transitionFrames: 0,
  backgroundColor: "#000000",
};

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="Montage"
        component={MontageComposition as unknown as ComponentType<Record<string, unknown>>}
        defaultProps={DEFAULT_PROPS as unknown as Record<string, unknown>}
        // calculateMetadata lets Remotion derive the total duration from the
        // clip list at render time, instead of hard-coding it.
        calculateMetadata={async ({ props }) => {
          const p = props as unknown as MontageCompositionProps;
          const total = p.clips.reduce(
            (sum, c) => sum + c.durationInFrames,
            0,
          );
          return { durationInFrames: Math.max(1, total) };
        }}
        // Placeholder duration when defaultProps.clips is empty.
        durationInFrames={1}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Composition
        id="NeverKissShowcase"
        component={ShowcaseComposition as unknown as ComponentType<Record<string, unknown>>}
        defaultProps={{ scenes: [], framesDir: "", audioUrl: "", fps: 30 } as unknown as Record<string, unknown>}
        calculateMetadata={async ({ props }) => {
          const p = props as unknown as ShowcaseCompositionProps;
          const last = p.scenes[p.scenes.length - 1];
          const total = last ? Math.round(last.sceneEnd * p.fps) : 1;
          return { durationInFrames: Math.max(1, total) };
        }}
        durationInFrames={1}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
