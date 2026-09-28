import { describe, expect, it } from "vitest";
import {
  computePrunePreview,
  formatSizeBytes,
  sortVolumes,
  totalReclaimableBytes,
  volumeSourceLabel,
} from "./volumes";
import type { Volume } from "./types";

function makeVolume(overrides: Partial<Volume>): Volume {
  return {
    name: "vol",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/vol/_data",
    size: null,
    sizeBytes: null,
    containers: null,
    inUse: false,
    anonymous: false,
    composeProject: null,
    createdAt: null,
    ...overrides,
  };
}

describe("formatSizeBytes", () => {
  it("formats zero", () => {
    expect(formatSizeBytes(0)).toBe("0B");
  });

  it("formats bytes with decimal (SI) units (values captured live from `docker system df -v`, server 27.4.0)", () => {
    expect(formatSizeBytes(1831)).toBe("1.83kB");
    expect(formatSizeBytes(47_990_000)).toBe("48.0MB"); // >=10 in-unit -> 1 decimal
    expect(formatSizeBytes(136_500_000)).toBe("136.5MB");
    expect(formatSizeBytes(678_300_000)).toBe("678.3MB");
    expect(formatSizeBytes(1_200_000_000)).toBe("1.20GB");
  });

  it("treats negative/non-finite as 0B", () => {
    expect(formatSizeBytes(-5)).toBe("0B");
    expect(formatSizeBytes(NaN)).toBe("0B");
  });
});

describe("sortVolumes", () => {
  const a = makeVolume({ name: "b-vol", sizeBytes: 100, createdAt: "2024-01-01T00:00:00Z" });
  const b = makeVolume({ name: "a-vol", sizeBytes: 300, createdAt: "2024-03-01T00:00:00Z" });
  const c = makeVolume({ name: "c-vol", sizeBytes: null, createdAt: null });

  it("sorts by name, locale-aware", () => {
    const sorted = sortVolumes([a, b, c], "name");
    expect(sorted.map((v) => v.name)).toEqual(["a-vol", "b-vol", "c-vol"]);
  });

  it("sorts by size descending, unknown sizes last", () => {
    const sorted = sortVolumes([a, b, c], "size");
    expect(sorted.map((v) => v.name)).toEqual(["a-vol", "b-vol", "c-vol"]);
  });

  it("sorts by created date, newest first, unknown last", () => {
    const sorted = sortVolumes([a, b, c], "created");
    expect(sorted.map((v) => v.name)).toEqual(["a-vol", "b-vol", "c-vol"]);
  });

  it("does not mutate the input array", () => {
    const input = [a, b, c];
    const original = [...input];
    sortVolumes(input, "name");
    expect(input).toEqual(original);
  });
});

describe("computePrunePreview", () => {
  // Mirrors the exact bug report scenario: 7 unused named volumes (5 with
  // compose projects), an in-use one, and one anonymous.
  const composeLeftover1 = makeVolume({
    name: "alperenselcuk_db_data",
    sizeBytes: 136_500_000,
    composeProject: "alperenselcuk",
    inUse: false,
    anonymous: false,
  });
  const composeLeftover2 = makeVolume({
    name: "logbat_postgres_data",
    sizeBytes: 47_990_000,
    composeProject: "logbat",
    inUse: false,
    anonymous: false,
  });
  const plainNamed = makeVolume({
    name: "setur-nuget",
    sizeBytes: 0,
    composeProject: null,
    inUse: false,
    anonymous: false,
  });
  const anonymousUnused = makeVolume({
    name: "a1b2c3d4",
    sizeBytes: 3_400_000,
    composeProject: null,
    inUse: false,
    anonymous: true,
  });
  const inUseNamed = makeVolume({
    name: "myapp_pgdata",
    sizeBytes: 1_200_000_000,
    composeProject: "myapp",
    inUse: true,
    anonymous: false,
  });
  const unknownSizeUnused = makeVolume({
    name: "unknown-size-vol",
    sizeBytes: null,
    inUse: false,
    anonymous: false,
  });

  const all = [composeLeftover1, composeLeftover2, plainNamed, anonymousUnused, inUseNamed, unknownSizeUnused];

  it("'anonymous' scope only includes unused anonymous volumes — reproduces the bug: named leftovers are NOT included", () => {
    const preview = computePrunePreview(all, "anonymous");
    expect(preview.volumes.map((v) => v.name)).toEqual(["a1b2c3d4"]);
    expect(preview.namedCount).toBe(0);
  });

  it("'all' scope includes every unused volume regardless of anonymous/named, excluding in-use ones", () => {
    const preview = computePrunePreview(all, "all");
    const names = preview.volumes.map((v) => v.name);
    expect(names).toContain("alperenselcuk_db_data");
    expect(names).toContain("logbat_postgres_data");
    expect(names).toContain("setur-nuget");
    expect(names).toContain("a1b2c3d4");
    expect(names).toContain("unknown-size-vol");
    expect(names).not.toContain("myapp_pgdata"); // in use — never pruned
    expect(preview.namedCount).toBe(4); // all but the anonymous one
  });

  it("sums known sizes and counts unknown-size volumes separately", () => {
    const preview = computePrunePreview(all, "all");
    // 136_500_000 + 47_990_000 + 0 + 3_400_000 (unknown-size-vol excluded from sum)
    expect(preview.totalBytes).toBe(136_500_000 + 47_990_000 + 0 + 3_400_000);
    expect(preview.unknownSizeCount).toBe(1);
  });

  it("empty preview when nothing matches (e.g. everything in use)", () => {
    const preview = computePrunePreview([inUseNamed], "all");
    expect(preview.volumes).toEqual([]);
    expect(preview.totalBytes).toBe(0);
    expect(preview.namedCount).toBe(0);
  });

  it("empty preview for 'anonymous' scope when no anonymous volumes are unused", () => {
    const preview = computePrunePreview([composeLeftover1, inUseNamed], "anonymous");
    expect(preview.volumes).toEqual([]);
  });
});

describe("totalReclaimableBytes", () => {
  it("sums sizeBytes across unused volumes only, treating unknown as 0", () => {
    const volumes = [
      makeVolume({ sizeBytes: 100, inUse: false }),
      makeVolume({ sizeBytes: 200, inUse: false }),
      makeVolume({ sizeBytes: null, inUse: false }),
      makeVolume({ sizeBytes: 9999, inUse: true }), // excluded: in use
    ];
    expect(totalReclaimableBytes(volumes)).toBe(300);
  });

  it("returns 0 for an empty list", () => {
    expect(totalReclaimableBytes([])).toBe(0);
  });
});

describe("volumeSourceLabel", () => {
  it("returns the compose project when set", () => {
    expect(volumeSourceLabel(makeVolume({ composeProject: "myapp", anonymous: false }))).toBe("myapp");
  });

  it("returns 'anonymous' for an anonymous volume with no compose project", () => {
    expect(volumeSourceLabel(makeVolume({ composeProject: null, anonymous: true }))).toBe("anonymous");
  });

  it("returns 'named' for a plain named volume", () => {
    expect(volumeSourceLabel(makeVolume({ composeProject: null, anonymous: false }))).toBe("named");
  });
});
