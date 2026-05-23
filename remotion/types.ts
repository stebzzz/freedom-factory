// Shared types for the Remotion compositions and the editor UI.

export interface RemotionClip {
  // Stable id for drag-and-drop (must be unique within the composition).
  id: string;
  // The src must be a web-accessible URL (e.g. /generated/pandora_navi/clips/01_xxx.mp4)
  // when used by the Player or by renderMedia with --public-dir set to /public.
  url: string;
  // Full duration of the source video in frames (probed via ffprobe).
  durationInFrames: number;
  // For debugging / labelling in the editor.
  label?: string;
  // Per-clip overrides
  muteAudio?: boolean;
  // In/out trim on the source video. Defaults: 0 .. durationInFrames.
  // The effective on-timeline length is trimEndFrames - trimStartFrames.
  trimStartFrames?: number;
  trimEndFrames?: number;
  // ABSOLUTE position on the timeline (in frames). Allows clips on the same
  // track to be non-contiguous, and clips on different tracks to overlap.
  startFrame: number;
  // 0 = V1 (bottom), 1 = V2 (above), 2 = V3, etc. Higher tracks render on top.
  trackIndex: number;
  // Scene identifier in the project (used by the regenerate endpoint).
  sceneId?: number;
  // The original prompt that produced this clip — shown / edited in the modal.
  prompt?: string;
}

export function effectiveLength(clip: RemotionClip): number {
  const start = clip.trimStartFrames ?? 0;
  const end = clip.trimEndFrames ?? clip.durationInFrames;
  return Math.max(1, end - start);
}

export function clipEndFrame(clip: RemotionClip): number {
  return clip.startFrame + effectiveLength(clip);
}

export function compositionDurationFrames(clips: RemotionClip[]): number {
  if (clips.length === 0) return 1;
  let max = 0;
  for (const c of clips) {
    const end = clipEndFrame(c);
    if (end > max) max = end;
  }
  return Math.max(1, max);
}

export interface MontageCompositionProps {
  clips: RemotionClip[];
  // When true, the audio of each clip is preserved (unless individually muted).
  // When false, all clip audio is dropped (final video relies on voiceover/music).
  keepClipAudio: boolean;
  // Optional voiceover track played over the whole composition.
  voiceoverUrl?: string;
  voiceoverVolume: number; // 0..1
  // Optional background music played over the whole composition.
  musicUrl?: string;
  musicVolume: number; // 0..1
  // Optional fade-to-black transition duration between clips, in frames. 0 = hard cut.
  transitionFrames: number;
  backgroundColor: string;
}

export const FPS = 24;
export const WIDTH = 1280;
export const HEIGHT = 720;
