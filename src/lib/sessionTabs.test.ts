import { describe, expect, it } from "vitest";
import { afterManualAdd, decideGenreClick, type SessionSource } from "./sessionTabs";

describe("decideGenreClick", () => {
  const empty: SessionSource = { kind: "empty" };
  const genre: SessionSource = { kind: "genre", genre: "House" };
  const manual: SessionSource = { kind: "manual" };

  it("loads straight away in an empty or genre session", () => {
    expect(decideGenreClick({ source: empty, hasUnappliedPreview: false })).toBe("load");
    expect(decideGenreClick({ source: genre, hasUnappliedPreview: false })).toBe("load");
  });

  it("confirms first only when a preview would be discarded", () => {
    expect(decideGenreClick({ source: empty, hasUnappliedPreview: true })).toBe("confirm-load");
    expect(decideGenreClick({ source: genre, hasUnappliedPreview: true })).toBe("confirm-load");
  });

  it("hands a hand-built batch back to the caller, preview or not", () => {
    expect(decideGenreClick({ source: manual, hasUnappliedPreview: false })).toBe("manual");
    expect(decideGenreClick({ source: manual, hasUnappliedPreview: true })).toBe("manual");
  });
});

describe("afterManualAdd", () => {
  it("flips every source, genre sessions included, to manual", () => {
    expect(afterManualAdd({ kind: "empty" })).toEqual({ kind: "manual" });
    expect(afterManualAdd({ kind: "genre", genre: "House" })).toEqual({ kind: "manual" });
    expect(afterManualAdd({ kind: "manual" })).toEqual({ kind: "manual" });
  });
});
