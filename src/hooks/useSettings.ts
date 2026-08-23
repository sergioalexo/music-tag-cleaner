import { useCallback, useEffect, useRef, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { Settings } from "../types";
import { DEFAULT_REPLACEMENTS } from "../lib/standardize";
import { DEFAULT_GENRE_PRESETS } from "../lib/genres";

export const CURRENT_SETTINGS_VERSION = 3;

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
  trackIdDigits: 6,
  clearFields: ["album"],
  transliterateScripts: [],
  settingsVersion: CURRENT_SETTINGS_VERSION,
  shortcuts: {},
  usage: { totalPromptTokens: 0, totalCompletionTokens: 0, totalCalls: 0, songsProcessed: 0 },
  plan: { tier: "free", creditsTotal: 5000 },
  standardizeFields: ["title", "artist", "album", "albumArtist"],
  standardizeFilename: false,
  manualChunkSize: 50,
};

const STORE_FILE = "settings.json";

/**
 * Brings older saved settings up to date. v2 ensures the Preview and Rating
 * columns (added after some users' settings were first saved) are visible.
 * v3 retires the never-shipped "claude" backend in favour of "manual".
 */
export function migrate(s: Settings, savedVersion: number): Settings {
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
  if (savedVersion < 3 && next.aiBackend !== "ollama" && next.aiBackend !== "manual") {
    next.aiBackend = "ollama";
  }
  next.settingsVersion = CURRENT_SETTINGS_VERSION;
  return next;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const storeRef = useRef<Store | null>(null);
  // Mirrors the newest settings *synchronously*, before React re-renders, so
  // back-to-back writers (e.g. a burst of ai-usage events) each build on the
  // previous value instead of all reading the same stale render snapshot.
  const latestRef = useRef(settings);

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
          latestRef.current = next;
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

  const save = useCallback(async (next: Settings) => {
    latestRef.current = next;
    setSettings(next);
    try {
      const store = storeRef.current ?? (storeRef.current = await load(STORE_FILE));
      await store.set("settings", next);
      await store.save();
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }, []);

  /**
   * Read-modify-write against the newest settings rather than a render
   * snapshot. Use this for anything that accumulates (usage counters), where
   * two events firing between renders would otherwise clobber each other.
   */
  const update = useCallback(
    (fn: (prev: Settings) => Settings) => save(fn(latestRef.current)),
    [save],
  );

  return { settings, save, update, loaded };
}
