#!/usr/bin/env node
// build-galveston-montage-plan.mjs
// Aligne chaque scène (champ `vo` dans galveston_1900_veo3_prompts.json)
// au stream de mots horodatés produit par whisper-cli, et écrit un plan
// de montage prêt à être consommé par un ffmpeg builder.

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PROMPTS_PATH = path.join(ROOT, "galveston_1900_veo3_prompts.json");
const MANIFEST_PATH = path.join(ROOT, "public/generated/galveston_1900_veo3/manifest.json");
const WHISPER_PATH = path.join(ROOT, "public/generated/galveston_1900_veo3/voiceover/galveston-doc.json");
const OUT_PATH = path.join(ROOT, "public/generated/galveston_1900_veo3/montage-plan.json");
const CLIP_DUR = 8.0;

const normalize = (s) =>
  s.toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (s) => normalize(s).split(" ").filter(Boolean);

function loadWhisperWords() {
  const j = JSON.parse(readFileSync(WHISPER_PATH, "utf-8"));
  const out = [];
  for (const seg of j.transcription) {
    const text = (seg.text || "").trim();
    if (!text || text.startsWith("[_")) continue;
    const norm = normalize(text);
    if (!norm) continue;
    for (const w of norm.split(" ")) {
      out.push({
        word: w,
        start_ms: seg.offsets.from,
        end_ms: seg.offsets.to,
      });
    }
  }
  return out;
}

// Aligne `voTokens` (array de mots normalisés) au stream de mots whisper
// en partant de `cursor`. Retourne { start_ms, end_ms, next_cursor }.
// Tolère les écarts mineurs (chiffres écrits en lettres, etc.) en avançant
// le curseur whisper jusqu'à matcher le 1er mot vo, puis en consommant
// linéairement avec un slack de quelques positions.
function alignScene(whisperWords, voTokens, cursor) {
  if (voTokens.length === 0) return null;

  // 1) trouve le 1er match du 1er mot vo dans une fenêtre (≤ 80 mots après cursor)
  const searchWindow = 80;
  let startIdx = -1;
  for (let i = cursor; i < Math.min(cursor + searchWindow, whisperWords.length); i++) {
    if (whisperWords[i].word === voTokens[0]) { startIdx = i; break; }
  }
  // fallback: si le 1er mot n'a pas matché (ex: "1900" vs "nineteen hundred"),
  // on essaie le 2e mot
  if (startIdx < 0 && voTokens.length > 1) {
    for (let i = cursor; i < Math.min(cursor + searchWindow, whisperWords.length); i++) {
      if (whisperWords[i].word === voTokens[1]) { startIdx = Math.max(cursor, i - 1); break; }
    }
  }
  if (startIdx < 0) {
    // pas d'ancre trouvée : on prend cursor comme fallback
    startIdx = cursor;
  }

  // 2) avance dans le stream pour consommer la longueur approximative du vo
  // On accepte un slack de ±20% sur le nombre de mots.
  // Pour trouver le mot de fin, on cherche le dernier mot vo dans une fenêtre
  // autour de startIdx + voLen.
  const voLen = voTokens.length;
  const expectedEnd = startIdx + voLen - 1;
  const slack = Math.max(5, Math.ceil(voLen * 0.25));
  const lastVoWord = voTokens[voTokens.length - 1];
  let endIdx = -1;
  for (let i = Math.max(startIdx + voLen - 1 - slack, startIdx); i < Math.min(expectedEnd + slack + 1, whisperWords.length); i++) {
    if (whisperWords[i].word === lastVoWord) {
      endIdx = i;
      // ne break pas — on prend le plus proche de expectedEnd
      if (i >= expectedEnd) break;
    }
  }
  if (endIdx < 0) endIdx = Math.min(expectedEnd, whisperWords.length - 1);

  return {
    start_ms: whisperWords[startIdx].start_ms,
    end_ms: whisperWords[endIdx].end_ms,
    word_count: endIdx - startIdx + 1,
    expected_word_count: voLen,
    next_cursor: endIdx + 1,
    matched_first: whisperWords[startIdx].word,
    matched_last: whisperWords[endIdx].word,
  };
}

function decideAction(voiceDur, clipDur) {
  // si la voix est plus courte que le clip → on trim le clip
  // si la voix est plus longue → on ralentit le clip (setpts)
  // si la voix dépasse 1.4× la durée du clip → flag "extend" (à dupliquer/regen)
  const ratio = voiceDur / clipDur;
  if (ratio < 0.95) return { action: "trim", speed_factor: 1.0 };
  if (ratio <= 1.05) return { action: "keep", speed_factor: 1.0 };
  if (ratio <= 1.4) return { action: "slow", speed_factor: ratio };
  return { action: "extend", speed_factor: ratio };
}

