import { useEffect, useRef, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "analytics.json";

export interface ActionCounts {
  [action: string]: number;
}

/**
 * Local-only counter of which app actions get used and how often — no
 * network calls, nothing leaves the machine. Purely groundwork for the user
 * to later look at "what do I actually click" from the Logs page.
 */
export function useAnalytics() {
  const [counts, setCounts] = useState<ActionCounts>({});
  const storeRef = useRef<Store | null>(null);
  const countsRef = useRef(counts);
  countsRef.current = counts;

  useEffect(() => {
    (async () => {
      try {
        const store = await load(STORE_FILE);
        storeRef.current = store;
        const saved = await store.get<ActionCounts>("counts");
        if (saved) setCounts(saved);
      } catch (e) {
        console.error("Failed to load analytics:", e);
      }
    })();
  }, []);

  const persist = (next: ActionCounts) => {
    (async () => {
      try {
        const store = storeRef.current ?? (storeRef.current = await load(STORE_FILE));
        await store.set("counts", next);
        await store.save();
      } catch (e) {
        console.error("Failed to save analytics:", e);
      }
    })();
  };

  /** Increments the counter for `action` (e.g. "cleanTags", "sortColumn:artist"). */
  const track = (action: string) => {
    const next = { ...countsRef.current, [action]: (countsRef.current[action] ?? 0) + 1 };
    setCounts(next);
    persist(next);
  };

  const reset = () => {
    setCounts({});
    persist({});
  };

  return { counts, track, reset };
}
