// Pure helpers for the k3s version picker (docs/SPEC.md §6.5). Kept
// dependency-free and unit-tested; `K3sVersionPicker.tsx` wires these to
// react-query + the actual combobox UI.
import type { K3sVersion } from "./types";

/** `^v\d+\.\d+\.\d+\+k3s\d+$` — mirrors the backend's `is_valid_k3s_version_format`
 * (src-tauri/src/k3s.rs) exactly, so the frontend can validate without a
 * round-trip for the common case (typing in the combobox). */
export const K3S_VERSION_FORMAT = /^v\d+\.\d+\.\d+\+k3s\d+$/;

export function isValidK3sVersionFormat(version: string): boolean {
  return K3S_VERSION_FORMAT.test(version);
}

/** Whether `version` is a well-formed string that's absent from the known
 * list fetched/cached/built in (a warning, not an error — see §6.5: "a
 * well-formed version not in the known list is a warning"). Malformed input
 * is never "unknown", it's just invalid, so this returns `false` for it too
 * (callers should check `isValidK3sVersionFormat` separately for the error). */
export function isUnknownVersion(version: string, known: K3sVersion[]): boolean {
  if (!version || !isValidK3sVersionFormat(version)) return false;
  return !known.some((v) => v.version === version);
}

export interface GroupedVersions {
  /** colimaDefault, if present in the known list (or even if not — always shown as "Recommended"). */
  recommended: K3sVersion | null;
  /** Newest patch per minor, newest-first. */
  latestPerMinor: K3sVersion[];
  /** Every version, newest-first (used for the "All versions" search-filtered list). */
  all: K3sVersion[];
}

/** Group a flat, newest-first `versions` list into the three picker sections
 * (§6.5): Recommended (colimaDefault), Latest per minor, All versions. */
export function groupVersions(versions: K3sVersion[], colimaDefault: string | null): GroupedVersions {
  const recommended = colimaDefault ? versions.find((v) => v.version === colimaDefault) ?? null : null;
  const latestPerMinor = versions.filter((v) => v.latestInMinor);
  return { recommended, latestPerMinor, all: versions };
}

/** Case-insensitive substring filter over `versions` by their `version`
 * string, used for the "All versions" search box. Empty query returns every
 * version unchanged. */
export function filterVersions(versions: K3sVersion[], query: string): K3sVersion[] {
  const q = query.trim().toLowerCase();
  if (!q) return versions;
  return versions.filter((v) => v.version.toLowerCase().includes(q));
}

/** Flatten the picker's three sections into one keyboard-navigable list, in
 * display order, with no duplicate versions across sections (a version that
 * appears in "Recommended" or "Latest per minor" is skipped from "All" so
 * arrow-key navigation doesn't visit the same version twice). Each entry
 * carries which section header (if any) precedes it, purely for rendering. */
export interface FlatOption {
  version: K3sVersion;
  section: "recommended" | "latestPerMinor" | "all";
}

export function flattenForKeyboardNav(grouped: GroupedVersions, searchQuery: string): FlatOption[] {
  const out: FlatOption[] = [];
  const seen = new Set<string>();

  if (grouped.recommended) {
    out.push({ version: grouped.recommended, section: "recommended" });
    seen.add(grouped.recommended.version);
  }
  for (const v of grouped.latestPerMinor) {
    if (seen.has(v.version)) continue;
    out.push({ version: v, section: "latestPerMinor" });
    seen.add(v.version);
  }
  const filteredAll = filterVersions(grouped.all, searchQuery);
  for (const v of filteredAll) {
    if (seen.has(v.version)) continue;
    out.push({ version: v, section: "all" });
    seen.add(v.version);
  }
  return out;
}

/** Human "updated x ago" string for the picker's freshness note. Pure
 * (takes `now` explicitly) so it's unit-testable without mocking the clock. */
export function updatedAgoLabel(fetchedAt: string | null, now: number = Date.now()): string | null {
  if (!fetchedAt) return null;
  const then = new Date(fetchedAt).getTime();
  if (!Number.isFinite(then)) return null;
  const diffMs = Math.max(0, now - then);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "updated just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `updated ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `updated ${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `updated ${day}d ago`;
}
