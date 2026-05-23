"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, Save, Loader2 } from "lucide-react";

interface Settings {
  anthropicKey: string;
  siliconflowKey: string;
  genaiproKey: string;
  elevenlabsKey: string;
  elevenlabsVoiceId: string;
  mubertKey: string;
  sunoKey: string;
  pexelsKey: string;
  pixabayKey: string;
  unsplashKey: string;
  voiceModel: string;
  scriptModel: string;
  musicService: string;
}

const MODEL_OPTIONS = {
  voiceModel: [
    { value: "genaipro", label: "GenAIPro Labs", sub: "ElevenLabs via genaipro.io · Defaut" },
    { value: "elevenlabs", label: "ElevenLabs (direct)", sub: "Multilingual v2 · Cle ElevenLabs requise" },
    { value: "fishspeech", label: "Fish Speech 1.5", sub: "SiliconFlow · FR/EN · Naturel" },
  ],
  scriptModel: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", sub: "Rapide · Recommande" },
    { value: "claude-opus-4-6", label: "Claude Opus 4.6", sub: "Max qualite · Plus lent" },
  ],
  musicService: [
    { value: "none", label: "Desactive", sub: "Pas de musique de fond" },
    { value: "mubert", label: "Mubert", sub: "Necessite MUBERT_KEY" },
    { value: "suno", label: "Suno", sub: "API publique a venir" },
  ],
};

const KEY_FIELDS: Array<{ key: keyof Settings; label: string; placeholder: string; service: string }> = [
  { key: "anthropicKey",    label: "Anthropic API Key",      placeholder: "sk-ant-api...",        service: "claude.ai · Script" },
  { key: "genaiproKey",     label: "GenAIPro API Key",       placeholder: "eyJ...",                service: "genaipro.io · Images + Veo3 video" },
  { key: "elevenlabsKey",   label: "ElevenLabs API Key",     placeholder: "...",                  service: "elevenlabs.io · Voiceover" },
  { key: "elevenlabsVoiceId", label: "ElevenLabs Voice ID",  placeholder: "pNInz6obpgDQGcFmaJgB",  service: "optionnel · default voice" },
  { key: "siliconflowKey",  label: "SiliconFlow API Key",    placeholder: "sk-...",                service: "siliconflow.cn · Fish Speech (fallback voiceover)" },
  { key: "mubertKey",       label: "Mubert API Key",         placeholder: "...",                   service: "mubert.com · Musique" },
  { key: "sunoKey",         label: "Suno API Key",           placeholder: "API non publique",      service: "suno.com · bientot" },
  { key: "pexelsKey",       label: "Pexels API Key",         placeholder: "...",                   service: "pexels.com/api · Sourcing images + vidéos" },
  { key: "pixabayKey",      label: "Pixabay API Key",        placeholder: "...",                   service: "pixabay.com/api · Sourcing images + vidéos" },
  { key: "unsplashKey",     label: "Unsplash Access Key",    placeholder: "...",                   service: "unsplash.com/oauth · Sourcing photos" },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings(data);
        setLocalValues(data);
      });
  }, []);

  const handleChange = (key: string, value: string) => {
    setLocalValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localValues),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={20} className="animate-spin" style={{ color: "var(--text-tertiary)" }} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10 max-w-[720px]">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <span className="mono-sm">Workspace / Configuration</span>
        <h1 className="heading-xl mt-2">Parametres</h1>
        <p className="text-[15px] mt-1" style={{ color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Cles API et choix des modeles pour chaque etape du pipeline.
        </p>
      </div>

      {/* API Keys */}
      <section>
        <h2 className="heading-lg mb-4">Cles API</h2>
        <div className="flex flex-col gap-3">
          {KEY_FIELDS.map(({ key, label, placeholder, service }) => {
            const isVisible = visible[key];
            const val = localValues[key] ?? "";
            return (
              <div key={key} className="glass-static rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
                    {label}
                  </label>
                  <span className="mono-sm">{service}</span>
                </div>
                <div className="flex gap-2">
                  <input
                    type={isVisible ? "text" : "password"}
                    value={val}
                    onChange={(e) => handleChange(key, e.target.value)}
                    placeholder={placeholder}
                    className="flex-1 rounded-lg px-3 py-2 text-[13px] font-mono outline-none transition-all"
                    style={{
                      background: "var(--bg-glass)",
                      border: "1px solid var(--border-glass)",
                      color: "var(--text-primary)",
                    }}
                    onFocus={(e) => (e.target.style.borderColor = "var(--accent)")}
                    onBlur={(e) => (e.target.style.borderColor = "var(--border-glass)")}
                  />
                  <button
                    onClick={() => setVisible((p) => ({ ...p, [key]: !p[key] }))}
                    className="btn-glass px-3"
                    style={{ flexShrink: 0 }}
                  >
                    {isVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Model Choices */}
      <section>
        <h2 className="heading-lg mb-4">Modeles</h2>
        <div className="flex flex-col gap-6">

          {/* Voiceover */}
          <ModelSection
            label="Voiceover"
            settingKey="voiceModel"
            currentValue={localValues.voiceModel}
            options={MODEL_OPTIONS.voiceModel}
            onChange={(v) => handleChange("voiceModel", v)}
          />

          {/* Script */}
          <ModelSection
            label="Generation de script"
            settingKey="scriptModel"
            currentValue={localValues.scriptModel}
            options={MODEL_OPTIONS.scriptModel}
            onChange={(v) => handleChange("scriptModel", v)}
          />

          {/* Music */}
          <ModelSection
            label="Musique de fond"
            settingKey="musicService"
            currentValue={localValues.musicService}
            options={MODEL_OPTIONS.musicService}
            onChange={(v) => handleChange("musicService", v)}
          />
        </div>
      </section>

      {/* Save */}
      <div className="flex items-center gap-3 pb-10">
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary"
          style={{ opacity: saving ? 0.6 : 1 }}
        >
          {saving ? (
            <><Loader2 size={14} className="animate-spin" /> Sauvegarde...</>
          ) : saved ? (
            <><Check size={14} /> Sauvegarde</>
          ) : (
            <><Save size={14} /> Sauvegarder</>
          )}
        </button>
        {saved && (
          <span className="text-[13px]" style={{ color: "var(--green)" }}>
            Parametres mis a jour
          </span>
        )}
      </div>
    </div>
  );
}

function ModelSection({
  label,
  currentValue,
  options,
  onChange,
}: {
  label: string;
  settingKey: string;
  currentValue: string;
  options: Array<{ value: string; label: string; sub: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mono-sm block mb-2">{label}</label>
      <div className="flex flex-col gap-1.5">
        {options.map((opt) => {
          const isSelected = currentValue === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all"
              style={{
                background: isSelected ? "var(--accent-bg)" : "var(--bg-glass)",
                border: `1.5px solid ${isSelected ? "var(--accent)" : "var(--border-glass)"}`,
              }}
            >
              <div
                className="w-4 h-4 rounded-full flex-shrink-0 transition-all"
                style={{
                  background: isSelected ? "var(--accent)" : "transparent",
                  border: `2px solid ${isSelected ? "var(--accent)" : "var(--text-tertiary)"}`,
                }}
              />
              <div className="flex-1">
                <span className="text-[14px] font-semibold" style={{ color: "var(--text-primary)" }}>
                  {opt.label}
                </span>
                <span className="text-[12px] ml-2" style={{ color: "var(--text-tertiary)" }}>
                  {opt.sub}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
