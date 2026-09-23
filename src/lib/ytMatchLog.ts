import type { EntryMatch, MatchCandidate, MatchStatus } from "./ytMatch";
import { buildWanted, CONFIDENT_THRESHOLD } from "./ytMatch";

/**
 * A record of how one playlist import actually went — what the matcher
 * proposed, what the user did about it, and every alternate it had to
 * choose from.
 *
 * This exists to be fed back into an AI: the whole point is to be able to
 * look at fifty real decisions and see *where the scorer disagreed with a
 * human*, which is the only honest signal for tuning thresholds and
 * weights. So every entry carries the scores and the losing candidates too,
 * not just the outcome — an accepted match and a match the user had to
 * correct look identical if you only log the final answer.
 */

/** What the user did with the matcher's proposal. */
export type MatchAction =
  /** Scored above the confident threshold and was taken as-is. */
  | "auto-accepted"
  /** Matcher was unsure; the user accepted the top suggestion anyway. */
  | "confirmed"
  /** The user picked a different candidate than the one proposed. */
  | "corrected"
  /** The user dragged a track in from the library search panel. */
  | "picked-from-search"
  /** The user rejected one or more suggestions. */
  | "denied"
  /** No candidate survived — the track isn't in the collection. */
  | "left-missing";

export interface LoggedCandidate {
  path: string;
  label: string;
  score: number;
  titleScore: number;
  artistScore: number;
  durationDelta: number | null;
  via: MatchCandidate["via"];
  /** True for the candidate the user ended up with. */
  chosen: boolean;
  /** True if the user explicitly rejected this one. */
  denied: boolean;
}

export interface LoggedEntry {
  index: number;
  videoId: string;
  url: string;
  /** The raw video title, exactly as YouTube has it. */
  ytTitle: string;
  /** What the matcher parsed out of that title. */
  parsedArtist: string | null;
  parsedTitle: string;
  ytUploader: string | null;
  ytDurationSecs: number | null;
  /** Version qualifier the matcher read out of the title, e.g. ["tale","of","us","remix"]. */
  ytVersion: string[];
  autoStatus: MatchStatus;
  autoScore: number | null;
  finalPath: string | null;
  finalLabel: string | null;
  action: MatchAction;
  /** True when the user's answer differs from what the matcher proposed —
   * the rows worth looking at first when tuning. */
  disagreedWithMatcher: boolean;
  candidates: LoggedCandidate[];
}

export interface MatchLog {
  generatedAt: string;
  playlistTitle: string;
  playlistUrl: string;
  /** How many library tracks the playlist was matched against. */
  collectionSize: number;
  thresholds: { confident: number; ambiguous: number };
  summary: {
    total: number;
    matched: number;
    missing: number;
    autoAccepted: number;
    confirmed: number;
    corrected: number;
    denied: number;
    /** Share of proposals the user had to change — the number to drive down. */
    disagreementRate: number;
  };
  entries: LoggedEntry[];
}

export interface DecisionState {
  /** videoId -> chosen path, or "" for "explicitly marked missing". */
  overrides: Record<string, string>;
  /** videoId -> paths the user rejected. */
  denied: Record<string, string[]>;
  /** videoIds whose match came from a drag out of the search panel. */
  fromSearch: Record<string, boolean>;
}

function classify(
  match: EntryMatch,
  finalPath: string | null,
  state: DecisionState,
): { action: MatchAction; disagreed: boolean } {
  const { videoId } = match.entry;
  const proposed = match.candidates[0] ?? null;
  const wasOverridden = state.overrides[videoId] !== undefined;
  const deniedAny = (state.denied[videoId]?.length ?? 0) > 0;

  if (!finalPath) {
    // Denial is the more informative label: it means the matcher offered
    // something and a human said no, which is a scoring failure worth
    // seeing. A plain "nothing found" is not.
    if (deniedAny) return { action: "denied", disagreed: true };
    return { action: "left-missing", disagreed: match.status !== "missing" };
  }
  if (state.fromSearch[videoId]) return { action: "picked-from-search", disagreed: true };
  if (proposed && finalPath !== proposed.path) return { action: "corrected", disagreed: true };
  if (!wasOverridden && match.status === "matched") return { action: "auto-accepted", disagreed: false };
  return { action: "confirmed", disagreed: match.status !== "matched" };
}

/**
 * Builds the log for one import run. `label` renders a path the way the UI
 * does ("Artist - Title"), so the log reads the same as the screen the
 * decisions were made on.
 */
