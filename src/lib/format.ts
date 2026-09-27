// Pure formatting/grouping helpers. Kept dependency-free and unit-testable.
import type { Container } from "./types";

/** Format a byte count as a human-readable size (binary units, e.g. "1.5 GiB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  const decimals = exponent === 0 ? 0 : value < 10 ? 2 : 1;
  return `${value.toFixed(decimals)} ${units[exponent]}`;
}

/** Format a millisecond duration (or an ISO timestamp) as a short relative age, e.g. "5m", "3h", "2d". */
export function relativeAge(input: string | number | Date, now: number = Date.now()): string {
  const then = typeof input === "number" ? input : new Date(input).getTime();
  if (!Number.isFinite(then)) return "?";
  const diffMs = Math.max(0, now - then);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 365) return `${day}d`;
  const yr = Math.floor(day / 365);
  return `${yr}y`;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z0-9]*(?:;[a-zA-Z0-9]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><~])/g;

/** Strip ANSI escape sequences (colors, cursor movement) from a line of text. */
export function stripAnsi(input: string): string {
  if (!input) return input;
  return input.replace(ANSI_PATTERN, "");
}

/** Decode a base64 string (as emitted by `terminal-output`) into raw bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  if (!base64) return new Uint8Array(0);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/**
 * Resolve a user theme preference ("system" | "light" | "dark") to the
 * concrete theme that should be applied, given whether the OS prefers dark.
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return systemPrefersDark ? "dark" : "light";
}

export interface ComposeGroup {
  project: string | null; // null = ungrouped ("standalone" containers)
  containers: Container[];
}

/**
 * Group containers by their compose project label, preserving first-seen
 * order of both groups and containers within a group. Containers without a
 * compose project are collected into a single `project: null` group.
 */
export function groupByComposeProject(containers: Container[]): ComposeGroup[] {
  const order: (string | null)[] = [];
  const groups = new Map<string | null, Container[]>();

  for (const c of containers) {
    const key = c.composeProject ?? null;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(c);
  }

  return order.map((project) => ({ project, containers: groups.get(project)! }));
}
