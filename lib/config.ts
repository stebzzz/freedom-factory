import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

export interface AppSettings {
  // API Keys
  anthropicKey: string;
  claudeWrapperToken: string;
  claudeWrapperUrl: string;
  siliconflowKey: string;
  genaiproKey: string;
  geminigenKey: string;
  dashscopeKey: string;
  elevenlabsKey: string;
  elevenlabsVoiceId: string;
  mubertKey: string;
  sunoKey: string;
  pexelsKey: string;
  pixabayKey: string;
  unsplashKey: string;

  // Model choices
  voiceModel: "fishspeech" | "elevenlabs" | "genaipro";
  scriptModel: "claude-sonnet-4-6" | "claude-opus-4-6";
  musicService: "mubert" | "suno" | "none";
}

const SETTINGS_PATH = path.join(process.cwd(), "config", "settings.json");

const DEFAULTS: AppSettings = {
  anthropicKey: "",
  claudeWrapperToken: "",
  claudeWrapperUrl: "http://168.231.81.106:3000/api/claude",
  siliconflowKey: "",
  genaiproKey: "",
  geminigenKey: "",
  dashscopeKey: "",
  elevenlabsKey: "",
  elevenlabsVoiceId: "",
  mubertKey: "",
  sunoKey: "",
  pexelsKey: "",
  pixabayKey: "",
  unsplashKey: "",
  voiceModel: "genaipro",
  scriptModel: "claude-sonnet-4-6",
  musicService: "none",
};

// No persistent cache — re-read file on each call so settings changes take effect immediately
export async function getConfig(): Promise<AppSettings> {
  let loaded: AppSettings;
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    loaded = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    loaded = { ...DEFAULTS };
  }

  // .env.local always wins over settings.json (hot-reload friendly)
  const env = process.env;
  loaded.anthropicKey   = env.ANTHROPIC_API_KEY   || loaded.anthropicKey   || "";
  loaded.claudeWrapperToken = env.CLAUDE_WRAPPER_TOKEN || loaded.claudeWrapperToken || "";
  loaded.claudeWrapperUrl = env.CLAUDE_WRAPPER_URL || loaded.claudeWrapperUrl || DEFAULTS.claudeWrapperUrl;
  loaded.siliconflowKey = env.SILICONFLOW_API_KEY || loaded.siliconflowKey || "";
  loaded.genaiproKey    = env.GENAIPRO_API_KEY    || loaded.genaiproKey    || "";
  loaded.geminigenKey   = env.GEMINIGEN_API_KEY   || loaded.geminigenKey   || "";
  loaded.dashscopeKey   = env.DASHSCOPE_API_KEY   || loaded.dashscopeKey   || "";
  loaded.elevenlabsKey  = env.ELEVENLABS_API_KEY  || loaded.elevenlabsKey  || "";
  loaded.elevenlabsVoiceId = env.ELEVENLABS_VOICE_ID || loaded.elevenlabsVoiceId || "";
  loaded.mubertKey      = env.MUBERT_API_KEY      || loaded.mubertKey      || "";
  loaded.sunoKey        = env.SUNO_API_KEY        || loaded.sunoKey        || "";
  loaded.pexelsKey      = env.PEXELS_API_KEY      || loaded.pexelsKey      || "";
  loaded.pixabayKey     = env.PIXABAY_API_KEY     || loaded.pixabayKey     || "";
  loaded.unsplashKey    = env.UNSPLASH_API_KEY    || loaded.unsplashKey    || "";

  return loaded;
}

export async function saveConfig(updates: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getConfig();
  const next = { ...current, ...updates };

  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));

  return next;
}

// Mask a key for display (show last 4 chars)
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return `••••••••${key.slice(-4)}`;
}
