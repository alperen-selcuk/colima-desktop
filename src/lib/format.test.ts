import { describe, expect, it } from "vitest";
import { formatBytes, relativeAge, stripAnsi, groupByComposeProject, base64ToBytes, resolveTheme } from "./format";
import type { Container } from "./types";

describe("formatBytes", () => {
  it("formats zero", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes under 1024 with no decimals", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kibibytes", () => {
    expect(formatBytes(2048)).toBe("2.00 KiB");
  });

  it("formats mebibytes with decimals under 10", () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.50 MiB");
  });

  it("formats gibibytes with one decimal when >= 10", () => {
    expect(formatBytes(12.3 * 1024 * 1024 * 1024)).toBe("12.3 GiB");
  });

  it("handles negative/invalid input safely", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });
});

describe("relativeAge", () => {
  const now = new Date("2026-09-27T12:00:00.000Z").getTime();

  it("formats seconds", () => {
    expect(relativeAge(now - 30_000, now)).toBe("30s");
  });

  it("formats minutes", () => {
    expect(relativeAge(now - 5 * 60_000, now)).toBe("5m");
  });

  it("formats hours", () => {
    expect(relativeAge(now - 3 * 3600_000, now)).toBe("3h");
  });

  it("formats days", () => {
    expect(relativeAge(now - 2 * 86400_000, now)).toBe("2d");
  });

  it("formats years", () => {
    expect(relativeAge(now - 400 * 86400_000, now)).toBe("1y");
  });

  it("accepts ISO timestamp strings", () => {
    expect(relativeAge(new Date(now - 60_000).toISOString(), now)).toBe("1m");
  });

  it("returns ? for invalid input", () => {
    expect(relativeAge("not-a-date", now)).toBe("?");
  });
});

describe("stripAnsi", () => {
  it("removes color codes", () => {
    expect(stripAnsi("\u001b[31mred text\u001b[0m")).toBe("red text");
  });

  it("removes cursor movement sequences", () => {
    expect(stripAnsi("\u001b[2K\u001b[1Gloading...")).toBe("loading...");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("plain log line")).toBe("plain log line");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("base64ToBytes", () => {
  it("decodes a simple ASCII string", () => {
    const bytes = base64ToBytes(btoa("hello"));
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("returns an empty array for an empty string", () => {
    expect(base64ToBytes("")).toEqual(new Uint8Array(0));
  });

  it("round-trips raw byte values including control characters", () => {
    const original = new Uint8Array([0, 27, 91, 49, 109, 10, 255]);
    const binary = String.fromCharCode(...original);
    const bytes = base64ToBytes(btoa(binary));
    expect(Array.from(bytes)).toEqual(Array.from(original));
  });
});

describe("resolveTheme", () => {
  it("returns light when preference is light regardless of system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("returns dark when preference is dark regardless of system", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the system preference when set to system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("groupByComposeProject", () => {
  function makeContainer(overrides: Partial<Container>): Container {
    return {
      id: "id",
      names: "name",
      image: "image",
      command: "cmd",
      state: "running",
      status: "Up",
      ports: "",
      portLinks: [],
      createdAt: "",
      runningFor: "",
      composeProject: null,
      composeService: null,
      composeWorkingDir: null,
      composeConfigFiles: [],
      kubernetes: null,
      ...overrides,
    };
  }

  it("groups containers under their compose project, preserving order", () => {
    const containers = [
      makeContainer({ id: "1", composeProject: "myapp" }),
      makeContainer({ id: "2", composeProject: null }),
      makeContainer({ id: "3", composeProject: "myapp" }),
      makeContainer({ id: "4", composeProject: "other" }),
    ];

    const groups = groupByComposeProject(containers);

    expect(groups.map((g) => g.project)).toEqual(["myapp", null, "other"]);
    expect(groups[0].containers.map((c) => c.id)).toEqual(["1", "3"]);
    expect(groups[1].containers.map((c) => c.id)).toEqual(["2"]);
    expect(groups[2].containers.map((c) => c.id)).toEqual(["4"]);
  });

  it("returns empty array for no containers", () => {
    expect(groupByComposeProject([])).toEqual([]);
  });

  it("puts all standalone containers into a single null group", () => {
    const containers = [
      makeContainer({ id: "1" }),
      makeContainer({ id: "2" }),
    ];
    const groups = groupByComposeProject(containers);
    expect(groups).toHaveLength(1);
    expect(groups[0].project).toBeNull();
    expect(groups[0].containers).toHaveLength(2);
  });

  it("excludes Kubernetes-managed containers even if they carry a compose label", () => {
    const containers = [
      makeContainer({ id: "1", composeProject: "myapp" }),
      makeContainer({
        id: "2",
        composeProject: "myapp",
        kubernetes: { namespace: "default", pod: "api-abcde", container: "api" },
      }),
    ];
    const groups = groupByComposeProject(containers);
    expect(groups).toHaveLength(1);
    expect(groups[0].containers.map((c) => c.id)).toEqual(["1"]);
  });
});