function main() {
  const promptsDoc = JSON.parse(readFileSync(PROMPTS_PATH, "utf-8"));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
  const whisperWords = loadWhisperWords();

  const scenes = [...promptsDoc.scenes].sort((a, b) => a.id - b.id);
  const manifestById = new Map(manifest.entries.map((e) => [e.id, e]));

  console.log(`Scenes: ${scenes.length}, whisper words: ${whisperWords.length}`);

  const totalAudio_s = whisperWords[whisperWords.length - 1].end_ms / 1000;
  console.log(`Total audio: ${totalAudio_s.toFixed(2)} s`);

  // Pass 1 — align each scene's vo to find its "core" timestamps
  const cores = [];
  let cursor = 0;
  for (const sc of scenes) {
    const voTokens = tokenize(sc.vo || "");
    const align = alignScene(whisperWords, voTokens, cursor);
    cores.push({ sc, voTokens, align });
    if (align) cursor = align.next_cursor;
  }

  // Pass 2 — compute "effective" segments that fully cover the audio:
  //   scene i's effective audio = [core_start[i], core_start[i+1])
  //   (first scene starts at 0, last scene ends at totalAudio_s)
  const out = [];
  let missingClips = 0;
  const actionCounts = { trim: 0, keep: 0, slow: 0, extend: 0 };

  for (let i = 0; i < cores.length; i++) {
    const { sc, voTokens, align } = cores[i];
    const m = manifestById.get(sc.id);
    const clipPath = m?.video?.path || null;
    if (!clipPath) missingClips++;

    const core_start = align ? align.start_ms / 1000 : 0;
    const core_end = align ? align.end_ms / 1000 : 0;
    const eff_start = i === 0 ? 0 : (cores[i].align ? core_start : 0);
    const next = cores[i + 1];
    const eff_end = next && next.align ? next.align.start_ms / 1000 : totalAudio_s;
    const voice_dur = Math.max(0.1, eff_end - eff_start);
    const dec = decideAction(voice_dur, CLIP_DUR);
    actionCounts[dec.action]++;

    out.push({
      id: sc.id,
      scene_tag: sc.scene_tag,
      part: sc.part,
      title: sc.title,
      clip_file: clipPath ? path.relative(ROOT, clipPath) : null,
      clip_dur: CLIP_DUR,
      vo: sc.vo,
      vo_word_count: voTokens.length,
      core_start_s: Number(core_start.toFixed(3)),
      core_end_s: Number(core_end.toFixed(3)),
      voice_start_s: Number(eff_start.toFixed(3)),
      voice_end_s: Number(eff_end.toFixed(3)),
      voice_dur: Number(voice_dur.toFixed(3)),
      align_debug: align ? {
        word_count: align.word_count,
        expected_word_count: align.expected_word_count,
        matched_first: align.matched_first,
        matched_last: align.matched_last,
      } : null,
      action: dec.action,
      speed_factor: Number(dec.speed_factor.toFixed(3)),
    });
  }

  // Stats
  const durations = out.map((e) => e.voice_dur);
  durations.sort((a, b) => a - b);
  const totalVoice = durations.reduce((s, d) => s + d, 0);
  console.log(`\nEffective scene durations:`);
  console.log(`  total covered:           ${totalVoice.toFixed(1)} s (audio total ${totalAudio_s.toFixed(1)} s)`);
  console.log(`  min / median / max:      ${durations[0].toFixed(2)}s / ${durations[Math.floor(durations.length / 2)].toFixed(2)}s / ${durations[durations.length - 1].toFixed(2)}s`);
  console.log(`\nAction breakdown vs 8s clip:`);
  for (const [k, v] of Object.entries(actionCounts)) console.log(`  ${k.padEnd(8)} ${v}`);
  if (missingClips) console.log(`\n[!] ${missingClips} scenes without a clip in manifest`);

  const extensions = out.filter((e) => e.action === "extend");
  if (extensions.length) {
    console.log(`\n[!] ${extensions.length} scenes need extension (voice > 1.4× clip):`);
    for (const e of extensions.slice(0, 10)) {
      console.log(`    #${e.id} ${e.scene_tag} — voice_dur=${e.voice_dur}s (×${e.speed_factor})  "${e.title}"`);
    }
  }

  const planDoc = {
    project: "galveston_1900_veo3",
    generated_at: new Date().toISOString(),
    clip_dur_s: CLIP_DUR,
    audio_total_s: Number(totalAudio_s.toFixed(2)),
    voiceover_file: path.relative(ROOT, path.join(ROOT, "public/generated/galveston_1900_veo3/voiceover/galveston-doc.mp3")),
    stats: {
      total_voice_s: Number(totalVoice.toFixed(2)),
      action_counts: actionCounts,
      missing_clips: missingClips,
    },
    scenes: out,
  };
  writeFileSync(OUT_PATH, JSON.stringify(planDoc, null, 2));
  console.log(`\n-> ${path.relative(ROOT, OUT_PATH)}`);
}

main();
