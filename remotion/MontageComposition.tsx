import { AbsoluteFill, Audio, OffthreadVideo, Sequence } from "remotion";
import { effectiveLength, type MontageCompositionProps } from "./types";

// Each clip uses its absolute startFrame on the timeline. Multiple tracks are
// supported by sorting ascending by trackIndex so higher tracks render later
// (and therefore on top) inside React's reconciliation order.
export const MontageComposition: React.FC<MontageCompositionProps> = ({
  clips,
  keepClipAudio,
  voiceoverUrl,
  voiceoverVolume,
  musicUrl,
  musicVolume,
  backgroundColor,
}) => {
  // Defensive: drop clips with non-finite start/trim values that would crash
  // <Sequence from={NaN}/>. Such values can sneak in from a stale localStorage
  // schema or from an unfinished migration.
  const safe = clips.filter((c) =>
    Number.isFinite(c.startFrame) &&
    Number.isFinite(c.durationInFrames) &&
    typeof c.url === "string" && c.url.length > 0,
  );
  const ordered = [...safe].sort((a, b) => {
    if ((a.trackIndex ?? 0) !== (b.trackIndex ?? 0)) return (a.trackIndex ?? 0) - (b.trackIndex ?? 0);
    return a.startFrame - b.startFrame;
  });
  return (
    <AbsoluteFill style={{ backgroundColor }}>
      {ordered.map((clip) => {
        const length = Math.max(1, Math.round(effectiveLength(clip)));
        const muted = !keepClipAudio || clip.muteAudio === true;
        const trimStart = clip.trimStartFrames ?? 0;
        const trimEnd = clip.trimEndFrames ?? clip.durationInFrames;
        return (
          <Sequence
            key={clip.id}
            from={Math.max(0, Math.round(clip.startFrame))}
            durationInFrames={length}
            layout="none"
          >
            <AbsoluteFill>
              <OffthreadVideo
                src={clip.url}
                muted={muted}
                startFrom={trimStart}
                endAt={trimEnd}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {voiceoverUrl && <Audio src={voiceoverUrl} volume={voiceoverVolume} />}
      {musicUrl && <Audio src={musicUrl} volume={musicVolume} />}
    </AbsoluteFill>
  );
};
