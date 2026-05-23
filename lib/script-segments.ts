/**
 * Script Segmentation — automatic split by word count (~150 words per segment)
 * No AI, no hallucination — pure algorithmic split.
 */

export interface ScriptSegment {
  index: number;
  original: string;
  modified: string | null; // null = not yet paraphrased
  wordCount: number;
  wordsChanged: number;
}

const TARGET_WORDS_PER_SEGMENT = 150;
const MIN_WORDS_PER_SEGMENT = 80;
const MAX_WORDS_PER_SEGMENT = 220;

/**
 * Automatically split a script into segments of ~150 words.
 * Splits on sentence boundaries to keep text natural.
 * Pure algorithm — zero AI involved.
 */
export function splitIntoSegments(raw: string): ScriptSegment[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Split into sentences (keeping the delimiter)
  const sentences = trimmed
    .split(/(?<=[.!?…])\s+/)
    .filter((s) => s.trim().length > 0);

  if (sentences.length === 0) return [];

  const segments: ScriptSegment[] = [];
  let currentChunk: string[] = [];
  let currentWordCount = 0;

  for (const sentence of sentences) {
    const sentenceWords = sentence.split(/\s+/).filter(Boolean).length;

    // If adding this sentence would exceed max, flush current chunk
    if (currentWordCount + sentenceWords > MAX_WORDS_PER_SEGMENT && currentWordCount >= MIN_WORDS_PER_SEGMENT) {
      const text = currentChunk.join(" ");
      segments.push({
        index: segments.length,
        original: text,
        modified: null,
        wordCount: currentWordCount,
        wordsChanged: 0,
      });
      currentChunk = [];
      currentWordCount = 0;
    }

    currentChunk.push(sentence);
    currentWordCount += sentenceWords;

    // If we've hit the target, flush
    if (currentWordCount >= TARGET_WORDS_PER_SEGMENT) {
      const text = currentChunk.join(" ");
      segments.push({
        index: segments.length,
        original: text,
        modified: null,
        wordCount: currentWordCount,
        wordsChanged: 0,
      });
      currentChunk = [];
      currentWordCount = 0;
    }
  }

  // Flush remaining
  if (currentChunk.length > 0) {
    const text = currentChunk.join(" ");
    const wc = text.split(/\s+/).filter(Boolean).length;
    // If too short, merge with last segment
    if (segments.length > 0 && wc < MIN_WORDS_PER_SEGMENT) {
      const last = segments[segments.length - 1];
      last.original = last.original + " " + text;
      last.wordCount += wc;
    } else {
      segments.push({
        index: segments.length,
        original: text,
        modified: null,
        wordCount: wc,
        wordsChanged: 0,
      });
    }
  }

  return segments;
}

/**
 * Reassemble segments into a single script string.
 * Uses modified text if available, otherwise original.
 */
export function reassembleScript(segments: ScriptSegment[]): string {
  return segments
    .map((s) => s.modified ?? s.original)
    .join("\n\n");
}
