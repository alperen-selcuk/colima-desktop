import { describe, expect, it } from "vitest";
import type { K3sVersion } from "./types";
import {
  filterVersions,
  flattenForKeyboardNav,
  groupVersions,
  isUnknownVersion,
  isValidK3sVersionFormat,
  updatedAgoLabel,
} from "./k3s";

const V = (version: string, minor: string, latestInMinor: boolean): K3sVersion => ({
  version,
  minor,
  publishedAt: null,
  latestInMinor,
});

const SAMPLE: K3sVersion[] = [
  V("v1.31.14+k3s1", "1.31", true),
  V("v1.31.2+k3s1", "1.31", false),
  V("v1.30.14+k3s2", "1.30", true),
  V("v1.29.15+k3s1", "1.29", true),
];

describe("isValidK3sVersionFormat", () => {
  it("accepts well-formed versions", () => {
    expect(isValidK3sVersionFormat("v1.31.2+k3s1")).toBe(true);
    expect(isValidK3sVersionFormat("v1.30.0+k3s10")).toBe(true);
  });

  it("rejects malformed versions", () => {
    expect(isValidK3sVersionFormat("v1.31.2")).toBe(false);
    expect(isValidK3sVersionFormat("1.31.2+k3s1")).toBe(false);
    expect(isValidK3sVersionFormat("v1.31.2+k3sX")).toBe(false);
    expect(isValidK3sVersionFormat("")).toBe(false);
    expect(isValidK3sVersionFormat("latest")).toBe(false);
  });
});

describe("isUnknownVersion", () => {
  it("is false for a version present in the known list", () => {
    expect(isUnknownVersion("v1.31.14+k3s1", SAMPLE)).toBe(false);
  });

  it("is true for a well-formed version absent from the known list", () => {
    expect(isUnknownVersion("v1.99.0+k3s1", SAMPLE)).toBe(true);
  });

  it("is false for a malformed version (that's an error, not a warning)", () => {
    expect(isUnknownVersion("not-a-version", SAMPLE)).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(isUnknownVersion("", SAMPLE)).toBe(false);
  });
});

describe("groupVersions", () => {
  it("finds the recommended version by colimaDefault", () => {
    const grouped = groupVersions(SAMPLE, "v1.31.2+k3s1");
    expect(grouped.recommended?.version).toBe("v1.31.2+k3s1");
  });

  it("recommended is null when colimaDefault is null", () => {
    const grouped = groupVersions(SAMPLE, null);
    expect(grouped.recommended).toBeNull();
  });

  it("recommended is null when colimaDefault isn't in the list", () => {
    const grouped = groupVersions(SAMPLE, "v1.99.0+k3s1");
    expect(grouped.recommended).toBeNull();
  });

  it("latestPerMinor contains only latestInMinor entries, in given order", () => {
    const grouped = groupVersions(SAMPLE, null);
    expect(grouped.latestPerMinor.map((v) => v.version)).toEqual([
      "v1.31.14+k3s1",
      "v1.30.14+k3s2",
      "v1.29.15+k3s1",
    ]);
  });

  it("all contains every version unchanged", () => {
    const grouped = groupVersions(SAMPLE, null);
    expect(grouped.all).toEqual(SAMPLE);
  });
});

describe("filterVersions", () => {
  it("returns everything for an empty query", () => {
    expect(filterVersions(SAMPLE, "")).toEqual(SAMPLE);
    expect(filterVersions(SAMPLE, "   ")).toEqual(SAMPLE);
  });

  it("filters case-insensitively by substring", () => {
    const result = filterVersions(SAMPLE, "1.30");
    expect(result.map((v) => v.version)).toEqual(["v1.30.14+k3s2"]);
  });

  it("matches uppercase query against lowercase content", () => {
    const result = filterVersions(SAMPLE, "K3S1");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((v) => v.version.toLowerCase().includes("k3s1"))).toBe(true);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterVersions(SAMPLE, "v9.9.9")).toEqual([]);
  });
});

describe("flattenForKeyboardNav", () => {
  it("puts recommended first, then latest-per-minor, then filtered all, deduped", () => {
    const grouped = groupVersions(SAMPLE, "v1.31.2+k3s1");
    const flat = flattenForKeyboardNav(grouped, "");
    // v1.31.2+k3s1 appears once (as recommended), not again under "all".
    const occurrences = flat.filter((f) => f.version.version === "v1.31.2+k3s1");
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].section).toBe("recommended");

    // v1.31.14+k3s1 is both latestInMinor and in "all" — appears once, under latestPerMinor.
    const latest = flat.filter((f) => f.version.version === "v1.31.14+k3s1");
    expect(latest).toHaveLength(1);
    expect(latest[0].section).toBe("latestPerMinor");
  });

  it("applies the search query only to the All versions section", () => {
    const grouped = groupVersions(SAMPLE, "v1.31.2+k3s1");
    const flat = flattenForKeyboardNav(grouped, "1.29");
    // Recommended and latestPerMinor are unaffected by the query.
    expect(flat.some((f) => f.section === "recommended")).toBe(true);
    expect(flat.filter((f) => f.section === "latestPerMinor")).toHaveLength(3);
    // "all" section now only shows 1.29 entries not already shown above.
    const allSection = flat.filter((f) => f.section === "all");
    expect(allSection.every((f) => f.version.version.includes("1.29"))).toBe(true);
  });

  it("returns an empty list for empty input", () => {
    const grouped = groupVersions([], null);
    expect(flattenForKeyboardNav(grouped, "")).toEqual([]);
  });
});

describe("updatedAgoLabel", () => {
  const now = new Date("2026-01-01T12:00:00Z").getTime();

  it("returns null for null input", () => {
    expect(updatedAgoLabel(null, now)).toBeNull();
  });

  it("formats seconds as just now", () => {
    const fetchedAt = new Date(now - 10_000).toISOString();
    expect(updatedAgoLabel(fetchedAt, now)).toBe("updated just now");
  });

  it("formats minutes", () => {
    const fetchedAt = new Date(now - 5 * 60_000).toISOString();
    expect(updatedAgoLabel(fetchedAt, now)).toBe("updated 5m ago");
  });

  it("formats hours", () => {
    const fetchedAt = new Date(now - 3 * 3600_000).toISOString();
    expect(updatedAgoLabel(fetchedAt, now)).toBe("updated 3h ago");
  });

  it("formats days", () => {
    const fetchedAt = new Date(now - 2 * 86400_000).toISOString();
    expect(updatedAgoLabel(fetchedAt, now)).toBe("updated 2d ago");
  });
});
