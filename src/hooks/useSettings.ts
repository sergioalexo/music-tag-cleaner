import { useEffect, useRef, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { Settings } from "../types";
import { DEFAULT_REPLACEMENTS } from "../lib/standardize";
import { DEFAULT_GENRE_PRESETS } from "../lib/genres";

const CURRENT_SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: Settings = {
  aiBackend: "ollama",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "",
  batchSize: 50,
  backupBeforeChanges: true,
  stripToCommon: true,
  preserveCoverArt: true,
  recursive: true,
  searchableBackup: true,
  backupField: "Composer",
  lastFolder: "",
  theme: "dark",
  visibleColumns: [
    "preview",
    "filename",
    "title",
    "artist",
    "album",
    "year",
    "genre",
    "rating",
    "trackNumber",
  ],
  columnWidths: {},
  rowHeight: "normal",
  replacements: DEFAULT_REPLACEMENTS,
  capitalization: "asis",
  highlightSymbols: false,
  removeChars: ",.",
  genrePresets: DEFAULT_GENRE_PRESETS,
  activeGenrePreset: "Sergio Alexo",
  nextTrackId: 0,
  clearFields: ["album"],
  settingsVersion: CURRENT_SETTINGS_VERSION,
};

const STORE_FILE = "settings.json";

/**
 * Brings older saved settings up to date. v2 ensures the Preview and Rating
 * columns (added after some users' settings were first saved) are visible.
 */
function migrate(s: Settings, savedVersion: number): Settings {
  const next = { ...s };
  if (savedVersion < 2) {
    const cols = [...next.visibleColumns];
    if (!cols.includes("preview")) cols.unshift("preview");
    if (!cols.includes("rating")) {
      const gi = cols.indexOf("genre");
      if (gi >= 0) cols.splice(gi + 1, 0, "rating");
      else cols.push("rating");
    }
    next.visibleColumns = cols;
  }
  next.settingsVersion = CURRENT_SETTINGS_VERSION;
  return next;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const storeRef = useRef<Store | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const store = await load(STORE_FILE);
        storeRef.current = store;
        const saved = await store.get<Partial<Settings>>("settings");
        if (saved) {
          const merged = { ...DEFAULT_SETTINGS, ...saved };
          const savedVersion = saved.settingsVersion ?? 1;
          const next =
            savedVersion < CURRENT_SETTINGS_VERSION ? migrate(merged, savedVersion) : merged;
          setSettings(next);
          if (savedVersion < CURRENT_SETTINGS_VERSION) {
            await store.set("settings", next);
            await store.save();
          }
        }
      } catch (e) {
        console.error("Failed to load settings:", e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const save = async (next: Settings) => {
    setSettings(next);
    try {
      const store = storeRef.current ?? (storeRef.current = await load(STORE_FILE));
      await store.set("settings", next);
      await store.save();
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  };

  return { settings, save, loaded };
}
