import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";

const YT_DLP_BIN = process.env.YT_DLP_PATH || "yt-dlp";

// YouTube's anti-bot heuristics on datacenter IPs (Hostinger VPS) reject every
// public extractor unless we present BOTH a Proof-of-Token (PoT) and a valid
// session cookie. We expose two helpers below that auto-discover the local
// bgutil-pot service and a cookies.txt sitting in the config volume.
//
// Optional env vars (Dokploy → Environment):
//   YT_DLP_BGUTIL_BASEURL    — default http://172.17.0.1:4416 (Docker gateway)
//   YT_DLP_COOKIES_PATH      — default <cwd>/config/youtube-cookies.txt
//   YT_DLP_EXTRA_EXTRACTOR_ARGS — appended verbatim (advanced)
function autoDiscoverCookies(explicit?: string): string | undefined {
  if (explicit && existsSync(explicit)) return explicit;
  const env = process.env.YOUTUBE_COOKIES || process.env.YT_DLP_COOKIES_PATH;
  if (env && existsSync(env)) return env;
  const local = path.join(process.cwd(), "config", "youtube-cookies.txt");
  if (existsSync(local)) return local;
  return undefined;
}
const BGUTIL_BASEURL = process.env.YT_DLP_BGUTIL_BASEURL || "http://172.17.0.1:4416";
const BGUTIL_EXTRACTOR_ARG = `youtubepot-bgutilhttp:base_url=${BGUTIL_BASEURL}`;

