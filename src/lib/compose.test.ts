import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSE_PROJECT_NAME_PATTERN,
  defaultProjectNameForFile,
  isValidComposeProjectName,
  parentDirName,
  readRecentComposeFiles,
  recordRecentComposeFile,
  sanitizeComposeProjectName,
} from "./compose";
import { installMemoryLocalStorage } from "./testUtils/memoryLocalStorage";

// This project has no jsdom/happy-dom test environment configured (vitest
// runs in plain Node), so `window`/`localStorage` don't exist by default —
// install a minimal in-memory stand-in just for the localStorage-backed
// helpers under test here, rather than pulling in a DOM environment
// dependency for the whole suite.
beforeAll(() => {
  installMemoryLocalStorage();
});

describe("isValidComposeProjectName / COMPOSE_PROJECT_NAME_PATTERN", () => {
  it("accepts lowercase alnum start, then alnum/underscore/hyphen", () => {
    expect(isValidComposeProjectName("myapp")).toBe(true);
    expect(isValidComposeProjectName("my-app_2")).toBe(true);
    expect(isValidComposeProjectName("9lives")).toBe(true);
  });

  it("rejects uppercase, leading hyphen/underscore, empty, and spaces", () => {
    expect(isValidComposeProjectName("MyApp")).toBe(false);
    expect(isValidComposeProjectName("-myapp")).toBe(false);
    expect(isValidComposeProjectName("_myapp")).toBe(false);
    expect(isValidComposeProjectName("")).toBe(false);
    expect(isValidComposeProjectName("my app")).toBe(false);
  });

  it("pattern is anchored (no partial match)", () => {
    expect(COMPOSE_PROJECT_NAME_PATTERN.test("myapp\nx")).toBe(false);
  });
});

describe("sanitizeComposeProjectName", () => {
  it("lowercases", () => {
    expect(sanitizeComposeProjectName("MyApp")).toBe("myapp");
  });

  it("collapses invalid characters into hyphens", () => {
    expect(sanitizeComposeProjectName("my app!!v2")).toBe("my-app-v2");
  });

  it("trims a leading non-alnum run", () => {
    expect(sanitizeComposeProjectName("---my-app")).toBe("my-app");
  });

  it("trims a trailing hyphen run", () => {
    expect(sanitizeComposeProjectName("my-app---")).toBe("my-app");
  });

  it("falls back to 'project' when nothing usable remains", () => {
    expect(sanitizeComposeProjectName("!!!")).toBe("project");
    expect(sanitizeComposeProjectName("")).toBe("project");
  });

  it("always produces a name matching the validator", () => {
    for (const input of ["MyApp 2.0!", "___", "a", "Ünïcödé App"]) {
      expect(isValidComposeProjectName(sanitizeComposeProjectName(input))).toBe(true);
    }
  });
});

describe("parentDirName", () => {
  it("returns the directory containing the file", () => {
    expect(parentDirName("/Users/dev/projects/myapp/docker-compose.yml")).toBe("myapp");
  });

  it("handles a trailing slash gracefully", () => {
    expect(parentDirName("/Users/dev/projects/myapp/docker-compose.yml/")).toBe("myapp");
  });

  it("returns empty string when there's no parent directory", () => {
    expect(parentDirName("docker-compose.yml")).toBe("");
    expect(parentDirName("")).toBe("");
  });
});

describe("defaultProjectNameForFile", () => {
  it("derives a valid project name from the parent directory", () => {
    expect(defaultProjectNameForFile("/Users/dev/projects/My App/docker-compose.yml")).toBe("my-app");
  });

  it("falls back to 'project' with no usable parent directory", () => {
    expect(defaultProjectNameForFile("docker-compose.yml")).toBe("project");
  });
});

describe("recent compose files (localStorage)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns an empty list initially", () => {
    expect(readRecentComposeFiles()).toEqual([]);
  });

  it("records a file at the front of the list", () => {
    const list = recordRecentComposeFile("/a/docker-compose.yml", () => "2026-01-01T00:00:00.000Z");
    expect(list).toEqual([{ path: "/a/docker-compose.yml", lastUsed: "2026-01-01T00:00:00.000Z" }]);
    expect(readRecentComposeFiles()).toEqual(list);
  });

  it("moves a re-used file back to the front instead of duplicating it", () => {
    recordRecentComposeFile("/a/docker-compose.yml", () => "2026-01-01T00:00:00.000Z");
    recordRecentComposeFile("/b/docker-compose.yml", () => "2026-01-02T00:00:00.000Z");
    const list = recordRecentComposeFile("/a/docker-compose.yml", () => "2026-01-03T00:00:00.000Z");
    expect(list.map((e) => e.path)).toEqual(["/a/docker-compose.yml", "/b/docker-compose.yml"]);
  });

  it("caps the list at 8 entries", () => {
    for (let i = 0; i < 10; i++) {
      recordRecentComposeFile(`/proj${i}/docker-compose.yml`, () => `2026-01-0${(i % 9) + 1}T00:00:00.000Z`);
    }
    expect(readRecentComposeFiles()).toHaveLength(8);
    expect(readRecentComposeFiles()[0].path).toBe("/proj9/docker-compose.yml");
  });

  it("recovers gracefully from corrupted storage", () => {
    window.localStorage.setItem("colima-desktop.composeRecentFiles", "{not json");
    expect(readRecentComposeFiles()).toEqual([]);
  });
});
