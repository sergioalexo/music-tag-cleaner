import { describe, expect, it } from "vitest";
import { cleanInputs, resultsForBatch } from "./useAI";
import type { CleanedTrack, TagData } from "../types";

describe("resultsForBatch", () => {
  it("drops results whose index belongs to another batch", () => {
    const paths = ["a.mp3", "b.mp3", "c.mp3", "d.mp3"];
    const map = Object.fromEntries(paths.map((p) => [p, { allFields: {} } as unknown as TagData]));
    const inputs = cleanInputs(paths, map);
    const secondBatch = inputs.slice(2); // indexes 3 and 4
    const answer: CleanedTrack[] = [
      { index: 3, title: "Right" },
      { index: 1, title: "Hallucinated — belongs to the first batch" },
      { index: 9, title: "Out of range" },
    ] as CleanedTrack[];
    expect(resultsForBatch(secondBatch, answer).map((r) => r.index)).toEqual([3]);
  });
});