/**
 * Extract the 11-char YouTube video ID from any of the usual URL shapes:
 *   - https://www.youtube.com/watch?v=ID
 *   - https://youtu.be/ID
 *   - https://www.youtube.com/shorts/ID
 *   - https://youtube.com/embed/ID
 *   - bare ID
 */
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    const v = u.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const segs = u.pathname.split("/").filter(Boolean);
    for (const s of segs) {
      if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

interface CaptionEvent {
  text?: string;
  segs?: Array<{ utf8?: string }>;
}

function vttToText(vtt: string): string {
  // WEBVTT cue blocks: skip header, skip timing lines (containing -->),
  // dedupe overlapping fragments. yt-dlp auto-captions repeat sliding windows.
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  let prev = "";
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith("WEBVTT")) continue;
    if (line.includes("-->")) continue;
    if (/^\d+$/.test(line)) continue;
    // Strip inline tags <c>…</c> and <00:00:01.000>
    line = line.replace(/<[^>]+>/g, "").trim();
    if (!line || line === prev) continue;
    out.push(line);
    prev = line;
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function json3ToText(raw: string): string {
  try {
    const data = JSON.parse(raw) as { events?: CaptionEvent[] };
    if (!Array.isArray(data.events)) return "";
    const out: string[] = [];
    for (const ev of data.events) {
      if (typeof ev.text === "string") {
        out.push(ev.text);
        continue;
      }
      if (Array.isArray(ev.segs)) {
        for (const seg of ev.segs) {
          if (typeof seg.utf8 === "string") out.push(seg.utf8);
        }
      }
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

interface FetchOpts {
  language?: string; // ISO code preference (e.g. "en", "fr")
  cookiesFile?: string;
  cookiesFromBrowser?: string; // e.g. "safari", "chrome"
}

/** Fetch the transcript of a YouTube video via yt-dlp. Returns the plain spoken text. */
export async function fetchTranscript(url: string, opts: FetchOpts = {}): Promise<string> {
  const id = extractVideoId(url);
  if (!id) throw new Error(`URL YouTube non reconnue: ${url.slice(0, 80)}`);

  const lang = opts.language || process.env.YOUTUBE_TRANSCRIPT_LANG || "en";
  const cookiesFile = autoDiscoverCookies(opts.cookiesFile);
  const cookiesFromBrowser = opts.cookiesFromBrowser || process.env.YT_DLP_COOKIES_FROM_BROWSER;

  const workDir = path.join(os.tmpdir(), `yt-${id}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  const args = [
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    `${lang}.*,${lang},en.*,en`,
    "--sub-format",
    "json3/vtt/best",
    "--skip-download",
    "--no-warnings",
    "--extractor-args", BGUTIL_EXTRACTOR_ARG,
    "-o",
    path.join(workDir, "%(id)s.%(ext)s"),
  ];
  if (cookiesFile) args.push("--cookies", cookiesFile);
  else if (cookiesFromBrowser) args.push("--cookies-from-browser", cookiesFromBrowser);
  args.push(`https://www.youtube.com/watch?v=${id}`);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(YT_DLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c.toString()));
      child.on("error", (err) => reject(new Error(`yt-dlp spawn: ${err.message}`)));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-400)}`));
      });
    });

    const files = await readdir(workDir);
    // Prefer json3 (cleaner), fall back to vtt. Prefer the requested language.
    const candidates = files
      .filter((f) => /\.(json3|vtt)$/i.test(f))
      .sort((a, b) => {
        const aLang = a.includes(`.${lang}.`) || a.includes(`.${lang}-`) ? 0 : 1;
        const bLang = b.includes(`.${lang}.`) || b.includes(`.${lang}-`) ? 0 : 1;
        if (aLang !== bLang) return aLang - bLang;
        const aJson = a.endsWith(".json3") ? 0 : 1;
        const bJson = b.endsWith(".json3") ? 0 : 1;
        return aJson - bJson;
      });

    if (candidates.length === 0) {
      throw new Error(
        "Aucune sous-titre trouvé. Cette vidéo n'a peut-être pas de captions, ou YouTube te bloque (configure YT_DLP_COOKIES_FROM_BROWSER=safari)."
      );
    }

    const filePath = path.join(workDir, candidates[0]);
    const raw = await readFile(filePath, "utf-8");
    const text = candidates[0].endsWith(".json3") ? json3ToText(raw) : vttToText(raw);
    if (!text || text.length < 80) {
      throw new Error(`Transcript trop court (${text.length} chars) — captions probablement vides.`);
    }
    return text;
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* cleanup best-effort */
    }
  }
}

/**
 * Coarse language detector based on stop-word frequency. Good enough for "en vs fr"
 * on YouTube transcripts (which are typically 1k+ chars). Returns undefined if the
 * sample is too short or the signal is ambiguous.
 */
export function detectLanguageFromText(text: string): "en" | "fr" | undefined {
  if (!text || text.length < 60) return undefined;
  const lower = " " + text.toLowerCase().replace(/[^a-zàâäéèêëîïôöùûüç' ]/g, " ").replace(/\s+/g, " ") + " ";
  const en = ["the", "and", "you", "that", "this", "with", "have", "they", "what", "are", "was", "for", "but", "not", "out", "all", "would", "your", "their", "there"];
  const fr = ["le", "la", "les", "des", "une", "qui", "que", "pas", "est", "dans", "pour", "avec", "mais", "vous", "nous", "ils", "elle", "très", "comme", "plus", "leur", "sans"];
  let enHits = 0;
  let frHits = 0;
  for (const w of en) enHits += (lower.match(new RegExp(` ${w} `, "g")) ?? []).length;
  for (const w of fr) frHits += (lower.match(new RegExp(` ${w} `, "g")) ?? []).length;
  if (enHits < 5 && frHits < 5) return undefined;
  if (enHits >= frHits * 1.3) return "en";
  if (frHits >= enHits * 1.3) return "fr";
  return undefined;
}

/**
 * Hard safety cap. A 2-hour video at cadenceSeconds=1 would emit 7200 frames and
 * cost ~$15 in Claude Vision calls. We clamp here and surface the truncation in
 * the return value's `truncated` flag so the caller can warn the user.
 */
const FRAMES_HARD_MAX = 300;

export interface FrameExtractionResult {
  framePaths: string[];
  /** Total frames the cadence would have produced before the safety cap kicked in. */
  expectedCount: number;
  /** True when the safety cap reduced the count below expectedCount. */
  truncated: boolean;
  /** Source video duration in seconds (from ffprobe). */
  durationSec: number;
}

/**
 * Download a low-bitrate copy of a YouTube video via yt-dlp, then extract frames
 * at a fixed cadence (one frame every `cadenceSeconds` seconds) via ffmpeg `fps=1/N`.
 *
 * Skips the first/last 5% of the video to avoid intro/outro pollution. Hard-clamped
 * at FRAMES_HARD_MAX (300) frames; callers should check `truncated` to warn the user.
 *
 * Designed for style-kit ingestion — 360p MP4 is plenty for Claude Vision.
 */
export async function fetchVideoKeyframes(
  url: string,
  cadenceSeconds: number,
  outDir: string,
  opts: FetchOpts = {},
): Promise<FrameExtractionResult> {
  const id = extractVideoId(url);
  if (!id) throw new Error(`URL YouTube non reconnue: ${url.slice(0, 80)}`);
  if (!Number.isFinite(cadenceSeconds) || cadenceSeconds < 0.5 || cadenceSeconds > 60) {
    throw new Error(`fetchVideoKeyframes: cadenceSeconds out of range (${cadenceSeconds}, expected 0.5..60)`);
  }

  const cookiesFile = autoDiscoverCookies(opts.cookiesFile);
  const cookiesFromBrowser = opts.cookiesFromBrowser || process.env.YT_DLP_COOKIES_FROM_BROWSER;

  const workDir = path.join(os.tmpdir(), `yt-frames-${id}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  const videoTemplate = path.join(workDir, "%(id)s.%(ext)s");

  const ytArgs = [
    // Cap quality at 360p for speed/size — Claude Vision doesn't need 4K to read style.
    "-f",
    "bestvideo[height<=360][ext=mp4]/bestvideo[height<=360]/best[height<=360]",
    "--no-playlist",
    "--no-warnings",
    "--extractor-args", BGUTIL_EXTRACTOR_ARG,
    "-o",
    videoTemplate,
  ];
  if (cookiesFile) ytArgs.push("--cookies", cookiesFile);
  else if (cookiesFromBrowser) ytArgs.push("--cookies-from-browser", cookiesFromBrowser);
  ytArgs.push(`https://www.youtube.com/watch?v=${id}`);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(YT_DLP_BIN, ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c.toString()));
      child.on("error", (err) => reject(new Error(`yt-dlp spawn: ${err.message}`)));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-400)}`));
      });
    });

    const files = await readdir(workDir);
    const videoFile = files.find((f) => /\.(mp4|mkv|webm|m4v)$/i.test(f));
    if (!videoFile) throw new Error("yt-dlp n'a téléchargé aucun fichier vidéo lisible");
    const videoPath = path.join(workDir, videoFile);

    // Probe duration via ffprobe.
    const duration = await new Promise<number>((resolve, reject) => {
      const child = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c.toString()));
      child.stderr.on("data", (c) => (stderr += c.toString()));
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${stderr}`));
        const d = parseFloat(stdout.trim());
        if (!Number.isFinite(d) || d <= 0) return reject(new Error(`ffprobe duration invalide: ${stdout}`));
        resolve(d);
      });
    });

    // Skip first/last 5% (intros/outros) — middle 90% only.
    const margin = duration * 0.05;
    const usable = Math.max(1, duration - margin * 2);
    const expectedCount = Math.max(1, Math.floor(usable / cadenceSeconds));
    const truncated = expectedCount > FRAMES_HARD_MAX;
    const targetCount = Math.min(expectedCount, FRAMES_HARD_MAX);

    if (truncated) {
      console.warn(
        `[yt-frames] cadence=${cadenceSeconds}s × ${usable.toFixed(0)}s usable = ${expectedCount} frames > cap ${FRAMES_HARD_MAX} — clamping`,
      );
    }

    await mkdir(outDir, { recursive: true });

    // Use ffmpeg's fps filter (1 frame every cadenceSeconds). Combined with -ss to skip
    // the intro and -t to skip the outro, ffmpeg emits exactly the frames we want in a
    // single pass — much faster than seeking once per timestamp.
    // Effective cadence may be slightly adjusted to land exactly targetCount frames.
    const effectiveCadence = truncated ? usable / targetCount : cadenceSeconds;

    await new Promise<void>((resolve, reject) => {
      const args = [
        "-y",
        "-ss", margin.toFixed(2),
        "-i", videoPath,
        "-t", usable.toFixed(2),
        "-vf", `fps=1/${effectiveCadence.toFixed(4)},scale='min(1280,iw)':-2`,
        "-frames:v", String(targetCount),
        path.join(outDir, "frame-%03d.png"),
      ];
      const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c.toString()));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg fps exit ${code}: ${stderr.slice(-300)}`));
      });
    });

    const written = (await readdir(outDir))
      .filter((f) => /^frame-\d+\.png$/.test(f))
      .sort()
      .map((f) => path.join(outDir, f));

    if (written.length === 0) {
      throw new Error("ffmpeg n'a émis aucune frame — vidéo trop courte ou cadence > durée ?");
    }

    console.log(`[yt-frames] ${written.length} frames extracted (cadence=${effectiveCadence.toFixed(2)}s, duration=${duration.toFixed(0)}s${truncated ? ", capped" : ""})`);

    return { framePaths: written, expectedCount, truncated, durationSec: duration };
  } finally {
    // Wipe the yt-dlp source video; keep the frame outputs in outDir which is the caller's.
    try {
      const files = await readdir(workDir);
      for (const f of files) {
        await rm(path.join(workDir, f), { force: true });
      }
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/** Download the YouTube video thumbnail to a local file. Tries maxres → hq → mq order. */
export async function fetchThumbnail(url: string, outputPath: string): Promise<string> {
  const id = extractVideoId(url);
  if (!id) throw new Error(`URL YouTube non reconnue: ${url.slice(0, 80)}`);

  // YouTube serves these JPGs without auth. maxresdefault may 404 if the channel
  // never uploaded an HD thumbnail, in which case hqdefault is always available.
  const candidates = [
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  ];

  for (const u of candidates) {
    const res = await fetch(u, { redirect: "follow" });
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    // YouTube returns a 120x90 grey placeholder for missing thumbnails — those weigh <2 kB.
    if (buf.length < 2_500) continue;
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, buf);
    return outputPath;
  }
  throw new Error(`Impossible de télécharger la miniature pour ${id}`);
}