export function buildMatchLog(
  playlistTitle: string,
  playlistUrl: string,
  matches: EntryMatch[],
  state: DecisionState,
  resolvePath: (match: EntryMatch) => string | null,
  label: (path: string) => string,
  collectionSize: number,
  ambiguousThreshold: number,
): MatchLog {
  const entries: LoggedEntry[] = matches.map((m) => {
    const finalPath = resolvePath(m);
    const denied = m.entry.videoId in state.denied ? state.denied[m.entry.videoId] : [];
    const { action, disagreed } = classify(m, finalPath, state);
    const want = buildWanted(m.entry);
    return {
      index: m.entry.index,
      videoId: m.entry.videoId,
      url: m.entry.url,
      ytTitle: m.entry.title,
      parsedArtist: want.artist,
      parsedTitle: want.title,
      ytUploader: m.entry.uploader ?? null,
      ytDurationSecs: m.entry.durationSecs ?? null,
      ytVersion: [...want.version],
      autoStatus: m.status,
      autoScore: m.candidates[0]?.score ?? null,
      finalPath,
      finalLabel: finalPath ? label(finalPath) : null,
      action,
      disagreedWithMatcher: disagreed,
      candidates: m.candidates.map((c) => ({
        path: c.path,
        label: label(c.path),
        score: Number(c.score.toFixed(4)),
        titleScore: Number(c.titleScore.toFixed(4)),
        artistScore: Number(c.artistScore.toFixed(4)),
        durationDelta: c.durationDelta,
        via: c.via,
        chosen: c.path === finalPath,
        denied: denied.includes(c.path),
      })),
    };
  });

  const count = (a: MatchAction) => entries.filter((e) => e.action === a).length;
  const disagreements = entries.filter((e) => e.disagreedWithMatcher).length;

  return {
    generatedAt: new Date().toISOString(),
    playlistTitle,
    playlistUrl,
    collectionSize,
    thresholds: { confident: CONFIDENT_THRESHOLD, ambiguous: ambiguousThreshold },
    summary: {
      total: entries.length,
      matched: entries.filter((e) => e.finalPath).length,
      missing: entries.filter((e) => !e.finalPath).length,
      autoAccepted: count("auto-accepted"),
      confirmed: count("confirmed"),
      corrected: count("corrected") + count("picked-from-search"),
      denied: count("denied"),
      disagreementRate: entries.length ? Number((disagreements / entries.length).toFixed(4)) : 0,
    },
    entries,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * A readable rendering of the same log. The JSON is what an AI should chew
 * on; this is what a person skims to see whether the run went well — it
 * leads with the disagreements, because those are the actionable part.
 */
export function matchLogToMarkdown(log: MatchLog): string {
  const L: string[] = [];
  L.push(`# Playlist match log — ${log.playlistTitle}`);
  L.push("");
  L.push(`- Generated: ${log.generatedAt}`);
  L.push(`- Playlist: ${log.playlistUrl}`);
  L.push(`- Matched against ${log.collectionSize} library track(s)`);
  L.push(
    `- Thresholds: confident ≥ ${log.thresholds.confident}, ambiguous ≥ ${log.thresholds.ambiguous}`,
  );
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push(`| Total | Matched | Missing | Auto | Confirmed | Corrected | Denied | Disagreement |`);
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  L.push(
    `| ${log.summary.total} | ${log.summary.matched} | ${log.summary.missing} | ` +
      `${log.summary.autoAccepted} | ${log.summary.confirmed} | ${log.summary.corrected} | ` +
      `${log.summary.denied} | ${pct(log.summary.disagreementRate)} |`,
  );
  L.push("");

  const disagreements = log.entries.filter((e) => e.disagreedWithMatcher);
  if (disagreements.length) {
    L.push("## Where the matcher was wrong");
    L.push("");
    L.push("These are the rows worth tuning against — the human answer differed from the proposal.");
    L.push("");
    for (const e of disagreements) {
      L.push(`### ${e.index + 1}. ${e.ytTitle}`);
      L.push("");
      L.push(`- Parsed as: artist \`${e.parsedArtist ?? "—"}\`, title \`${e.parsedTitle}\``);
      if (e.ytVersion.length) L.push(`- Version read as: \`${e.ytVersion.join(" ")}\``);
      L.push(`- Matcher said: **${e.autoStatus}**${e.autoScore !== null ? ` (${e.autoScore.toFixed(3)})` : ""}`);
      L.push(`- Human said: **${e.action}** → ${e.finalLabel ?? "missing"}`);
      if (e.candidates.length) {
        L.push(`- Candidates:`);
        for (const c of e.candidates) {
          const marks = [c.chosen ? "chosen" : null, c.denied ? "denied" : null]
            .filter(Boolean)
            .join(", ");
          L.push(
            `  - \`${c.score.toFixed(3)}\` via ${c.via} — ${c.label}` +
              (c.durationDelta !== null ? ` (Δ${Math.round(c.durationDelta)}s)` : "") +
              (marks ? ` **[${marks}]**` : ""),
          );
        }
      }
      L.push("");
    }
  }

  const missing = log.entries.filter((e) => !e.finalPath);
  if (missing.length) {
    L.push("## Still missing");
    L.push("");
    for (const e of missing) L.push(`- [${e.ytTitle}](${e.url})`);
    L.push("");
  }

  return L.join("\n");
}
