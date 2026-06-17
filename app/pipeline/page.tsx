"use client";

import { useState, useEffect, useRef } from "react";
import { Film, Clock, CheckCircle2, Sparkles, Mic, FileText, Upload, Rocket, Loader2, Type, Image as ImageIcon, Layers, X, Palette, Volume2, Brush, Clapperboard, Zap } from "lucide-react";
import { JobTracker } from "@/components/pipeline/job-tracker";
import type { ChannelPreset } from "@/lib/presets/channel-presets";
import type { KitSummary } from "@/lib/style-kit/types";

interface VideoEntry {
  id: string;
  videoUrl: string;
  fileSize: number;
  createdAt: string;
}

const VOICES = [
  { id: "male-fr", label: "Masculine FR", sub: "Ton narratif, grave" },
  { id: "female-fr", label: "Feminine FR", sub: "Ton informatif, clair" },
  { id: "male-en", label: "Masculine EN", sub: "Cinematic, deep" },
  { id: "female-en", label: "Feminine EN", sub: "Storytelling, warm" },
];

const NICHES = [
  "Mystères & Faits", "Tech & Science", "Dev. personnel",
  "Voyage & Culture", "Histoire", "Finance", "Santé & Bien-être",
  "Gaming", "Luxe & Lifestyle", "Motivation",
];

const STYLE_PRESETS: Array<{ label: string; suffix: string }> = [
  { label: "Cartoon finance", suffix: "flat cartoon illustration, AfterSkool-style stick-figure characters with round expressive heads and thin black limbs, bold black outlines, soft pastel fills, simplified city skyline background, finance/business theme, clean composition, 16:9" },
  { label: "Watercolor doux", suffix: "hand-drawn watercolor illustration style, soft ink outlines, delicate washes of muted warm earth tones, dreamy storybook aesthetic, gentle color palette, 16:9" },
  { label: "Cinéma doc", suffix: "cinematic documentary photography, dramatic lighting, rich colors, photorealistic, 8k, 16:9" },
  { label: "Noir mystère", suffix: "dark moody atmosphere, desaturated colors, noir cinematography, deep shadows, mysterious fog, photorealistic, 8k, 16:9" },
  { label: "3D pixar-like", suffix: "stylized 3D render in the style of modern animated features, soft global illumination, rounded shapes, expressive characters, vibrant but tasteful palette, 8k, 16:9" },
  { label: "Anime ghibli", suffix: "Studio Ghibli inspired anime illustration, hand-painted backgrounds, soft cel-shading, warm nostalgic palette, 16:9" },
  { label: "Palais chinois (vecteur)", suffix: "A detailed, clean-line 2D vector-art cartoon illustration. Symmetrical, centered composition of a high-status ancient Chinese character or group. Character features stylized, simplified faces with clear outlines, but rich, complex embroidery patterns on their silk robes (like dragons, phoenixes, or waves). The setting is a weakly-lit traditional palace hall with massive red columns, dark tiled floors, and a distant golden throne. The scene is densely filled with dozens of hanging red paper lanterns, featuring precise gold Chinese calligraphy. Distinct, massive, stylized curling wisps of incense smoke (blue-grey) must weave through the composition. Warm, ambient lantern-lit atmosphere with rich, textured colors (teals, golds, deep reds). No 3D rendering." },
];

type VideoMode = "t2v" | "i2v" | "ingredients" | "static-images";

const VIDEO_MODES: Array<{ id: VideoMode; label: string; sub: string; Icon: typeof Film; desc: string }> = [
  {
    id: "t2v",
    label: "Text to video",
    sub: "Veo3 — text-to-video direct",
    Icon: Type,
    desc: "Le plus rapide. Veo3 génère le clip directement depuis le prompt, sans image intermédiaire.",
  },
  {
    id: "i2v",
    label: "Image to video",
    sub: "Veo — image puis animation",
    Icon: ImageIcon,
    desc: "Plus de contrôle. On génère d'abord une image (nano_banana_pro) puis on l'anime via frames-to-video.",
  },
  {
    id: "ingredients",
    label: "Ingredients to video",
    sub: "Veo — multi-référence",
    Icon: Layers,
    desc: "On donne plusieurs images de référence en input. Idéal pour conserver un personnage / lieu sur plusieurs scènes.",
  },
  {
    id: "static-images",
    label: "Static images (Ken Burns)",
    sub: "create-image only — pas de Veo clip",
    Icon: ImageIcon,
    desc: "Génère uniquement des images statiques (avec refs si uploadées, jusqu'à 5). Le montage les anime via Ken Burns. Idéal preset Sticky.",
  },
];

