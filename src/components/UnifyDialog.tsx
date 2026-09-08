import { Link2, X } from "lucide-react";

import { basename } from "../types";
import { Button, Card, cn } from "./ui";

export interface UnifyMember {
  path: string;
  format: string;
  /** The file's current Track ID, if any. */
  fromId?: string;
  /** Whether this file's Track ID will change when linked. */
  changes: boolean;
}

export interface UnifyGroup {
  /** The Track ID every member will share. */
  canonicalId: string;
  /** True when `canonicalId` is a freshly generated id (no member had one). */
  generated: boolean;
  members: UnifyMember[];
}

interface Props {
  groups: UnifyGroup[];
  /** Count of alternate-version clusters (edits/remixes) found but not linked. */
  alternates: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function UnifyDialog({ groups, alternates, onCancel, onConfirm }: Props) {
  const changeCount = groups.reduce(
    (n, g) => n + g.members.filter((m) => m.changes).length,
    0,
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <Card className="flex max-h-full w-[620px] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Link2 className="h-4 w-4" /> Unify Track IDs
            </h2>
            <p className="text-xs text-muted-foreground">
              {groups.length === 0
                ? "No same-recording matches found across the loaded files."
                : `${groups.length} group${groups.length === 1 ? "" : "s"} of the same recording — ${changeCount} file${
                    changeCount === 1 ? "" : "s"
                  } will get a shared Track ID so they group as one track.`}
              {alternates > 0 && (
                <> {alternates} probable edit/remix pair{alternates === 1 ? "" : "s"} were left alone.</>
              )}
            </p>
          </div>
          <button className="text-muted-foreground hover:text-foreground" onClick={onCancel}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {groups.map((g) => (
            <div key={g.canonicalId} className="rounded-md border">
              <div className="flex items-center gap-2 border-b bg-secondary/40 px-3 py-1.5 text-xs">
                <span className="font-semibold">Track ID {g.canonicalId}</span>
                {g.generated && (
                  <span className="rounded bg-primary/15 px-1 text-[10px] font-medium text-primary">
                    new
                  </span>
                )}
              </div>
              <ul className="divide-y">
                {g.members.map((m) => (
                  <li key={m.path} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                    <span className="rounded bg-secondary px-1 text-[9px] font-semibold uppercase text-muted-foreground">
                      {m.format}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={m.path}>
                      {basename(m.path)}
                    </span>
                    <span
                      className={cn(
                        "shrink-0",
                        m.changes ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {m.changes ? `${m.fromId || "—"} → ${g.canonicalId}` : "already linked"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={changeCount === 0}>
            <Link2 />
            Link {groups.length} group{groups.length === 1 ? "" : "s"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
