import { describe, expect, it } from "vitest";
import {
  fallbackTileVar,
  FALLBACK_TILE_VARS,
  parseImageRepository,
  resolveImageIcon,
  stableHash,
} from "./imageIcon";

describe("parseImageRepository", () => {
  it("strips registry host and tag", () => {
    expect(parseImageRepository("docker.io/library/postgres:16")).toBe("postgres");
  });

  it("strips namespace without a registry host", () => {
    expect(parseImageRepository("bitnami/redis")).toBe("redis");
  });

  it("keeps a bare image name with a tag", () => {
    expect(parseImageRepository("nginx:latest")).toBe("nginx");
  });

  it("keeps a bare image name with no tag", () => {
    expect(parseImageRepository("myapp")).toBe("myapp");
  });

  it("handles a digest reference", () => {
    expect(parseImageRepository("redis@sha256:abcdef1234567890")).toBe("redis");
  });

  it("handles a digest reference combined with a tag", () => {
    expect(parseImageRepository("redis:7@sha256:abcdef1234567890")).toBe("redis");
  });

  it("handles a registry host with a port", () => {
    expect(parseImageRepository("localhost:5000/myapp:dev")).toBe("myapp");
  });

  it("handles a deeper registry path (ghcr.io org/name)", () => {
    expect(parseImageRepository("ghcr.io/myorg/myapp:latest")).toBe("myapp");
  });

  it("lowercases the result", () => {
    expect(parseImageRepository("MyApp/Postgres:16")).toBe("postgres");
  });

  it("returns empty string for empty input", () => {
    expect(parseImageRepository("")).toBe("");
  });
});

describe("resolveImageIcon", () => {
  it("matches a well-known image via registry+namespace+tag", () => {
    const result = resolveImageIcon("docker.io/library/postgres:16");
    expect(result).not.toBeNull();
    expect(result!.icon.title).toBe("PostgreSQL");
  });

  it("matches a well-known image via a third-party namespace", () => {
    const result = resolveImageIcon("bitnami/redis");
    expect(result).not.toBeNull();
    expect(result!.icon.title).toBe("Redis");
  });

  it("matches nginx", () => {
    expect(resolveImageIcon("nginx:latest")?.icon.title).toBe("NGINX");
  });

  it("matches node under its 'node' repo alias", () => {
    expect(resolveImageIcon("node:20-alpine")?.icon.title).toBe("Node.js");
  });

  it("matches images with 'kafka' anywhere in the name", () => {
    expect(resolveImageIcon("confluentinc/cp-kafka:7.6.0")?.icon.title).toBe("Apache Kafka");
  });

  it("returns null for an unknown image", () => {
    expect(resolveImageIcon("myorg/totally-custom-app:1.0.0")).toBeNull();
  });

  it("returns null for an empty image string", () => {
    expect(resolveImageIcon("")).toBeNull();
  });
});

describe("stableHash / fallbackTileVar", () => {
  it("is deterministic for the same input", () => {
    expect(stableHash("myorg/totally-custom-app")).toBe(stableHash("myorg/totally-custom-app"));
    expect(fallbackTileVar("myorg/totally-custom-app")).toBe(fallbackTileVar("myorg/totally-custom-app"));
  });

  it("always returns one of the known fallback tile variables", () => {
    const names = ["a", "totally-different", "yet-another-image", "🐳", ""];
    for (const n of names) {
      expect(FALLBACK_TILE_VARS).toContain(fallbackTileVar(n));
    }
  });

  it("spreads distinct names across more than one bucket", () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    const buckets = new Set(names.map((n) => fallbackTileVar(n)));
    expect(buckets.size).toBeGreaterThan(1);
  });
});
