"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Plus,
  Save,
  Trash2,
  Copy,
  Lock,
  Loader2,
  Check,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  Pencil,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types (mirror ChannelPreset from lib)
// ---------------------------------------------------------------------------
interface ChannelPreset {
  id: string;
  label: string;
  emoji: string;
  description: string;
  language: "fr" | "en";
  script: {
    wordsPerMinute: number;
    scenesPerMinute: number;
    sceneDurationRange: [number, number];
    structure: "one-sentence" | "prose" | "numbered-list" | "dramatic-arc";
    claudeStylePrompt: string;
    maxScenesPerChunk: number;
  };
  visual: {
    imageStyleSuffix: string;
    kenBurnsSpeed: number;
    transitionType: "crossfade" | "hard-cut" | "dip-to-black";
    transitionDuration: number;
    brollEnabled: boolean;
  };
  audio: {
    voiceSpeed: number;
    musicGenre: string;
    musicVolume: number;
  };
  subtitles: {
    style: "word-highlight" | "static" | "none";
    fontSize: number;
    position: "bottom" | "center-bottom";
  };
  durationRange: {
    min: number;
    max: number;
    default: number;
  };
  _builtin?: boolean;
}

// ---------------------------------------------------------------------------
// Blank preset template
// ---------------------------------------------------------------------------
function blankPreset(): ChannelPreset {
  return {
    id: "",
    label: "",
    emoji: "🎯",
    description: "",
    language: "fr",
    script: {
      wordsPerMinute: 150,
      scenesPerMinute: 6,
      sceneDurationRange: [7, 15],
      structure: "one-sentence",
      claudeStylePrompt: "",
      maxScenesPerChunk: 40,
    },
    visual: {
      imageStyleSuffix: "",
      kenBurnsSpeed: 0.12,
      transitionType: "crossfade",
      transitionDuration: 0.8,
      brollEnabled: true,
    },
    audio: {
      voiceSpeed: 1.0,
      musicGenre: "",
      musicVolume: 0.15,
    },
    subtitles: {
      style: "word-highlight",
      fontSize: 56,
      position: "center-bottom",
    },
    durationRange: {
      min: 5,
      max: 60,
      default: 15,
    },
  };
}

