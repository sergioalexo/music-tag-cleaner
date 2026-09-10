import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, HardDrive, Loader2, RotateCw, Usb } from "lucide-react";
import { Badge, Button, Card, cn } from "./ui";

interface RemovableDrive {
  letter: string;
  label: string;
  fileSystem: string;
  sizeBytes: number;
  /** Past Windows' own 32 GB FAT32 ceiling — its built-in tools would refuse. */
  needsLargeFat32: boolean;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${bytes} B`;
}

/**
 * Formats a USB stick as FAT32 for CDJs.
 *
 * Only removable volumes are ever listed — the Rust side filters to
 * `DriveType == Removable` and drops the system drive — and the chosen drive is
 * re-checked against a fresh enumeration at format time, because letters get
 * reused the instant one stick is swapped for another.
 *
 * Confirmation is by *typing the drive's current label*, not by clicking OK.
 * The point is to make the user read what is actually on the drive they are
 * about to erase, which a click-through never achieves.
 */
export function UsbFormatCard({
  notify,
}: {
  notify: (m: string, k?: "info" | "success" | "error") => void;
}) {
  const [drives, setDrives] = useState<RemovableDrive[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [formatting, setFormatting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setDrives(await invoke<RemovableDrive[]>("list_removable_drives"));
    } catch (e) {
      notify(String(e), "error");
      setDrives([]);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const drive = drives?.find((d) => d.letter === selected) ?? null;
  // What has to be typed back: the label, or the letter when there is none.
  const expected = drive ? drive.label.trim() || drive.letter : "";
  const confirmed = !!drive && confirmText.trim().toUpperCase() === expected.toUpperCase();

  const runFormat = async () => {
    if (!drive || !confirmed) return;
    setFormatting(true);
    try {
      await invoke("format_drive_fat32", {
        letter: drive.letter,
        newLabel: newLabel.trim() || drive.label.trim() || "DJ",
        confirm: confirmText.trim(),
      });
      notify(`${drive.letter}: formatted as FAT32`, "success");
      setSelected(null);
      setConfirmText("");
      setNewLabel("");
      await refresh();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setFormatting(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
            <Usb className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <div className="font-semibold">USB Drive — Format for CDJs</div>
            <p className="text-xs text-muted-foreground">
              FAT32 at any size, including sticks over 32 GB that Windows itself refuses
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RotateCw className={loading ? "animate-spin" : ""} />
          Rescan
        </Button>
      </div>

      <div className="mt-4 space-y-2">
        {drives === null ? (
          <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking for removable drives…
          </div>
        ) : drives.length === 0 ? (
          <div className="rounded-lg bg-secondary/50 px-3 py-3 text-sm text-muted-foreground">
            No removable drives found. Plug a USB stick in and hit Rescan — fixed disks are never
            listed here.
          </div>
        ) : (
          drives.map((d) => (
            <button
              key={d.letter}
              onClick={() => {
                setSelected(d.letter === selected ? null : d.letter);
                setConfirmText("");
                setNewLabel(d.label);
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left hover:bg-accent",
                selected === d.letter && "border-primary bg-accent",
              )}
            >
              <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-mono font-semibold">{d.letter}:</span>
              <span className="min-w-0 flex-1 truncate">{d.label || "(no label)"}</span>
              <Badge className="bg-secondary">{d.fileSystem || "unformatted"}</Badge>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatSize(d.sizeBytes)}
              </span>
            </button>
          ))
        )}
      </div>

      {drive && (
        <div className="mt-4 rounded-lg border border-destructive/50 bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1 space-y-3">
              <p className="text-sm">
                <span className="font-semibold text-destructive">
                  Everything on {drive.letter}: will be erased.
                </span>{" "}
                {formatSize(drive.sizeBytes)}
                {drive.label ? ` — ${drive.label}` : ""}
                {drive.fileSystem ? `, currently ${drive.fileSystem}` : ""}. This cannot be undone,
                and Windows will ask for Administrator rights.
                {drive.needsLargeFat32 &&
                  " It is over 32 GB, so Windows' own format tools would refuse it — this uses a full FAT32 writer instead."}
              </p>

              <label className="block text-xs">
                <span className="text-muted-foreground">New volume label</span>
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  maxLength={11}
                  placeholder="DJ"
                  className="mt-1 w-full rounded border bg-background px-2 py-1 font-mono text-sm outline-none focus:border-primary"
                />
                <span className="text-muted-foreground">
                  Up to 11 characters — FAT32&apos;s limit. Letters, digits, space, - and _ survive;
                  anything else is dropped.
                </span>
              </label>

              <label className="block text-xs">
                <span className="text-muted-foreground">
                  Type <span className="font-mono font-semibold text-foreground">{expected}</span> to
                  confirm you mean this drive
                </span>
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={expected}
                  className="mt-1 w-full rounded border bg-background px-2 py-1 font-mono text-sm outline-none focus:border-primary"
                />
              </label>

              <Button
                size="sm"
                variant="destructive"
                disabled={!confirmed || formatting}
                onClick={() => void runFormat()}
              >
                {formatting ? <Loader2 className="animate-spin" /> : <Usb />}
                {formatting ? "Formatting…" : `Erase and format ${drive.letter}: as FAT32`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
