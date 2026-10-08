import { describe, expect, it } from "vitest";
import { buildRekordboxPlaylistXml, escapeXmlAttr, pathToLocation } from "./rekordboxExport";
import type { AudioFile, TagData } from "../types";

describe("escapeXmlAttr", () => {
  it("escapes markup and drops control characters XML 1.0 forbids", () => {
    expect(escapeXmlAttr('A & B "<live>"')).toBe("A &amp; B &quot;&lt;live&gt;&quot;");
    expect(escapeXmlAttr("Bad\u0001Title\u001F")).toBe("BadTitle");
    expect(escapeXmlAttr("two\nlines\tand\rcr")).toBe("two&#10;lines&#9;and&#13;cr");
  });
});

describe("pathToLocation", () => {
  it("keeps the drive letter and percent-encodes each Windows segment", () => {
    expect(pathToLocation("C:\\Music\\A-Trak, Ferreck Dawn.flac")).toBe(
      "file://localhost/C:/Music/A-Trak%2C%20Ferreck%20Dawn.flac",
    );
  });

  it("does not double the slash before a macOS path", () => {
    expect(pathToLocation("/Users/dj/Music/Énergie.mp3")).toBe(
      "file://localhost/Users/dj/Music/%C3%89nergie.mp3",
    );
  });
});

describe("buildRekordboxPlaylistXml", () => {
  it("produces a document an XML parser accepts even with dirty tags", () => {
    const path = "C:\\Music\\track.mp3";
    const files: Record<string, AudioFile> = {
      [path]: {
        path,
        filename: "track.mp3",
        format: "mp3",
        size: 100,
        hasBackup: false,
        durationSecs: 61.6,
      } as AudioFile,
    };
    const tags: Record<string, TagData> = {
      [path]: { title: "Ti\u0002tle & <More>", artist: 'DJ "X"', allFields: {} } as unknown as TagData,
    };
    const xml = buildRekordboxPlaylistXml("Set\u0007 1", [path], files, tags);
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(xml).toContain('Name="Title &amp; &lt;More&gt;"');
    expect(xml).toContain('Artist="DJ &quot;X&quot;"');
    expect(xml).toContain('TotalTime="62"');
    expect(xml).toContain('Name="Set 1"');
  });
});