// ---------------------------------------------------------------------------
// Slug-ify a label into an id
// ---------------------------------------------------------------------------
function slugify(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------
export default function PresetsPage() {
  const [presets, setPresets] = useState<ChannelPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ChannelPreset | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchPresets = useCallback(async () => {
    try {
      const res = await fetch("/api/presets");
      const data = await res.json();
      setPresets(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPresets();
  }, [fetchPresets]);

  // ----- handlers -----

  const handleNew = () => {
    setEditing(blankPreset());
    setIsNew(true);
    setSaved(false);
  };

  const handleDuplicate = (preset: ChannelPreset) => {
    const copy = JSON.parse(JSON.stringify(preset)) as ChannelPreset;
    copy.id = slugify(copy.label) + "-copy";
    copy.label = copy.label + " (copie)";
    delete (copy as unknown as Record<string, unknown>)._builtin;
    setEditing(copy);
    setIsNew(true);
    setSaved(false);
  };

  const handleEdit = (preset: ChannelPreset) => {
    if (preset._builtin) return;
    setEditing(JSON.parse(JSON.stringify(preset)));
    setIsNew(false);
    setSaved(false);
  };

  const handleSave = async () => {
    if (!editing) return;

    // Auto-generate id from label if empty
    if (!editing.id && editing.label) {
      editing.id = slugify(editing.label);
    }

    if (!editing.id || !editing.label) return;

    setSaving(true);
    try {
      const body = { ...editing };
      delete (body as unknown as Record<string, unknown>)._builtin;

      const res = await fetch("/api/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaved(true);
        setIsNew(false);
        await fetchPresets();
        setTimeout(() => setSaved(false), 3000);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editing || editing._builtin) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/presets?id=${encodeURIComponent(editing.id)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setEditing(null);
        await fetchPresets();
      }
    } finally {
      setDeleting(false);
    }
  };

  const handleBack = () => {
    setEditing(null);
    setIsNew(false);
    setSaved(false);
  };

  // ----- render -----

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={20} className="animate-spin" style={{ color: "var(--text-tertiary)" }} />
      </div>
    );
  }

  // If editing a preset, show the editor
  if (editing) {
    return (
      <PresetEditor
        preset={editing}
        onChange={setEditing}
        isNew={isNew}
        saving={saving}
        saved={saved}
        deleting={deleting}
        onSave={handleSave}
        onDelete={handleDelete}
        onBack={handleBack}
      />
    );
  }

  // Otherwise show the list
  const builtinPresets = presets.filter((p) => p._builtin);
  const customPresets = presets.filter((p) => !p._builtin);

  return (
    <div className="flex flex-col gap-10 max-w-[720px]">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <span className="mono-sm">Workspace / Presets</span>
        <div className="flex items-center justify-between mt-2">
          <h1 className="heading-xl">Presets</h1>
          <button onClick={handleNew} className="btn-primary">
            <Plus size={14} /> Nouveau preset
          </button>
        </div>
        <p className="text-[15px] mt-1" style={{ color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Gerez vos presets de chaine. Les presets integres sont verrouilles, mais vous pouvez les dupliquer.
        </p>
      </div>

      {/* Built-in */}
      <section>
        <h2 className="heading-lg mb-4">Presets integres</h2>
        <div className="flex flex-col gap-2">
          {builtinPresets.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              onDuplicate={() => handleDuplicate(preset)}
            />
          ))}
        </div>
      </section>

      {/* Custom */}
      <section>
        <h2 className="heading-lg mb-4">Presets personnalises</h2>
        {customPresets.length === 0 ? (
          <div
            className="glass-static rounded-xl p-8 flex flex-col items-center gap-3"
          >
            <span className="text-[32px]">🎨</span>
            <p className="text-[14px]" style={{ color: "var(--text-tertiary)" }}>
              Aucun preset personnalise. Creez-en un ou dupliquez un preset integre.
            </p>
            <button onClick={handleNew} className="btn-glass mt-1">
              <Plus size={14} /> Creer un preset
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {customPresets.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                onEdit={() => handleEdit(preset)}
                onDuplicate={() => handleDuplicate(preset)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset card in the list
// ---------------------------------------------------------------------------
function PresetCard({
  preset,
  onEdit,
  onDuplicate,
}: {
  preset: ChannelPreset;
  onEdit?: () => void;
  onDuplicate: () => void;
}) {
  const isBuiltin = !!preset._builtin;

  return (
    <div
      className="glass-static rounded-xl p-4 flex items-start gap-3 transition-all"
      style={{ cursor: isBuiltin ? "default" : "pointer" }}
      onClick={onEdit}
    >
      <span className="text-2xl flex-shrink-0">{preset.emoji}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold" style={{ color: "var(--text-primary)" }}>
            {preset.label}
          </span>
          {isBuiltin && (
            <span className="badge badge-gray" style={{ fontSize: 10, padding: "2px 8px" }}>
              <Lock size={10} /> integre
            </span>
          )}
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: "var(--bg-glass-hover)", color: "var(--text-tertiary)" }}
          >
            {preset.language.toUpperCase()}
          </span>
        </div>
        <p className="text-[12px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>
          {preset.description || "Pas de description"}
        </p>
        <div className="flex gap-2 mt-1.5 flex-wrap">
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: "var(--bg-glass-hover)", color: "var(--text-tertiary)" }}
          >
            {preset.script.structure}
          </span>
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: "var(--bg-glass-hover)", color: "var(--text-tertiary)" }}
          >
            {preset.script.scenesPerMinute} scenes/min
          </span>
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: "var(--bg-glass-hover)", color: "var(--text-tertiary)" }}
          >
            {preset.durationRange.min}-{preset.durationRange.max}min
          </span>
        </div>
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        {!isBuiltin && onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="btn-glass"
            style={{ padding: "6px 10px" }}
            title="Modifier"
          >
            <Pencil size={13} />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
          className="btn-glass"
          style={{ padding: "6px 10px" }}
          title="Dupliquer"
        >
          <Copy size={13} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset Editor
// ---------------------------------------------------------------------------
function PresetEditor({
  preset,
  onChange,
  isNew,
  saving,
  saved,
  deleting,
  onSave,
  onDelete,
  onBack,
}: {
  preset: ChannelPreset;
  onChange: (p: ChannelPreset) => void;
  isNew: boolean;
  saving: boolean;
  saved: boolean;
  deleting: boolean;
  onSave: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    general: true,
    script: true,
    visual: true,
    audio: true,
    subtitles: true,
    duration: true,
  });

  const toggleSection = (key: string) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Helpers to update nested fields
  const set = (path: string, value: unknown) => {
    const updated = JSON.parse(JSON.stringify(preset)) as Record<string, unknown>;
    const keys = path.split(".");
    let obj = updated as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) {
      obj = obj[keys[i]] as Record<string, unknown>;
    }
    obj[keys[keys.length - 1]] = value;
    onChange(updated as unknown as ChannelPreset);
  };

  const canSave = preset.label.trim().length > 0;

  return (
    <div className="flex flex-col gap-8 max-w-[720px]">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <button onClick={onBack} className="btn-glass self-start mb-2" style={{ padding: "5px 12px" }}>
          <ArrowLeft size={14} /> Retour aux presets
        </button>
        <span className="mono-sm">
          {isNew ? "Nouveau preset" : `Modifier / ${preset.label}`}
        </span>
        <h1 className="heading-xl mt-2">
          {preset.emoji} {preset.label || "Nouveau preset"}
        </h1>
      </div>

      {/* ============================================================ */}
      {/* SECTION: General */}
      {/* ============================================================ */}
      <EditorSection title="General" sectionKey="general" open={openSections.general} onToggle={toggleSection}>
        <div className="grid grid-cols-2 gap-4">
          <FieldText
            label="ID (slug)"
            value={preset.id}
            onChange={(v) => set("id", v)}
            placeholder="ex: mon-preset"
            helpText={isNew ? "Genere automatiquement si vide" : "Non modifiable apres creation"}
            disabled={!isNew}
          />
          <FieldText
            label="Label"
            value={preset.label}
            onChange={(v) => set("label", v)}
            placeholder="Ex: Mon preset custom"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FieldText
            label="Emoji"
            value={preset.emoji}
            onChange={(v) => set("emoji", v)}
            placeholder="🎯"
          />
          <FieldSelect
            label="Langue"
            value={preset.language}
            onChange={(v) => set("language", v)}
            options={[
              { value: "fr", label: "Francais" },
              { value: "en", label: "English" },
            ]}
          />
        </div>
        <FieldTextarea
          label="Description"
          value={preset.description}
          onChange={(v) => set("description", v)}
          placeholder="Decrivez le style et l'usage de ce preset..."
          rows={2}
        />
      </EditorSection>

      {/* ============================================================ */}
      {/* SECTION: Script */}
      {/* ============================================================ */}
      <EditorSection title="Script" sectionKey="script" open={openSections.script} onToggle={toggleSection}>
        <div className="grid grid-cols-3 gap-4">
          <FieldNumber
            label="Mots / minute"
            value={preset.script.wordsPerMinute}
            onChange={(v) => set("script.wordsPerMinute", v)}
            min={60}
            max={300}
          />
          <FieldNumber
            label="Scenes / minute"
            value={preset.script.scenesPerMinute}
            onChange={(v) => set("script.scenesPerMinute", v)}
            min={1}
            max={20}
          />
          <FieldNumber
            label="Max scenes / chunk"
            value={preset.script.maxScenesPerChunk}
            onChange={(v) => set("script.maxScenesPerChunk", v)}
            min={5}
            max={100}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FieldNumber
            label="Duree scene min (s)"
            value={preset.script.sceneDurationRange[0]}
            onChange={(v) => set("script.sceneDurationRange", [v, preset.script.sceneDurationRange[1]])}
            min={1}
            max={60}
          />
          <FieldNumber
            label="Duree scene max (s)"
            value={preset.script.sceneDurationRange[1]}
            onChange={(v) => set("script.sceneDurationRange", [preset.script.sceneDurationRange[0], v])}
            min={1}
            max={120}
          />
        </div>
        <FieldSelect
          label="Structure"
          value={preset.script.structure}
          onChange={(v) => set("script.structure", v)}
          options={[
            { value: "one-sentence", label: "Une phrase / scene" },
            { value: "prose", label: "Prose longue" },
            { value: "numbered-list", label: "Liste numerotee (Top X)" },
            { value: "dramatic-arc", label: "Arc dramatique" },
          ]}
        />
        <FieldTextarea
          label="Claude Style Prompt"
          value={preset.script.claudeStylePrompt}
          onChange={(v) => set("script.claudeStylePrompt", v)}
          placeholder="Instructions de style injectees dans le prompt Claude..."
          rows={6}
        />
      </EditorSection>

      {/* ============================================================ */}
      {/* SECTION: Visual */}
      {/* ============================================================ */}
      <EditorSection title="Visuel" sectionKey="visual" open={openSections.visual} onToggle={toggleSection}>
        <FieldTextarea
          label="Image Style Suffix"
          value={preset.visual.imageStyleSuffix}
          onChange={(v) => set("visual.imageStyleSuffix", v)}
          placeholder="Suffixe ajoute a chaque prompt image..."
          rows={3}
        />
        <FieldSlider
          label="Ken Burns Speed"
          value={preset.visual.kenBurnsSpeed}
          onChange={(v) => set("visual.kenBurnsSpeed", v)}
          min={0.02}
          max={0.25}
          step={0.01}
          displayValue={preset.visual.kenBurnsSpeed.toFixed(2)}
        />
        <div className="grid grid-cols-2 gap-4">
          <FieldSelect
            label="Type de transition"
            value={preset.visual.transitionType}
            onChange={(v) => set("visual.transitionType", v)}
            options={[
              { value: "crossfade", label: "Crossfade" },
              { value: "hard-cut", label: "Hard cut" },
              { value: "dip-to-black", label: "Fondu au noir" },
            ]}
          />
          <FieldNumber
            label="Duree transition (s)"
            value={preset.visual.transitionDuration}
            onChange={(v) => set("visual.transitionDuration", v)}
            min={0}
            max={5}
            step={0.1}
          />
        </div>
        <FieldToggle
          label="B-Roll active"
          value={preset.visual.brollEnabled}
          onChange={(v) => set("visual.brollEnabled", v)}
        />
      </EditorSection>

      {/* ============================================================ */}
      {/* SECTION: Audio */}
      {/* ============================================================ */}
      <EditorSection title="Audio" sectionKey="audio" open={openSections.audio} onToggle={toggleSection}>
        <FieldSlider
          label="Vitesse voix"
          value={preset.audio.voiceSpeed}
          onChange={(v) => set("audio.voiceSpeed", v)}
          min={0.7}
          max={1.3}
          step={0.05}
          displayValue={preset.audio.voiceSpeed.toFixed(2) + "x"}
        />
        <FieldText
          label="Genre musical"
          value={preset.audio.musicGenre}
          onChange={(v) => set("audio.musicGenre", v)}
          placeholder="Ex: ambient drone, soft piano"
        />
        <FieldSlider
          label="Volume musique"
          value={preset.audio.musicVolume}
          onChange={(v) => set("audio.musicVolume", v)}
          min={0}
          max={1}
          step={0.01}
          displayValue={Math.round(preset.audio.musicVolume * 100) + "%"}
        />
      </EditorSection>

      {/* ============================================================ */}
      {/* SECTION: Subtitles */}
      {/* ============================================================ */}
      <EditorSection title="Sous-titres" sectionKey="subtitles" open={openSections.subtitles} onToggle={toggleSection}>
        <FieldSelect
          label="Style"
          value={preset.subtitles.style}
          onChange={(v) => set("subtitles.style", v)}
          options={[
            { value: "word-highlight", label: "Mot surligne" },
            { value: "static", label: "Statique" },
            { value: "none", label: "Desactive" },
          ]}
        />
        <div className="grid grid-cols-2 gap-4">
          <FieldNumber
            label="Taille police (px)"
            value={preset.subtitles.fontSize}
            onChange={(v) => set("subtitles.fontSize", v)}
            min={16}
            max={128}
          />
          <FieldSelect
            label="Position"
            value={preset.subtitles.position}
            onChange={(v) => set("subtitles.position", v)}
            options={[
              { value: "bottom", label: "Bas" },
              { value: "center-bottom", label: "Centre-bas" },
            ]}
          />
        </div>
      </EditorSection>

      {/* ============================================================ */}
      {/* SECTION: Duration */}
      {/* ============================================================ */}
      <EditorSection title="Duree" sectionKey="duration" open={openSections.duration} onToggle={toggleSection}>
        <div className="grid grid-cols-3 gap-4">
          <FieldNumber
            label="Min (minutes)"
            value={preset.durationRange.min}
            onChange={(v) => set("durationRange.min", v)}
            min={1}
            max={300}
          />
          <FieldNumber
            label="Max (minutes)"
            value={preset.durationRange.max}
            onChange={(v) => set("durationRange.max", v)}
            min={1}
            max={300}
          />
          <FieldNumber
            label="Defaut (minutes)"
            value={preset.durationRange.default}
            onChange={(v) => set("durationRange.default", v)}
            min={1}
            max={300}
          />
        </div>
      </EditorSection>

      {/* ============================================================ */}
      {/* Actions */}
      {/* ============================================================ */}
      <div className="flex items-center gap-3 pb-10">
        <button
          onClick={onSave}
          disabled={saving || !canSave}
          className="btn-primary"
          style={{ opacity: saving || !canSave ? 0.5 : 1 }}
        >
          {saving ? (
            <><Loader2 size={14} className="animate-spin" /> Sauvegarde...</>
          ) : saved ? (
            <><Check size={14} /> Sauvegarde</>
          ) : (
            <><Save size={14} /> Sauvegarder</>
          )}
        </button>

        {!isNew && !preset._builtin && (
          <button
            onClick={onDelete}
            disabled={deleting}
            className="btn-glass"
            style={{
              color: "var(--red)",
              borderColor: "rgba(214, 48, 49, 0.2)",
              opacity: deleting ? 0.5 : 1,
            }}
          >
            {deleting ? (
              <><Loader2 size={14} className="animate-spin" /> Suppression...</>
            ) : (
              <><Trash2 size={14} /> Supprimer</>
            )}
          </button>
        )}

        {saved && (
          <span className="text-[13px]" style={{ color: "var(--green)" }}>
            Preset sauvegarde
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper (collapsible)
// ---------------------------------------------------------------------------
function EditorSection({
  title,
  sectionKey,
  open,
  onToggle,
  children,
}: {
  title: string;
  sectionKey: string;
  open: boolean;
  onToggle: (key: string) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="glass-static rounded-xl overflow-hidden">
      <button
        onClick={() => onToggle(sectionKey)}
        className="w-full flex items-center justify-between px-5 py-4 text-left transition-all"
        style={{
          borderBottom: open ? "1px solid var(--border-glass)" : "none",
        }}
      >
        <h2 className="heading-md">{title}</h2>
        {open ? (
          <ChevronDown size={16} style={{ color: "var(--text-tertiary)" }} />
        ) : (
          <ChevronRight size={16} style={{ color: "var(--text-tertiary)" }} />
        )}
      </button>
      {open && (
        <div className="p-5 flex flex-col gap-4">
          {children}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Field components
// ---------------------------------------------------------------------------

function FieldText({
  label,
  value,
  onChange,
  placeholder,
  helpText,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  helpText?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="mono-sm block mb-1.5">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-lg px-3 py-2 text-[13px] outline-none transition-all"
        style={{
          background: "var(--bg-glass)",
          border: "1px solid var(--border-glass)",
          color: disabled ? "var(--text-tertiary)" : "var(--text-primary)",
          opacity: disabled ? 0.6 : 1,
        }}
        onFocus={(e) => (e.target.style.borderColor = "var(--accent)")}
        onBlur={(e) => (e.target.style.borderColor = "var(--border-glass)")}
      />
      {helpText && (
        <p className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>
          {helpText}
        </p>
      )}
    </div>
  );
}

function FieldTextarea({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div>
      <label className="mono-sm block mb-1.5">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full rounded-lg px-3 py-2 text-[13px] outline-none transition-all resize-y font-mono"
        style={{
          background: "var(--bg-glass)",
          border: "1px solid var(--border-glass)",
          color: "var(--text-primary)",
          lineHeight: 1.6,
        }}
        onFocus={(e) => (e.target.style.borderColor = "var(--accent)")}
        onBlur={(e) => (e.target.style.borderColor = "var(--border-glass)")}
      />
    </div>
  );
}

function FieldNumber({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div>
      <label className="mono-sm block mb-1.5">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        min={min}
        max={max}
        step={step}
        className="w-full rounded-lg px-3 py-2 text-[13px] outline-none transition-all"
        style={{
          background: "var(--bg-glass)",
          border: "1px solid var(--border-glass)",
          color: "var(--text-primary)",
        }}
        onFocus={(e) => (e.target.style.borderColor = "var(--accent)")}
        onBlur={(e) => (e.target.style.borderColor = "var(--border-glass)")}
      />
    </div>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div>
      <label className="mono-sm block mb-1.5">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg px-3 py-2 text-[13px] outline-none transition-all cursor-pointer"
        style={{
          background: "var(--bg-glass)",
          border: "1px solid var(--border-glass)",
          color: "var(--text-primary)",
          WebkitAppearance: "none",
          appearance: "none",
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 10px center",
          paddingRight: "30px",
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function FieldSlider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  displayValue,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  displayValue: string;
}) {
  const percent = ((value - min) / (max - min)) * 100;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="mono-sm">{label}</label>
        <span
          className="text-[13px] font-semibold font-mono"
          style={{ color: "var(--accent)" }}
        >
          {displayValue}
        </span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full h-2 rounded-full outline-none cursor-pointer"
          style={{
            WebkitAppearance: "none",
            appearance: "none",
            background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${percent}%, var(--bg-glass-hover) ${percent}%, var(--bg-glass-hover) 100%)`,
          }}
        />
      </div>
    </div>
  );
}

function FieldToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <label className="mono-sm">{label}</label>
      <button
        onClick={() => onChange(!value)}
        className="relative transition-all"
        style={{
          width: 44,
          height: 24,
          borderRadius: 100,
          background: value ? "var(--accent)" : "var(--bg-glass-hover)",
          border: `1px solid ${value ? "var(--accent)" : "var(--border-glass)"}`,
        }}
      >
        <div
          className="absolute top-[2px] rounded-full transition-all"
          style={{
            width: 18,
            height: 18,
            background: "white",
            left: value ? 22 : 2,
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }}
        />
      </button>
    </div>
  );
}