export default function PipelinePage() {
  const [presets, setPresets] = useState<ChannelPreset[]>([]);
  const [presetId, setPresetId] = useState("auto");
  const [title, setTitle] = useState("");
  const [niche, setNiche] = useState(NICHES[0]);
  const [voice, setVoice] = useState("male-fr");
  const [duration, setDuration] = useState(10);
  const [voiceMode, setVoiceMode] = useState<"preset" | "custom">("preset");
  const [customVoiceId, setCustomVoiceId] = useState("");
  const [customScript, setCustomScript] = useState("");
  const [describeKitScriptSource, setDescribeKitScriptSource] = useState<"auto" | "custom">("auto");
  const [imageProvider, setImageProvider] = useState<"genaipro" | "geminigen" | "wan" | "flowmax">("genaipro");
  const [geminigenModel, setGeminigenModel] = useState<"nano-banana-pro" | "nano-banana-2" | "imagen-4">("nano-banana-2");
  const [wanModel, setWanModel] = useState<"wan2.7-image" | "wan2.7-image-pro">("wan2.7-image");
  const [animationProvider, setAnimationProvider] = useState<"genaipro" | "wan" | "seedance">("genaipro");
  const [wanI2VModel, setWanI2VModel] = useState<"wan2.2-i2v-flash" | "wan2.2-i2v-plus" | "wanx2.1-i2v-turbo" | "wanx2.1-i2v-plus">("wan2.2-i2v-flash");
  const [voiceModel, setVoiceModel] = useState<"genaipro" | "elevenlabs" | "fishspeech">("genaipro");
  const [genaiproTTSModel, setGenaiproTTSModel] = useState<"eleven_multilingual_v2" | "eleven_turbo_v2_5" | "eleven_flash_v2_5" | "eleven_v3">("eleven_multilingual_v2");
  const [voiceSpeed, setVoiceSpeed] = useState<number>(1);
  const [audioSpeed, setAudioSpeed] = useState<number>(1);
  const [videoMode, setVideoMode] = useState<VideoMode>("t2v");
  const [refImages, setRefImages] = useState<File[]>([]);
  const [refPreviews, setRefPreviews] = useState<string[]>([]);
  const [kits, setKits] = useState<KitSummary[]>([]);
  const [kitSlug, setKitSlug] = useState<string>("");
  const [kitBrief, setKitBrief] = useState<string>("");
  const [customStyle, setCustomStyle] = useState("");
  const [voiceoverEnabled, setVoiceoverEnabled] = useState(true);
  const [keepClipAudio, setKeepClipAudio] = useState(false);
  const [pilotMode, setPilotMode] = useState(false);
  const [pilotSampleSize, setPilotSampleSize] = useState(5);
  const [customHasImagePrompts, setCustomHasImagePrompts] = useState(false);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(false);
  const [alignWithWhisper, setAlignWithWhisper] = useState(true);
  const [removeSilences, setRemoveSilences] = useState(false);
  const [voiceoverGate, setVoiceoverGate] = useState(false);
  const [competitorUrl, setCompetitorUrl] = useState("");
  const [rewriteCompetitor, setRewriteCompetitor] = useState(false);

  const [launching, setLaunching] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [videos, setVideos] = useState<VideoEntry[]>([]);
  const formRef = useRef<HTMLDivElement>(null);

  // Auto-flip describeKitScriptSource to "custom" as soon as the user pastes ≥ 50 chars of script,
  // and back to "auto" if they clear it. Prevents the silent regen bug where a customScript was ignored
  // because the toggle was left on the default.
  useEffect(() => {
    if (customScript.trim().length >= 50) {
      setDescribeKitScriptSource("custom");
    } else {
      setDescribeKitScriptSource("auto");
    }
  }, [customScript]);

  useEffect(() => {
    fetch("/api/presets")
      .then((r) => r.json())
      .then((data: ChannelPreset[]) => {
        if (Array.isArray(data) && data.length > 0) {
          setPresets(data);
          if (!data.find((p) => p.id === presetId)) setPresetId(data[0].id);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch("/api/videos")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setVideos(data); })
      .catch(() => {});
  }, [activeJobId]);

  useEffect(() => {
    fetch("/api/style-kit")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data?.kits)) setKits(data.kits); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!kitSlug) { setKitBrief(""); return; }
    fetch(`/api/style-kit/${kitSlug}`)
      .then((r) => r.json())
      .then((data) => { setKitBrief(typeof data?.kit?.styleBrief === "string" ? data.kit.styleBrief : ""); })
      .catch(() => setKitBrief(""));
  }, [kitSlug]);

  useEffect(() => {
    const urls = refImages.map((f) => URL.createObjectURL(f));
    setRefPreviews(urls);
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [refImages]);

  const MAX_REFS = videoMode === "static-images" ? 5 : 3;
  const addRefImages = (files: FileList | null) => {
    if (!files) return;
    const incoming = Array.from(files).filter((f) => f.type.startsWith("image/"));
    setRefImages((prev) => [...prev, ...incoming].slice(0, MAX_REFS));
  };
  const removeRefImage = (idx: number) => {
    setRefImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const selectedPreset = presets.find((p) => p.id === presetId);
  useEffect(() => {
    if (selectedPreset) {
      setDuration(selectedPreset.durationRange.default);
      if (selectedPreset.language === "en" && voice.endsWith("-fr")) {
        setVoice(voice.replace("-fr", "-en"));
      } else if (selectedPreset.language === "fr" && voice.endsWith("-en")) {
        setVoice(voice.replace("-en", "-fr"));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId]);

  const canLaunch = title.trim().length >= 3 && !!selectedPreset && !launching && !queuing;

  const submit = async (target: "pipeline" | "queue") => {
    if (!canLaunch) return;
    if (target === "pipeline") setLaunching(true); else setQueuing(true);
    setError(null);
    setQueueNotice(null);
    try {
      const finalVoice = voiceMode === "custom" && customVoiceId.trim() ? customVoiceId.trim() : voice;
      const finalScript = customScript.trim().length >= 50 ? customScript.trim() : "";
      const kitActive = !!kitSlug && (videoMode === "ingredients" || videoMode === "static-images");
      // FlowMax : le perso de réf (le "bonhomme") est uploadé et sert d'ancre @ sur toutes les scènes,
      // quel que soit le videoMode → on force le multipart pour transmettre le fichier.
      const useMultipart = refImages.length > 0 && (
        ((videoMode === "ingredients" || videoMode === "static-images") && !kitActive)
        || imageProvider === "flowmax"
      );
      const endpoint = target === "queue" ? "/api/queue" : "/api/pipeline";

      const res = useMultipart
        ? await fetch(endpoint, { method: "POST", body: (() => {
            const fd = new FormData();
            fd.append("title", title.trim());
            fd.append("niche", niche);
            fd.append("voix", finalVoice);
            fd.append("duration", String(duration));
            fd.append("presetId", presetId);
            fd.append("videoMode", videoMode);
            fd.append("scenario", "A");
            if (finalScript) fd.append("customScript", finalScript);
            if (customStyle.trim()) fd.append("customStyle", customStyle.trim());
            fd.append("voiceoverEnabled", String(voiceoverEnabled));
            fd.append("muteClipAudio", String(!keepClipAudio));
            for (const f of refImages) fd.append("userRefImages", f, f.name);
            if (kitActive) fd.append("styleKitSlug", kitSlug);
            if (competitorUrl.trim()) fd.append("competitorVideoUrl", competitorUrl.trim());
            if (competitorUrl.trim() && rewriteCompetitor) fd.append("rewriteCompetitorScript", "true");
            if (pilotMode) { fd.append("pilotMode", "true"); fd.append("pilotSampleSize", String(pilotSampleSize)); }
            if (finalScript && customHasImagePrompts) fd.append("customScriptHasImagePrompts", "true");
            fd.append("subtitlesEnabled", String(subtitlesEnabled));
            fd.append("alignWithWhisper", String(alignWithWhisper));
            fd.append("removeSilences", String(removeSilences));
            if (kitActive && kits.find((k) => k.slug === kitSlug)?.mode === "describe") {
              fd.append("describeKitScriptSource", describeKitScriptSource);
            }
            fd.append("imageProvider", imageProvider);
            if (imageProvider === "geminigen") fd.append("geminigenModel", geminigenModel);
            if (imageProvider === "wan") fd.append("wanModel", wanModel);
            fd.append("animationProvider", animationProvider);
            if (animationProvider === "wan") fd.append("wanI2VModel", wanI2VModel);
            fd.append("voiceModel", voiceModel);
            if (voiceModel === "genaipro") fd.append("genaiproTTSModel", genaiproTTSModel);
            fd.append("voiceSpeed", String(voiceSpeed));
            fd.append("audioSpeed", String(audioSpeed));
            if (voiceoverGate) fd.append("voiceoverGate", "true");
            return fd;
          })() })
        : await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: title.trim(),
              niche,
              voix: finalVoice,
              duration,
              presetId,
              videoMode,
              scenario: "A",
              customScript: finalScript || undefined,
              customStyle: customStyle.trim() || undefined,
              voiceoverEnabled,
              muteClipAudio: !keepClipAudio,
              styleKitSlug: kitActive ? kitSlug : undefined,
              competitorVideoUrl: competitorUrl.trim() || undefined,
              rewriteCompetitorScript: (competitorUrl.trim() && rewriteCompetitor) || undefined,
              pilotMode: pilotMode || undefined,
              pilotSampleSize: pilotMode ? pilotSampleSize : undefined,
              customScriptHasImagePrompts: (finalScript && customHasImagePrompts) || undefined,
              subtitlesEnabled,
              alignWithWhisper,
              removeSilences,
              describeKitScriptSource:
                kitActive && kits.find((k) => k.slug === kitSlug)?.mode === "describe"
                  ? describeKitScriptSource
                  : undefined,
              imageProvider,
              geminigenModel: imageProvider === "geminigen" ? geminigenModel : undefined,
              wanModel: imageProvider === "wan" ? wanModel : undefined,
              animationProvider,
              wanI2VModel: animationProvider === "wan" ? wanI2VModel : undefined,
              voiceModel,
              genaiproTTSModel: voiceModel === "genaipro" ? genaiproTTSModel : undefined,
              voiceSpeed,
              audioSpeed,
              voiceoverGate: voiceoverGate || undefined,
            }),
          });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      if (target === "queue") {
        if (!data.entry?.id) throw new Error("Réponse queue invalide");
        setQueueNotice(`Ajouté à la queue · ${data.entry.id}`);
      } else {
        if (!data.jobId) throw new Error("Réponse pipeline invalide");
        setActiveJobId(data.jobId);
        requestAnimationFrame(() => {
          formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLaunching(false);
      setQueuing(false);
    }
  };

  const launch = () => submit("pipeline");
  const enqueue = () => submit("queue");

  return (
    <div className="space-y-8 animate-in pb-12">
      <header>
        <div className="mono-sm mb-2">Workspace · Production</div>
        <h1 className="heading-xl">Nouvelle vidéo</h1>
        <p className="text-[14px] mt-2 max-w-2xl" style={{ color: "var(--text-secondary)" }}>
          Crée une vidéo complète : script Claude → voiceover → images → animation → montage. Tout dans un seul run.
        </p>
      </header>

      <div ref={formRef} className="grid gap-6" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px" }}>
        {/* === COL 1 : Form === */}
        <div className="space-y-4">
          {/* Preset */}
          <Section icon={Sparkles} title="Style de chaîne" subtitle="Détermine le ton, le rythme et l'aspect visuel">
            {presets.length === 0 ? (
              <div className="mono-sm py-6 text-center">chargement…</div>
            ) : (
              <div className="grid gap-2">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPresetId(p.id)}
                    className="flex items-start gap-3 p-3.5 text-left transition-all"
                    style={{
                      background: presetId === p.id ? "var(--accent-bg)" : "var(--bg-glass)",
                      border: `1.5px solid ${presetId === p.id ? "var(--accent)" : "var(--border-glass)"}`,
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    <span className="text-2xl flex-shrink-0">{p.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[14px] font-semibold">{p.label}</span>
                        <span className="mono-sm">{p.durationRange.min}–{p.durationRange.max}min · {p.language.toUpperCase()}</span>
                      </div>
                      <p className="text-[12px] mt-1" style={{ color: "var(--text-secondary)" }}>
                        {p.description}
                      </p>
                    </div>
                    {presetId === p.id && (
                      <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "var(--accent)" }}>
                        <CheckCircle2 size={11} color="white" strokeWidth={3} />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </Section>

          {/* Detail */}
          <Section
            icon={Palette}
            title="Style visuel custom"
            subtitle="Optionnel — décris ton style libre (override le preset). Appliqué à TOUTES les images."
          >
            <div className="flex flex-wrap gap-1.5 mb-2">
              {STYLE_PRESETS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => setCustomStyle(s.suffix)}
                  className="px-2.5 py-1 text-[11px] font-medium transition-all"
                  style={{
                    background: customStyle === s.suffix ? "var(--accent-bg)" : "var(--bg-glass)",
                    border: `1px solid ${customStyle === s.suffix ? "var(--accent)" : "var(--border-glass)"}`,
                    borderRadius: "var(--radius-sm)",
                    color: customStyle === s.suffix ? "var(--accent)" : "var(--text-secondary)",
                  }}
                >
                  {s.label}
                </button>
              ))}
              {customStyle && (
                <button
                  type="button"
                  onClick={() => setCustomStyle("")}
                  className="px-2.5 py-1 text-[11px] font-medium transition-all flex items-center gap-1"
                  style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", borderRadius: "var(--radius-sm)", color: "var(--text-tertiary)" }}
                >
                  <X size={10} /> Reset
                </button>
              )}
            </div>
            <textarea
              value={customStyle}
              onChange={(e) => setCustomStyle(e.target.value)}
              placeholder="Ex : flat cartoon illustration, AfterSkool style, bold black outlines, stick-figure characters with round heads, simplified city skyline background, finance theme, 16:9"
              rows={3}
              className="w-full px-3 py-2.5 text-[13px] outline-none resize-y"
              style={{ ...inputStyle, fontFamily: "var(--font-mono), monospace", lineHeight: 1.5 }}
            />
            {customStyle.trim() && (
              <div className="mono-sm mt-1.5" style={{ color: "var(--green)" }}>
                Override actif — le preset {selectedPreset?.label ?? ""} sera ignoré sur le visuel
              </div>
            )}
            {videoMode === "static-images" && customStyle.trim() && customScript.trim().length > 20 && !customHasImagePrompts && (
              <div className="mono-sm mt-1.5" style={{ color: "var(--accent)" }}>
                Mode sticky détecté — ce style sera utilisé comme méta-prompt envoyé à Claude (pas comme suffix par image). Claude lit ton script et génère les image prompts au format <code>IMAGE N — MM:SS–MM:SS</code>.
              </div>
            )}
          </Section>

          <Section icon={FileText} title="Détails" subtitle="Titre, niche, durée">
            <div className="grid gap-4">
              <Field label="Titre" hint={`${title.length} caractères · min 3`}>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ex : Les 7 mystères de la pyramide de Khéops"
                  className="w-full px-3 py-2.5 text-[14px] outline-none"
                  style={inputStyle}
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Niche">
                  <select
                    value={niche}
                    onChange={(e) => setNiche(e.target.value)}
                    className="w-full px-3 py-2.5 text-[14px] outline-none"
                    style={inputStyle}
                  >
                    {NICHES.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </Field>

                <Field label={`Durée · ${duration}min`}>
                  <input
                    type="range"
                    min={selectedPreset?.durationRange.min ?? 5}
                    max={selectedPreset?.durationRange.max ?? 60}
                    value={duration}
                    onChange={(e) => setDuration(parseInt(e.target.value, 10))}
                    className="w-full"
                  />
                </Field>
              </div>
            </div>
          </Section>

          {/* Competitor video to replicate */}
          <Section
            icon={Clapperboard}
            title="Vidéo à répliquer"
            subtitle="Optionnel — URL YouTube d'une vidéo qui marche. Le pipeline pioche la miniature comme ref nano_banana, et (si tu coches) refait le script en 20% rewrite anti-plagiat."
          >
            <Field label="URL YouTube" hint={competitorUrl.trim() ? "valide si watch/shorts/embed/youtu.be" : "ex: https://www.youtube.com/watch?v=…"}>
              <input
                type="url"
                value={competitorUrl}
                onChange={(e) => setCompetitorUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=…"
                className="w-full px-3 py-2.5 text-[13px] outline-none font-mono"
                style={inputStyle}
                spellCheck={false}
              />
            </Field>
            {competitorUrl.trim() && (
              <div className="mt-3">
                <Toggle
                  label="Réécrire le script (anti-plagiat)"
                  description="Télécharge le transcript de la vidéo, demande à Claude une version réécrite à ~20% en gardant la structure gagnante (hook, beats, callbacks). Remplace le script généré par Claude. Le champ 'Script personnalisé' ci-dessous est ignoré si actif."
                  checked={rewriteCompetitor}
                  onChange={setRewriteCompetitor}
                />
              </div>
            )}
            {competitorUrl.trim() && !rewriteCompetitor && (
              <div className="mono-sm mt-2" style={{ color: "var(--text-secondary)" }}>
                Toggle off — la miniature concurrente est utilisée comme ref, le script reste généré par Claude depuis ton titre.
              </div>
            )}
          </Section>

          {/* Voice */}
          <Section icon={Mic} title="Voix" subtitle="Voiceover ElevenLabs — preset ou voice ID custom">
            <div className="flex gap-1 mb-3 p-1 w-fit" style={{ background: "var(--bg-glass)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-glass)" }}>
              <button
                onClick={() => setVoiceMode("preset")}
                className="px-3 py-1.5 text-[12px] font-medium transition-all"
                style={{
                  background: voiceMode === "preset" ? "var(--accent)" : "transparent",
                  color: voiceMode === "preset" ? "white" : "var(--text-secondary)",
                  borderRadius: "calc(var(--radius-sm) - 2px)",
                }}
              >
                Preset
              </button>
              <button
                onClick={() => setVoiceMode("custom")}
                className="px-3 py-1.5 text-[12px] font-medium transition-all"
                style={{
                  background: voiceMode === "custom" ? "var(--accent)" : "transparent",
                  color: voiceMode === "custom" ? "white" : "var(--text-secondary)",
                  borderRadius: "calc(var(--radius-sm) - 2px)",
                }}
              >
                Voice ID custom
              </button>
            </div>

            {voiceMode === "preset" ? (
              <div className="grid grid-cols-2 gap-2">
                {VOICES.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setVoice(v.id)}
                    className="px-3 py-2.5 text-left transition-all"
                    style={{
                      background: voice === v.id ? "var(--accent-bg)" : "var(--bg-glass)",
                      border: `1.5px solid ${voice === v.id ? "var(--accent)" : "var(--border-glass)"}`,
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    <div className="text-[13px] font-semibold">{v.label}</div>
                    <div className="mono-sm">{v.sub}</div>
                  </button>
                ))}
              </div>
            ) : (
              <Field label="ElevenLabs Voice ID" hint={customVoiceId.trim() ? `${customVoiceId.length} chars` : "Trouve l'ID dans ElevenLabs > Voices"}>
                <input
                  type="text"
                  value={customVoiceId}
                  onChange={(e) => setCustomVoiceId(e.target.value)}
                  placeholder="Ex : 9BWtsMINqrJLrRacOk9x"
                  className="w-full px-3 py-2.5 text-[13px] outline-none font-mono"
                  style={inputStyle}
                  spellCheck={false}
                />
                {customVoiceId.trim() && !/^[A-Za-z0-9]{16,32}$/.test(customVoiceId.trim()) && (
                  <div className="mono-sm mt-1.5" style={{ color: "var(--orange)" }}>
                    Format inattendu — un voice ID ElevenLabs fait ~20 caractères alphanumériques
                  </div>
                )}
              </Field>
            )}
          </Section>

          {/* Custom script */}
          <Section icon={Upload} title="Script personnalisé" subtitle="Optionnel — colle un script déjà écrit pour skipper la génération Claude">
            <textarea
              value={customScript}
              onChange={(e) => setCustomScript(e.target.value)}
              placeholder="Colle un script existant ici (≥ 50 mots). Laisse vide pour générer via Claude depuis le titre."
              rows={6}
              className="w-full px-3 py-2.5 text-[13px] outline-none resize-y"
              style={{ ...inputStyle, fontFamily: "var(--font-mono), monospace", lineHeight: 1.5 }}
            />
            {customScript.trim().length > 0 && customScript.trim().length < 50 && (
              <div className="mono-sm mt-1.5" style={{ color: "var(--orange)" }}>
                Trop court — au moins 50 mots requis pour skipper Claude
              </div>
            )}
            {customScript.trim().split(/\s+/).filter(Boolean).length >= 50 && (
              <div className="mono-sm mt-1.5" style={{ color: "var(--green)" }}>
                {customScript.trim().split(/\s+/).filter(Boolean).length} mots · Claude sera bypassé
              </div>
            )}
            {customScript.trim().split(/\s+/).filter(Boolean).length >= 50 && (
              <div className="mt-3">
                <Toggle
                  label="Le script contient déjà les image prompts"
                  description="Active si ton txt a une narration ET une description visuelle par scène (formats type 'Image:', 'Visual:', '[IMAGE]', etc.). Claude extraira les 2 verbatim au lieu de regénérer les visuels."
                  checked={customHasImagePrompts}
                  onChange={setCustomHasImagePrompts}
                />
              </div>
            )}
          </Section>

          {/* Video mode */}
          <Section icon={Film} title="Mode de génération vidéo" subtitle="Comment chaque scène est rendue par GenAIPro">
            <div className="grid gap-2">
              {VIDEO_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setVideoMode(m.id)}
                  className="flex items-start gap-3 p-3.5 text-left transition-all"
                  style={{
                    background: videoMode === m.id ? "var(--accent-bg)" : "var(--bg-glass)",
                    border: `1.5px solid ${videoMode === m.id ? "var(--accent)" : "var(--border-glass)"}`,
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0" style={{ background: videoMode === m.id ? "var(--accent)" : "var(--bg-glass-hover)", color: videoMode === m.id ? "white" : "var(--text-secondary)" }}>
                    <m.Icon size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-semibold">{m.label}</span>
                      <span className="mono-sm">{m.sub}</span>
                    </div>
                    <p className="text-[12px] mt-1" style={{ color: "var(--text-secondary)" }}>
                      {m.desc}
                    </p>
                  </div>
                  {videoMode === m.id && (
                    <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "var(--accent)" }}>
                      <CheckCircle2 size={11} color="white" strokeWidth={3} />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </Section>

          {/* Image provider toggle */}
          <Section
            icon={Zap}
            title="Provider images"
            subtitle="Quelle API génère les images de chaque scène"
          >
            <div className="grid gap-2">
              {[
                {
                  id: "genaipro" as const,
                  label: "GenAIPro Veo",
                  sub: "Modèle historique",
                  desc: "Veo create-image (nano_banana_pro). Bon pour photoréaliste + refs. Concurrency 3 + 15s entre batches.",
                },
                {
                  id: "geminigen" as const,
                  label: "Geminigen.AI",
                  sub: "Gemini 3 / Imagen",
                  desc: "Modèles Gemini 3 (nano-banana-pro/2) + Imagen 4. Concurrency 3 + 15s entre batches.",
                },
                {
                  id: "wan" as const,
                  label: "WAN 2.7 (Alibaba)",
                  sub: "Direct DashScope",
                  desc: "Tongyi Wanxiang 2.7 via DashScope Beijing. Sync API (pas de polling), jusqu'à 9 refs par scène, 4K dispo.",
                },
                {
                  id: "flowmax" as const,
                  label: "FlowMax (Google Flow)",
                  sub: "Workers Chrome réels",
                  desc: "Google Flow réel piloté par les workers FlowMax. Réf @ par NOM (image importée dans Flow = basename de la réf). Nécessite FLOWMAX_SERVER_URL + workers en ligne.",
                },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setImageProvider(p.id)}
                  className="flex items-start gap-3 p-3.5 text-left transition-all"
                  style={{
                    background: imageProvider === p.id ? "var(--accent-bg)" : "var(--bg-glass)",
                    border: `1.5px solid ${imageProvider === p.id ? "var(--accent)" : "var(--border-glass)"}`,
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div
                    className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
                    style={{
                      background: imageProvider === p.id ? "var(--accent)" : "var(--bg-glass-hover)",
                      color: imageProvider === p.id ? "white" : "var(--text-secondary)",
                    }}
                  >
                    <Zap size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-semibold">{p.label}</span>
                      <span className="mono-sm">{p.sub}</span>
                    </div>
                    <p className="text-[12px] mt-1" style={{ color: "var(--text-secondary)" }}>
                      {p.desc}
                    </p>
                  </div>
                  {imageProvider === p.id && (
                    <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "var(--accent)" }}>
                      <CheckCircle2 size={11} color="white" strokeWidth={3} />
                    </div>
                  )}
                </button>
              ))}
            </div>

            {imageProvider === "wan" && (
              <div className="mt-3">
                <div className="mono-sm mb-1.5" style={{ color: "var(--text-secondary)" }}>
                  Modèle WAN
                </div>
                <div className="flex gap-1 p-1 w-fit" style={{ background: "var(--bg-glass)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-glass)" }}>
                  {[
                    { id: "wan2.7-image" as const, label: "wan2.7-image", hint: "Standard · plus rapide / moins cher · défaut" },
                    { id: "wan2.7-image-pro" as const, label: "wan2.7-image-pro", hint: "Pro · 4K, thinking mode, qualité max" },
                  ].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setWanModel(m.id)}
                      className="px-3 py-1.5 text-[12px] font-medium transition-all"
                      style={{
                        background: wanModel === m.id ? "var(--accent)" : "transparent",
                        color: wanModel === m.id ? "white" : "var(--text-secondary)",
                        borderRadius: "calc(var(--radius-sm) - 2px)",
                      }}
                      title={m.hint}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] mt-1.5" style={{ color: "var(--text-tertiary)" }}>
                  {wanModel === "wan2.7-image-pro"
                    ? "WAN 2.7 Pro — 4K, thinking mode, texte multilingue. Plus lent, plus cher."
                    : "WAN 2.7 standard — 1K par défaut, sync API. Bon compromis qualité/vitesse."}
                </div>
              </div>
            )}

            {imageProvider === "geminigen" && (
              <div className="mt-3">
                <div className="mono-sm mb-1.5" style={{ color: "var(--text-secondary)" }}>
                  Modèle Geminigen
                </div>
                <div className="flex gap-1 p-1 w-fit" style={{ background: "var(--bg-glass)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-glass)" }}>
                  {[
                    { id: "nano-banana-2" as const, label: "nano-banana-2", hint: "Flash · pas de rate limit · défaut" },
                    { id: "nano-banana-pro" as const, label: "nano-banana-pro", hint: "Pro · 5/min · 100/h · 1000/jour" },
                    { id: "imagen-4" as const, label: "imagen-4", hint: "Imagen 4 · pas de rate limit" },
                  ].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setGeminigenModel(m.id)}
                      className="px-3 py-1.5 text-[12px] font-medium transition-all"
                      style={{
                        background: geminigenModel === m.id ? "var(--accent)" : "transparent",
                        color: geminigenModel === m.id ? "white" : "var(--text-secondary)",
                        borderRadius: "calc(var(--radius-sm) - 2px)",
                      }}
                      title={m.hint}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] mt-1.5" style={{ color: "var(--text-tertiary)" }}>
                  {geminigenModel === "nano-banana-pro"
                    ? "⚠️ Rate limit Gemini : 5/min, 100/h, 1000/jour. Pour 400 scènes ≈ 80min minimum."
                    : geminigenModel === "imagen-4"
                    ? "Imagen 4 — fort sur textures fines. Aucun rate limit côté provider."
                    : "Gemini 3.1 Flash Image — vitesse + volume. Aucun rate limit côté provider. Retry auto sur GEMINI_RATE_LIMIT upstream."}
                </div>
              </div>
            )}
          </Section>

          {/* Animation provider toggle */}
          <Section
            icon={Zap}
            title="Provider animation"
            subtitle="Quelle API anime les images (mode I2V uniquement)"
          >
            <div className="grid gap-2">
              {[
                {
                  id: "genaipro" as const,
                  label: "GenAIPro Veo3",
                  sub: "frames-to-video",
                  desc: "Veo3 I2V (~8s par clip). Aussi utilisé pour T2V et Ingredients. Concurrency 8.",
                },
                {
                  id: "wan" as const,
                  label: "WAN I2V (Alibaba)",
                  sub: "wan-i2v · DashScope",
                  desc: "Alibaba wan-i2v via DashScope (async). 5s ou 10s par clip. Même clé que les images WAN. Fallback Veo3 pour T2V/Ingredients.",
                },
                {
                  id: "seedance" as const,
                  label: "Seedance (WaveSpeed)",
                  sub: "seedance-v1-pro-fast",
                  desc: "ByteDance seedance-v1-pro-fast via WaveSpeed (~5s par clip, rapide). Idéal combo FlowMax→Seedance. Nécessite wavespeedKey. Fallback Veo3 pour T2V/Ingredients.",
                },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setAnimationProvider(p.id)}
                  className="flex items-start gap-3 p-3.5 text-left transition-all"
                  style={{
                    background: animationProvider === p.id ? "var(--accent-bg)" : "var(--bg-glass)",
                    border: `1.5px solid ${animationProvider === p.id ? "var(--accent)" : "var(--border-glass)"}`,
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div
                    className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
                    style={{
                      background: animationProvider === p.id ? "var(--accent)" : "var(--bg-glass-hover)",
                      color: animationProvider === p.id ? "white" : "var(--text-secondary)",
                    }}
                  >
                    <Zap size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-semibold">{p.label}</span>
                      <span className="mono-sm">{p.sub}</span>
                    </div>
                    <p className="text-[12px] mt-1" style={{ color: "var(--text-secondary)" }}>
                      {p.desc}
                    </p>
                  </div>
                  {animationProvider === p.id && (
                    <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "var(--accent)" }}>
                      <CheckCircle2 size={11} color="white" strokeWidth={3} />
                    </div>
                  )}
                </button>
              ))}
            </div>

            {animationProvider === "wan" && (
              <div className="mt-3">
                <div className="mono-sm mb-1.5" style={{ color: "var(--text-secondary)" }}>
                  Modèle WAN I2V
                </div>
                <div className="flex gap-1 p-1 w-fit flex-wrap" style={{ background: "var(--bg-glass)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-glass)" }}>
                  {[
                    { id: "wan2.2-i2v-flash" as const, label: "wan2.2-i2v-flash", hint: "720P · rapide / cheap · défaut" },
                    { id: "wan2.2-i2v-plus" as const, label: "wan2.2-i2v-plus", hint: "1080P · meilleure qualité, plus lent" },
                    { id: "wanx2.1-i2v-turbo" as const, label: "wanx2.1-i2v-turbo", hint: "Legacy · 720P" },
                    { id: "wanx2.1-i2v-plus" as const, label: "wanx2.1-i2v-plus", hint: "Legacy · 720P+" },
                  ].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setWanI2VModel(m.id)}
                      className="px-3 py-1.5 text-[12px] font-medium transition-all"
                      style={{
                        background: wanI2VModel === m.id ? "var(--accent)" : "transparent",
                        color: wanI2VModel === m.id ? "white" : "var(--text-secondary)",
                        borderRadius: "calc(var(--radius-sm) - 2px)",
                      }}
                      title={m.hint}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] mt-1.5" style={{ color: "var(--text-tertiary)" }}>
                  {wanI2VModel === "wan2.2-i2v-plus"
                    ? "WAN 2.2 Plus — 1080P, 5/10s. Latence plus haute mais meilleur rendu."
                    : wanI2VModel === "wan2.2-i2v-flash"
                    ? "WAN 2.2 Flash — 720P, 5/10s. Rapide et économique, défaut recommandé."
                    : "WAN 2.1 legacy — à utiliser uniquement si la 2.2 n'est pas activée sur ton compte."}
                </div>
              </div>
            )}
          </Section>

          {/* Voice provider toggle */}
          <Section
            icon={Mic}
            title="Provider voix off"
            subtitle="Quelle API synthétise la narration"
          >
            <div className="grid gap-2">
              {[
                {
                  id: "genaipro" as const,
                  label: "GenAIPro Labs",
                  sub: "ElevenLabs hébergé · défaut",
                  desc: "POST /v1/labs/task async. Même clé GENAIPRO_API_KEY que les images/Veo. Voix ElevenLabs (Adam, Rachel, Antoni, Bella…).",
                },
                {
                  id: "elevenlabs" as const,
                  label: "ElevenLabs direct",
                  sub: "Clé xi-api-key",
                  desc: "Appel direct api.elevenlabs.io/v1/text-to-speech. Requiert ELEVENLABS_API_KEY. Sync (pas de polling).",
                },
                {
                  id: "fishspeech" as const,
                  label: "Fish Speech 1.5",
                  sub: "SiliconFlow · fallback",
                  desc: "Fish Speech via SiliconFlow. Moins cher, qualité plus brute. Bon fallback si quota ElevenLabs épuisé.",
                },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setVoiceModel(p.id)}
                  className="flex items-start gap-3 p-3.5 text-left transition-all"
                  style={{
                    background: voiceModel === p.id ? "var(--accent-bg)" : "var(--bg-glass)",
                    border: `1.5px solid ${voiceModel === p.id ? "var(--accent)" : "var(--border-glass)"}`,
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div
                    className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
                    style={{
                      background: voiceModel === p.id ? "var(--accent)" : "var(--bg-glass-hover)",
                      color: voiceModel === p.id ? "white" : "var(--text-secondary)",
                    }}
                  >
                    <Mic size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-semibold">{p.label}</span>
                      <span className="mono-sm">{p.sub}</span>
                    </div>
                    <p className="text-[12px] mt-1" style={{ color: "var(--text-secondary)" }}>
                      {p.desc}
                    </p>
                  </div>
                  {voiceModel === p.id && (
                    <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "var(--accent)" }}>
                      <CheckCircle2 size={11} color="white" strokeWidth={3} />
                    </div>
                  )}
                </button>
              ))}
            </div>

            {voiceModel === "genaipro" && (
              <div className="mt-3">
                <div className="mono-sm mb-1.5" style={{ color: "var(--text-secondary)" }}>
                  Modèle TTS
                </div>
                <div className="flex gap-1 p-1 w-fit flex-wrap" style={{ background: "var(--bg-glass)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-glass)" }}>
                  {[
                    { id: "eleven_multilingual_v2" as const, label: "multilingual_v2", hint: "Défaut · 29 langues · qualité premium" },
                    { id: "eleven_turbo_v2_5" as const, label: "turbo_v2_5", hint: "Latence basse · qualité élevée" },
                    { id: "eleven_flash_v2_5" as const, label: "flash_v2_5", hint: "Ultra rapide · qualité un cran en dessous" },
                    { id: "eleven_v3" as const, label: "v3", hint: "Modèle v3 expérimental" },
                  ].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setGenaiproTTSModel(m.id)}
                      className="px-3 py-1.5 text-[12px] font-medium transition-all"
                      style={{
                        background: genaiproTTSModel === m.id ? "var(--accent)" : "transparent",
                        color: genaiproTTSModel === m.id ? "white" : "var(--text-secondary)",
                        borderRadius: "calc(var(--radius-sm) - 2px)",
                      }}
                      title={m.hint}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] mt-1.5" style={{ color: "var(--text-tertiary)" }}>
                  {genaiproTTSModel === "eleven_flash_v2_5"
                    ? "Flash — sub-second latency, idéal pour scripts longs ou itérations rapides."
                    : genaiproTTSModel === "eleven_turbo_v2_5"
                    ? "Turbo — bon compromis latence/qualité, prix réduit vs multilingual_v2."
                    : genaiproTTSModel === "eleven_v3"
                    ? "v3 — modèle expérimental, peut être moins stable. À tester sur scripts courts d'abord."
                    : "Multilingual v2 — référence qualité, 29 langues, supporte FR + EN nativement."}
                </div>
              </div>
            )}

            {/* Speed controls */}
            <div className="mt-4 grid gap-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[13px] font-medium">
                    Vitesse TTS native
                    <span className="mono-sm ml-2" style={{ color: "var(--text-tertiary)" }}>
                      {voiceModel === "fishspeech" ? "indisponible" : "0.7 – 1.2"}
                    </span>
                  </label>
                  <span className="mono-sm" style={{ color: "var(--text-secondary)" }}>×{voiceSpeed.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.7}
                  max={1.2}
                  step={0.05}
                  value={voiceSpeed}
                  disabled={voiceModel === "fishspeech"}
                  onChange={(e) => setVoiceSpeed(parseFloat(e.target.value))}
                  className="w-full"
                  style={{ accentColor: "var(--accent)" }}
                />
                <div className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>
                  {voiceModel === "fishspeech"
                    ? "Fish Speech n'expose pas de paramètre de vitesse — utilise atempo ci-dessous."
                    : "Paramètre `speed` passé directement à ElevenLabs/GenAIPro. Limite dure 0.7-1.2 côté provider."}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[13px] font-medium">
                    Vitesse atempo (post-process)
                    <span className="mono-sm ml-2" style={{ color: "var(--text-tertiary)" }}>0.5 – 2.0</span>
                  </label>
                  <span className="mono-sm" style={{ color: "var(--text-secondary)" }}>×{audioSpeed.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={audioSpeed}
                  onChange={(e) => setAudioSpeed(parseFloat(e.target.value))}
                  className="w-full"
                  style={{ accentColor: "var(--accent)" }}
                />
                <div className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>
                  Filtre ffmpeg `atempo` appliqué au WAV après TTS, avant Whisper. Garde le pitch intact ; artefacts perceptibles hors [0.85, 1.3]. Effectif final ≈ TTS × atempo = ×{(voiceSpeed * audioSpeed).toFixed(2)}.
                </div>
              </div>
            </div>
          </Section>

          {/* Audio mix toggles */}
          <Section
            icon={Volume2}
            title="Audio"
            subtitle="Choisis les sources audio du montage final"
          >
            <div className="grid gap-3">
              <Toggle
                label="Voix off (ElevenLabs)"
                description="Génère un narrateur via ElevenLabs et l'ajoute au mix final."
                checked={voiceoverEnabled}
                onChange={setVoiceoverEnabled}
              />
              <Toggle
                label="Sons des vidéos"
                description="Garde l'audio original généré par Veo3 dans chaque clip (dialogues, ambiance). À activer pour les projets sans voix off."
                checked={keepClipAudio}
                onChange={setKeepClipAudio}
              />
              <Toggle
                label="Sous-titres burned-in"
                description="Affiche le texte de chaque scène en jaune sur la vidéo (ASS via libass). Désactivé par défaut — la voix off suffit en général."
                checked={subtitlesEnabled}
                onChange={setSubtitlesEnabled}
              />
              <Toggle
                label="Alignement Whisper (local)"
                description="Transcrit le voiceover via whisper-cli local (large-v3-turbo) et cale chaque clip sur la durée réelle de sa narration. Évite les clips qui finissent avant ou après la voix."
                checked={alignWithWhisper}
                onChange={setAlignWithWhisper}
              />
              <Toggle
                label="Nettoyer les silences (doux)"
                description="Resserre les blancs trop longs de la voix off (2-pass : micro-fade + respiration conservée, recalé Whisper ensuite). Conçu pour ne pas charcuter la voix. OFF par défaut."
                checked={removeSilences}
                onChange={setRemoveSilences}
              />
              <Toggle
                label="Valider la voix off avant images"
                description="Pause le pipeline après le voiceover. Tu écoutes l'audio dans /queue et choisis Valider / Refaire / Annuler avant que les images soient générées."
                checked={voiceoverGate}
                onChange={setVoiceoverGate}
              />
              {!voiceoverEnabled && !keepClipAudio && (
                <div className="mono-sm" style={{ color: "var(--orange)" }}>
                  Aucune source audio active — la vidéo finale sera silencieuse.
                </div>
              )}
              {!voiceoverEnabled && alignWithWhisper && (
                <div className="mono-sm" style={{ color: "var(--text-tertiary)" }}>
                  Alignement Whisper ignoré (pas de voix off à transcrire).
                </div>
              )}
            </div>
          </Section>

          {(videoMode === "ingredients" || videoMode === "static-images") && (
            <Section
              icon={Brush}
              title="Style Kit (pré-importé)"
              subtitle="Sélectionne un kit pour router automatiquement les refs par scène (character ↔ style). Désactive l'upload manuel."
            >
              {kits.length === 0 ? (
                <div className="mono-sm py-3">
                  Aucun kit importé. <a href="/style-kit" className="underline" style={{ color: "var(--accent)" }}>
                    Importer un PDF →
                  </a>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setKitSlug("")}
                    className="px-3 py-1.5 text-[12px] font-medium transition-all"
                    style={{
                      background: kitSlug === "" ? "var(--accent-bg)" : "var(--bg-glass)",
                      border: `1px solid ${kitSlug === "" ? "var(--accent)" : "var(--border-glass)"}`,
                      borderRadius: "var(--radius-sm)",
                      color: kitSlug === "" ? "var(--accent)" : "var(--text-secondary)",
                    }}
                  >
                    Aucun (upload manuel)
                  </button>
                  {kits.map((k) => {
                    const isDescribe = k.mode === "describe";
                    const count = isDescribe
                      ? `${k.characterCount + k.styleCount}p`
                      : `${k.characterCount}/${k.styleCount}`;
                    return (
                      <button
                        key={k.slug}
                        type="button"
                        onClick={() => setKitSlug(k.slug)}
                        className="px-3 py-1.5 text-[12px] font-medium transition-all"
                        style={{
                          background: kitSlug === k.slug ? "var(--accent-bg)" : "var(--bg-glass)",
                          border: `1px solid ${kitSlug === k.slug ? "var(--accent)" : "var(--border-glass)"}`,
                          borderRadius: "var(--radius-sm)",
                          color: kitSlug === k.slug ? "var(--accent)" : "var(--text-secondary)",
                        }}
                        title={
                          isDescribe
                            ? `Mode describe · ${k.characterCount + k.styleCount} prompts — Claude matche par scène`
                            : `${k.characterCount} character · ${k.styleCount} style`
                        }
                      >
                        {k.slug} <span className="mono-sm">({count}{isDescribe ? " · describe" : ""})</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {kitSlug && (
                <div className="mono-sm mt-2" style={{ color: "var(--green)" }}>
                  {kits.find((k) => k.slug === kitSlug)?.mode === "describe"
                    ? "Kit describe actif — Claude rank chaque scène contre les prompts du kit (1 call Sonnet) et pioche la meilleure ref avant la gen images."
                    : "Kit actif — le runner pioche 1 char + 4 style sur les scènes avec personnage, 5 style sinon."}
                </div>
              )}
              {kitSlug && kits.find((k) => k.slug === kitSlug)?.mode === "describe" && (
                <div className="mt-3 p-3" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", borderRadius: "var(--radius-sm)" }}>
                  <div className="mono-sm mb-2" style={{ color: "var(--text-secondary)" }}>
                    Source du script (scènes ~1.5s adaptive, 2s max)
                  </div>
                  <div className="flex gap-1 p-1 w-fit" style={{ background: "var(--bg-glass-hover)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-glass)" }}>
                    <button
                      type="button"
                      onClick={() => setDescribeKitScriptSource("auto")}
                      className="px-3 py-1.5 text-[12px] font-medium transition-all"
                      style={{
                        background: describeKitScriptSource === "auto" ? "var(--accent)" : "transparent",
                        color: describeKitScriptSource === "auto" ? "white" : "var(--text-secondary)",
                        borderRadius: "calc(var(--radius-sm) - 2px)",
                      }}
                    >
                      Auto-generate
                    </button>
                    <button
                      type="button"
                      onClick={() => setDescribeKitScriptSource("custom")}
                      className="px-3 py-1.5 text-[12px] font-medium transition-all"
                      style={{
                        background: describeKitScriptSource === "custom" ? "var(--accent)" : "transparent",
                        color: describeKitScriptSource === "custom" ? "white" : "var(--text-secondary)",
                        borderRadius: "calc(var(--radius-sm) - 2px)",
                      }}
                    >
                      Custom script
                    </button>
                  </div>
                  <div className="text-[11px] mt-2" style={{ color: "var(--text-tertiary)" }}>
                    {describeKitScriptSource === "auto"
                      ? "Claude écrit script + découpe en scènes 1–2s (défaut 1.5s, cuts agressifs sur virgules / sous-phrases). Max rétention. Le JSON describe-kit sert de vocabulaire visuel."
                      : "Colle ton script dans la section dédiée — Claude le découpe en scènes 1–2s adaptive (cuts sur virgules et sous-phrases) en s'appuyant sur le vocabulaire du kit."}
                  </div>
                </div>
              )}
              {kitSlug && kitBrief && !customStyle.trim() && (
                <div className="mt-3">
                  <div className="mono-sm mb-1.5" style={{ color: "var(--green)" }}>
                    Style brief auto — sera utilisé comme prompt suffix sur CHAQUE image (override-able en remplissant &laquo; Style visuel custom &raquo;)
                  </div>
                  <pre
                    className="text-[11px] whitespace-pre-wrap px-3 py-2"
                    style={{
                      background: "var(--bg-glass-hover)",
                      border: "1px solid var(--border-glass)",
                      borderRadius: "var(--radius-sm)",
                      fontFamily: "var(--font-mono), monospace",
                      lineHeight: 1.5,
                      maxHeight: 160,
                      overflow: "auto",
                    }}
                  >
                    {kitBrief}
                  </pre>
                </div>
              )}
              {kitSlug && kitBrief && customStyle.trim() && (
                <div className="mono-sm mt-3" style={{ color: "var(--orange)" }}>
                  Le style brief du kit est ignoré — ton &laquo; Style visuel custom &raquo; prend le dessus.
                </div>
              )}
            </Section>
          )}

          {((((videoMode === "ingredients" || videoMode === "static-images") && !kitSlug)) || imageProvider === "flowmax") && (
            <Section
              icon={ImageIcon}
              title={imageProvider === "flowmax" ? "Personnage de référence (FlowMax @)" : "Images de référence"}
              subtitle={imageProvider === "flowmax"
                ? "Upload le perso (le « bonhomme »). Le NOM DU FICHIER = la réf @ importée dans ton compte Flow (ex: alphonse.png → @alphonse). La 1ʳᵉ image sert d'ancre perso sur TOUTES les scènes. Universel : marche pour n'importe quelle niche."
                : videoMode === "static-images"
                ? "Injectées dans CHAQUE create-image — locke le style (max 5, ≤20 Mo, png/jpg/webp — limite API Veo)"
                : "Injectées dans CHAQUE scène — utile pour garder un personnage / lieu cohérent (max 3, ≤15 Mo, png/jpg/webp — limite API Veo)"}
            >
              <label
                className="flex flex-col items-center justify-center gap-2 py-6 px-4 cursor-pointer transition-all"
                style={{
                  background: "var(--bg-glass-hover)",
                  border: `1.5px dashed var(--border-glass)`,
                  borderRadius: "var(--radius-sm)",
                }}
              >
                <Upload size={18} style={{ color: "var(--text-secondary)" }} />
                <div className="text-[13px] font-medium">
                  {refImages.length === 0 ? "Glisse une image ou clique pour parcourir" : "Ajouter d'autres images"}
                </div>
                <div className="mono-sm">{refImages.length}/{MAX_REFS} sélectionnée{refImages.length > 1 ? "s" : ""}</div>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => { addRefImages(e.target.files); e.target.value = ""; }}
                  disabled={refImages.length >= MAX_REFS}
                />
              </label>

              {refImages.length > 0 && (
                <div className="grid grid-cols-4 gap-2 mt-3">
                  {refImages.map((f, i) => (
                    <div
                      key={`${f.name}-${i}`}
                      className="relative group aspect-square overflow-hidden"
                      style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", borderRadius: "var(--radius-sm)" }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={refPreviews[i]} alt={f.name} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeRefImage(i)}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ background: "rgba(0,0,0,0.7)", color: "white" }}
                        aria-label="Retirer"
                      >
                        <X size={12} />
                      </button>
                      <div className="absolute bottom-0 inset-x-0 px-1.5 py-1 text-[10px] truncate" style={{ background: "rgba(0,0,0,0.6)", color: "white" }}>
                        {f.name}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {error && (
            <div className="px-4 py-3 rounded-lg text-[13px]" style={{ background: "var(--red-bg)", color: "var(--red)" }}>
              {error}
            </div>
          )}
        </div>

        {/* === COL 2 : Sticky launch panel === */}
        <aside className="sticky top-6 self-start space-y-4">
          <div className="glass-strong p-5 space-y-4">
            <div>
              <div className="mono-sm">Aperçu</div>
              <div className="mt-2 text-[15px] font-semibold leading-tight" style={{ color: "var(--text-primary)" }}>
                {title.trim() || "Titre à définir…"}
              </div>
              <div className="text-[12px] mt-1" style={{ color: "var(--text-secondary)" }}>
                {selectedPreset?.label ?? "—"} · {duration} min · {voiceMode === "custom" && customVoiceId.trim() ? `voice ${customVoiceId.slice(0, 8)}…` : voice}
              </div>
            </div>

            <div className="h-px" style={{ background: "var(--border-glass)" }} />

            <div className="space-y-1.5 text-[12px]" style={{ color: "var(--text-secondary)" }}>
              <Row label="Niche" value={niche} />
              <Row label="Mode" value={VIDEO_MODES.find((m) => m.id === videoMode)?.label ?? videoMode} />
              {customScript.trim().split(/\s+/).filter(Boolean).length >= 50 && customHasImagePrompts ? (
                <Row label="Style" value="depuis prompts" accent="green" />
              ) : customStyle.trim() ? (
                <Row label="Style" value="custom" accent="green" />
              ) : null}
              {(videoMode === "ingredients" || videoMode === "static-images") && kitSlug && (
                <Row label="Style kit" value={kitSlug} accent="green" />
              )}
              {videoMode === "ingredients" && !kitSlug && (
                <Row label="Refs uploadées" value={`${refImages.length} image${refImages.length > 1 ? "s" : ""}`} />
              )}
              {competitorUrl.trim() && (
                <Row label="Replique" value={rewriteCompetitor ? "transcript + thumb" : "thumb only"} accent="green" />
              )}
              <Row
                label="Script"
                value={
                  competitorUrl.trim() && rewriteCompetitor
                    ? "competitor 20% rewrite"
                    : customScript.trim().split(/\s+/).filter(Boolean).length >= 50
                    ? "custom"
                    : "Claude"
                }
              />
              <Row label="Coût estimé" value={pilotMode ? "~$0.5 (pilot)" : "~$11"} accent="green" />
            </div>

            <Toggle
              label={`Mode pilot (${pilotSampleSize} scènes)`}
              description="Génère quelques clips échantillonnés (répartis sur tout le script) pour valider le visuel avant le full run. Pas de voix off ni montage. Idéal pour tester un perso FlowMax + l'animation Seedance à moindre coût."
              checked={pilotMode}
              onChange={setPilotMode}
            />

            {pilotMode && (
              <div className="flex items-center gap-2 mt-2">
                <span className="mono-sm" style={{ color: "var(--text-secondary)" }}>Échantillon :</span>
                {[3, 5, 8].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPilotSampleSize(n)}
                    className="px-3 py-1.5 text-[13px] font-semibold transition-all"
                    style={{
                      background: pilotSampleSize === n ? "var(--accent)" : "var(--bg-glass)",
                      color: pilotSampleSize === n ? "white" : "var(--text-secondary)",
                      border: `1.5px solid ${pilotSampleSize === n ? "var(--accent)" : "var(--border-glass)"}`,
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    {n} scènes
                  </button>
                ))}
              </div>
            )}

            <button
              onClick={launch}
              disabled={!canLaunch}
              className="btn-primary w-full justify-center"
              style={{ padding: "11px 18px", opacity: canLaunch ? 1 : 0.5 }}
            >
              {launching ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Lancement…
                </>
              ) : (
                <>
                  <Rocket size={14} />
                  {pilotMode ? `Lancer le pilot (${pilotSampleSize} scènes)` : "Lancer la génération"}
                </>
              )}
            </button>
            <button
              onClick={enqueue}
              disabled={!canLaunch}
              className="w-full justify-center flex items-center gap-2 text-[13px] font-medium transition-all"
              style={{
                padding: "9px 18px",
                background: "var(--bg-glass)",
                border: "1px solid var(--border-glass)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-secondary)",
                opacity: canLaunch ? 1 : 0.5,
              }}
              title="Ajoute ce job à la file d'attente — le worker /queue les enchaîne 1 à 1."
            >
              {queuing ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Ajout…
                </>
              ) : (
                <>
                  <Clock size={13} />
                  Ajouter à la queue
                </>
              )}
            </button>
            {queueNotice && (
              <div className="mono-sm text-center" style={{ color: "var(--green)" }}>
                {queueNotice} · <a href="/queue" className="underline" style={{ color: "var(--green)" }}>voir la queue →</a>
              </div>
            )}
            {!canLaunch && !launching && !queuing && (
              <div className="mono-sm text-center" style={{ color: "var(--text-tertiary)" }}>
                {title.trim().length < 3 ? "Titre requis (3+ caractères)" : ""}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Active job tracker */}
      {activeJobId && (
        <JobTracker
          jobId={activeJobId}
          onClose={() => setActiveJobId(null)}
          onRelaunch={(newId) => {
            setActiveJobId(newId);
            requestAnimationFrame(() => {
              formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          }}
        />
      )}

      {/* Generated videos */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="heading-lg">Vidéos déjà générées</h2>
          <span className="mono-sm">{videos.length} vidéo{videos.length !== 1 ? "s" : ""}</span>
        </div>
        {videos.length === 0 ? (
          <div className="glass-static py-12 text-center mono-sm">
            Aucune vidéo générée pour l&apos;instant
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {videos.map((v) => (
              <a
                key={v.id}
                href={v.videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="glass-static flex items-center gap-4 px-4 py-3"
                style={{ borderRadius: "var(--radius-sm)" }}
              >
                <CheckCircle2 size={16} style={{ color: "var(--green)" }} />
                <Film size={14} style={{ color: "var(--text-tertiary)" }} />
                <span className="text-[13px] font-medium flex-1 truncate">{v.id}</span>
                <span className="mono-sm">{(v.fileSize / 1024 / 1024).toFixed(1)} Mo</span>
                <div className="flex items-center gap-1 mono-sm">
                  <Clock size={11} />
                  <span>{new Date(v.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-glass-hover)",
  border: "1px solid var(--border-glass)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
};

function Section({ icon: Icon, title, subtitle, children }: { icon: typeof Film; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="glass-static p-5">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0" style={{ background: "var(--accent-bg)", color: "var(--accent)" }}>
          <Icon size={15} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="heading-md text-[14px]">{title}</h3>
          {subtitle && <div className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{subtitle}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label className="mono-sm">{label}</label>
        {hint && <span className="mono-sm">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: "green" }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: "var(--text-tertiary)" }}>{label}</span>
      <span className="font-medium" style={{ color: accent === "green" ? "var(--green)" : "var(--text-primary)" }}>
        {value}
      </span>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-start gap-3 p-3 text-left transition-all w-full"
      style={{
        background: checked ? "var(--accent-bg)" : "var(--bg-glass)",
        border: `1.5px solid ${checked ? "var(--accent)" : "var(--border-glass)"}`,
        borderRadius: "var(--radius-sm)",
      }}
      role="switch"
      aria-checked={checked}
    >
      <div
        className="flex-shrink-0 w-9 h-5 rounded-full transition-all relative"
        style={{
          background: checked ? "var(--accent)" : "var(--bg-glass-hover)",
          border: `1px solid ${checked ? "var(--accent)" : "var(--border-glass)"}`,
        }}
      >
        <div
          className="absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all"
          style={{
            left: checked ? "calc(100% - 18px)" : "2px",
            background: checked ? "white" : "var(--text-secondary)",
          }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold">{label}</div>
        {description && (
          <div className="text-[11px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
            {description}
          </div>
        )}
      </div>
    </button>
  );
}
