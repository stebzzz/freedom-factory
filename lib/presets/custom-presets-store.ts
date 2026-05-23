// ===================================================================
// Custom Presets Store — read/write custom-presets.json
// ===================================================================

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import type { ChannelPreset } from "./channel-presets";
import { ALL_PRESETS } from "./channel-presets";

const CUSTOM_PRESETS_PATH = path.join(process.cwd(), "config", "custom-presets.json");

// Built-in preset IDs (these cannot be overwritten or deleted)
const BUILTIN_IDS = new Set(ALL_PRESETS.map((p) => p.id));

export function isBuiltinPreset(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/**
 * Read all custom presets from disk.
 */
export async function loadCustomPresets(): Promise<ChannelPreset[]> {
  try {
    const raw = await readFile(CUSTOM_PRESETS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ChannelPreset[];
  } catch {
    return [];
  }
}

/**
 * Load all presets: built-in + custom merged.
 * Custom presets appear after built-in ones.
 */
export async function loadAllPresets(): Promise<ChannelPreset[]> {
  const custom = await loadCustomPresets();
  return [...ALL_PRESETS, ...custom];
}

/**
 * Save (create or update) a custom preset.
 * Throws if the ID collides with a built-in preset.
 */
export async function saveCustomPreset(preset: ChannelPreset): Promise<ChannelPreset[]> {
  if (isBuiltinPreset(preset.id)) {
    throw new Error(`Cannot overwrite built-in preset "${preset.id}"`);
  }

  const custom = await loadCustomPresets();
  const idx = custom.findIndex((p) => p.id === preset.id);
  if (idx >= 0) {
    custom[idx] = preset;
  } else {
    custom.push(preset);
  }

  await mkdir(path.dirname(CUSTOM_PRESETS_PATH), { recursive: true });
  await writeFile(CUSTOM_PRESETS_PATH, JSON.stringify(custom, null, 2));

  return custom;
}

/**
 * Delete a custom preset by ID.
 * Throws if it's a built-in preset.
 */
export async function deleteCustomPreset(id: string): Promise<ChannelPreset[]> {
  if (isBuiltinPreset(id)) {
    throw new Error(`Cannot delete built-in preset "${id}"`);
  }

  const custom = await loadCustomPresets();
  const filtered = custom.filter((p) => p.id !== id);

  await mkdir(path.dirname(CUSTOM_PRESETS_PATH), { recursive: true });
  await writeFile(CUSTOM_PRESETS_PATH, JSON.stringify(filtered, null, 2));

  return filtered;
}

/**
 * Get a single preset by ID (searches built-in + custom).
 */
export async function getPresetAsync(id: string): Promise<ChannelPreset | undefined> {
  const all = await loadAllPresets();
  return all.find((p) => p.id === id);
}

/**
 * Get a preset by ID, or fall back to documentary-fr.
 */
export async function getPresetOrDefaultAsync(id?: string): Promise<ChannelPreset> {
  if (!id) return ALL_PRESETS.find((p) => p.id === "documentary-fr") || ALL_PRESETS[0];
  const found = await getPresetAsync(id);
  return found || ALL_PRESETS.find((p) => p.id === "documentary-fr") || ALL_PRESETS[0];
}
