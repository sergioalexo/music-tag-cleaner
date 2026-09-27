import { describe, expect, it } from "vitest";
import { parseImportInput, shortHash } from "./ytListInput";

describe("parseImportInput", () => {
  it("skips blank lines and # comments", () => {
    const items = parseImportInput("\n# a comment\n\nFlo Rida - Low\n");
    expect(items).toEqual([{ kind: "text", line: "Flo Rida - Low", raw: "Flo Rida - Low" }]);
  });

  it("recognizes a playlist URL by its list= param, on youtube.com or music.youtube.com", () => {
    expect(parseImportInput("https://music.youtube.com/playlist?list=PL123")).toEqual([
      { kind: "playlist", url: "https://music.youtube.com/playlist?list=PL123" },
    ]);
    expect(parseImportInput("https://www.youtube.com/playlist?list=PL123")).toEqual([
      { kind: "playlist", url: "https://www.youtube.com/playlist?list=PL123" },
    ]);
  });

  it("treats a list= URL as a playlist even when it also carries a v= param", () => {
    const url = "https://music.youtube.com/watch?v=abc123&list=PL123";
    expect(parseImportInput(url)).toEqual([{ kind: "playlist", url }]);
  });

  it("recognizes watch?v=, youtu.be/<id> and shorts/<id> as videos", () => {
    expect(parseImportInput("https://music.youtube.com/watch?v=uUL8a7eJCk8")).toEqual([
      { kind: "video", url: "https://music.youtube.com/watch?v=uUL8a7eJCk8", videoId: "uUL8a7eJCk8" },
    ]);
    expect(parseImportInput("https://youtu.be/dQw4w9WgXcQ")).toEqual([
      { kind: "video", url: "https://youtu.be/dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ" },
    ]);
    expect(parseImportInput("https://www.youtube.com/shorts/aBcDeFgHiJk")).toEqual([
      { kind: "video", url: "https://www.youtube.com/shorts/aBcDeFgHiJk", videoId: "aBcDeFgHiJk" },
    ]);
  });

  it("strips list numbering (digits, bullets, dashes) before classifying the line", () => {
    expect(parseImportInput("1. Flo Rida - Low")).toEqual([
      { kind: "text", line: "Flo Rida - Low", raw: "1. Flo Rida - Low" },
    ]);
    expect(parseImportInput("01) Boris Brejcha - Gravity")).toEqual([
      { kind: "text", line: "Boris Brejcha - Gravity", raw: "01) Boris Brejcha - Gravity" },
    ]);
    expect(parseImportInput("3 - Kryptonite")).toEqual([
      { kind: "text", line: "Kryptonite", raw: "3 - Kryptonite" },
    ]);
    expect(parseImportInput("• Take On Me")).toEqual([
      { kind: "text", line: "Take On Me", raw: "• Take On Me" },
    ]);
  });

  it("strips a trailing duration", () => {
    expect(parseImportInput("Bad Romance by Lady Gaga 3:45")).toEqual([
      { kind: "text", line: "Bad Romance by Lady Gaga", raw: "Bad Romance by Lady Gaga 3:45" },
    ]);
  });

  it("never mistakes a title that starts with a bare number for numbering", () => {
    expect(parseImportInput("24K Magic")).toEqual([{ kind: "text", line: "24K Magic", raw: "24K Magic" }]);
  });

  it("maps an artist,title CSV header regardless of column order", () => {
    expect(parseImportInput("artist,title\nFlo Rida,Low\nLady Gaga,Bad Romance")).toEqual([
      { kind: "text", line: "Flo Rida - Low", raw: "Flo Rida,Low" },
      { kind: "text", line: "Lady Gaga - Bad Romance", raw: "Lady Gaga,Bad Romance" },
    ]);
    expect(parseImportInput("title\tartist\nLow\tFlo Rida")).toEqual([
      { kind: "text", line: "Flo Rida - Low", raw: "Low\tFlo Rida" },
    ]);
  });

  it("does not treat a plain line with a comma as CSV when there's no recognized header", () => {
    expect(parseImportInput("Low (feat. T-Pain), by Flo Rida")).toEqual([
      { kind: "text", line: "Low (feat. T-Pain), by Flo Rida", raw: "Low (feat. T-Pain), by Flo Rida" },
    ]);
  });

  it("combines a playlist URL, video links and typed song names into one ordered list", () => {
    const input = [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://music.youtube.com/playlist?list=PL123",
      "Flo Rida - Low",
      "Bad Romance by Lady Gaga",
    ].join("\n");
    expect(parseImportInput(input)).toEqual([
      { kind: "video", url: "https://youtu.be/dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ" },
      { kind: "playlist", url: "https://music.youtube.com/playlist?list=PL123" },
      { kind: "text", line: "Flo Rida - Low", raw: "Flo Rida - Low" },
      { kind: "text", line: "Bad Romance by Lady Gaga", raw: "Bad Romance by Lady Gaga" },
    ]);
  });
});

describe("shortHash", () => {
  it("is deterministic for the same input", () => {
    expect(shortHash("Flo Rida - Low")).toBe(shortHash("Flo Rida - Low"));
  });

  it("differs for different input", () => {
    expect(shortHash("Flo Rida - Low")).not.toBe(shortHash("Boris Brejcha - Gravity"));
  });
});
