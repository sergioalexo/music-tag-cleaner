import { useState } from "react";
import { Package, Repeat, X } from "lucide-react";

import { CONVERT_PRESETS, type ConvertPreset, type FfmpegInfo, type Settings } from "../types";
import { Button, Card, cn, selectClass } from "./ui";

export interface ConvertOptions {
  preset: ConvertPreset;
  output: "alongside" | "subfolder";
  addToLibrary: boolean;
  deleteOriginals: boolean;
}

interface Props {
  ffmpeg: FfmpegInfo | null;
  /** Number of selected tracks to convert. */
  count: number;
  settings: Settings;
  onSaveSettings: (s: Settings) => void;
  onCancel: () => void;
  onConvert: (opts: ConvertOptions) => void;
  /** Navigate to the Components page (shown when FFmpeg is missing). */
  onGoComponents: () => void;
}

export function ConvertDialog({
  ffmpeg,
  count,
  settings,
  onSaveSettings,
  onCancel,
  onConvert,
  onGoComponents,
}: Props) {
  const [preset, setPreset] = useState<ConvertPreset>(settings.convertPreset);
  const [output, setOutput] = useState<"alongside" | "subfolder">(settings.convertOutput);
  const [addToLibrary, setAddToLibrary] = useState(true);
  const [deleteOriginals, setDeleteOriginals] = useState(false);

  const meta = CONVERT_PRESETS.find((p) => p.value === preset)!;
  const ffmpegReady = !!ffmpeg?.installed;

  const run = () => {
    // Remember the format/location choice for next time.
    if (preset !== settings.convertPreset || output !== settings.convertOutput) {
      onSaveSettings({ ...settings, convertPreset: preset, convertOutput: output });
    }
    onConvert({ preset, output, addToLibrary, deleteOriginals });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-full w-[540px] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Repeat className="h-4 w-4" /> Convert format
            </h2>
            <p className="text-xs text-muted-foreground">
              {count} track{count === 1 ? "" : "s"} selected. Tags and cover art are copied to the
              new file — including the Track ID, so a converted copy stays grouped with the original.
            </p>
          </div>
          <button className="text-muted-foreground hover:text-foreground" onClick={onCancel}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {!ffmpegReady ? (
          <div className="space-y-3 px-5 py-6 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Package className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">FFmpeg is required for conversion</p>
            <p className="mx-auto max-w-sm text-xs text-muted-foreground">
              It isn't installed yet. Add it from the Components page — a one-click download on
              Windows, or <span className="font-mono">brew install ffmpeg</span> on macOS.
            </p>
            <div className="flex justify-center gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button size="sm" onClick={onGoComponents}>
                <Package />
                Go to Components
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold">Target format</span>
                <select
                  className={cn(selectClass, "w-full")}
                  value={preset}
                  onChange={(e) => setPreset(e.target.value as ConvertPreset)}
                >
                  {CONVERT_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-muted-foreground">{meta.hint}</span>
              </label>

              <div>
                <span className="mb-1 block text-xs font-semibold">Save to</span>
                <div className="space-y-1.5">
                  {(
                    [
                      ["alongside", "Next to each original file"],
                      ["subfolder", "A “converted/” subfolder beside each original"],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="convert-output"
                        checked={output === value}
                        onChange={() => setOutput(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={addToLibrary}
                  onChange={(e) => setAddToLibrary(e.target.checked)}
                />
                Add the converted files to the library
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={deleteOriginals}
                  onChange={(e) => setDeleteOriginals(e.target.checked)}
                />
                Move the originals to the Recycle Bin after a successful convert
              </label>
            </div>

            <div className="flex items-center justify-between gap-4 border-t px-5 py-3">
              <span className="text-xs text-muted-foreground">
                {count} → {meta.label}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={onCancel}>
                  Cancel
                </Button>
                <Button size="sm" onClick={run} disabled={count === 0}>
                  <Repeat />
                  Convert {count}
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
