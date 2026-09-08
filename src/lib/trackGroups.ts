import { basename, type AudioFile, type TagData, type TrackGroup } from "../types";
import { isUid } from "./standardize";

/**
 * Groups loaded files that share an app-assigned Track ID (a UID as judged by
 * `isUid`) into one `TrackGroup` — the "same recording, different formats"
 * relationship the library sidebar's Tracks mode shows. Only groups with two
 * or more members are returned; a lone file isn't a group.
 */
export function buildTrackGroups(
  files: AudioFile[],
  tags: Record<string, TagData>,
  digits: number,
): TrackGroup[] {
  const byId = new Map<string, AudioFile[]>();
  for (const f of files) {
    const id = tags[f.path]?.trackId;
    if (!id || !isUid(id, digits)) continue;
    const arr = byId.get(id);
    if (arr) arr.push(f);
    else byId.set(id, [f]);
  }

  const groups: TrackGroup[] = [];
  for (const [trackId, members] of byId) {
    if (members.length < 2) continue;
    const first = tags[members[0].path];
    const name =
      [first?.artist, first?.title].filter(Boolean).join(" — ") || basename(members[0].path);
    const formats = [...new Set(members.map((m) => (m.format || "?").toUpperCase()))].sort();
    groups.push({ trackId, name, formats, paths: members.map((m) => m.path) });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Track ID → the distinct formats currently loaded under it. Feeds the small
 * "also loaded as …" link badge in the Track ID cell. Includes single-file
 * ids too (the badge just won't render for those).
 */
export function trackIdFormats(
  files: AudioFile[],
  tags: Record<string, TagData>,
): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const f of files) {
    const id = tags[f.path]?.trackId;
    if (!id) continue;
    const fmt = (f.format || "?").toUpperCase();
    const arr = m.get(id) ?? [];
    if (!arr.includes(fmt)) arr.push(fmt);
    m.set(id, arr);
  }
  return m;
}
