// Pure helpers for the Volumes page (bug fix: sizes showing "—", "Prune
// unused" never removing named volumes — see docs/SPEC.md §3/§4). Kept
// dependency-free and unit-testable, same pattern as `containerSummary.ts`.
import type { Volume } from "./types";

/** Format a byte count using docker's own decimal (SI, 1000-based) units —
 * matches the `size`/`sizeBytes` docker itself reports for volumes (`docker
 * system df -v`), unlike `formatBytes` in `format.ts`, which uses binary
 * (1024-based) units for `docker stats`. Used for the totals/stat tiles so
 * they read consistently with the per-row `size` docker already gives us. */
export function formatSizeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0B";
  if (bytes === 0) return "0B";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
  const value = bytes / Math.pow(1000, exponent);
  const decimals = exponent === 0 ? 0 : value < 10 ? 2 : 1;
  return `${value.toFixed(decimals)}${units[exponent]}`;
}

export type VolumeSortKey = "name" | "size" | "created";

/** Sorts volumes by name (locale-aware), size (bytes, unknown last) or
 * created date (newest first, unknown last). Returns a new array; never
 * mutates the input. */
export function sortVolumes(volumes: Volume[], key: VolumeSortKey): Volume[] {
  const copy = [...volumes];
  switch (key) {
    case "name":
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    case "size":
      return copy.sort((a, b) => {
        if (a.sizeBytes == null && b.sizeBytes == null) return 0;
        if (a.sizeBytes == null) return 1;
        if (b.sizeBytes == null) return -1;
        return b.sizeBytes - a.sizeBytes;
      });
    case "created":
      return copy.sort((a, b) => {
        const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
        const bt = b.createdAt ? Date.parse(b.createdAt) : NaN;
        if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
        if (Number.isNaN(at)) return 1;
        if (Number.isNaN(bt)) return -1;
        return bt - at;
      });
  }
}

export type PruneScope = "anonymous" | "all";

export interface VolumePrunePreview {
  volumes: Volume[];
  totalBytes: number; // sum of known sizeBytes among previewed volumes
  unknownSizeCount: number; // volumes in the preview whose size is unknown
  namedCount: number; // non-anonymous volumes in the preview (data-loss warning applies to these)
}

/** Computes exactly which volumes a prune with the given scope would
 * remove, from the current in-memory list — mirrors the backend's actual
 * selection (`docker volume prune [-a] -f`): every UNUSED volume, and for
 * `"anonymous"` scope, further restricted to ones with the
 * `com.docker.volume.anonymous` label. Used to preview the prune dialog
 * before the user confirms, and returns an empty list when there is
 * nothing to prune (callers should disable the confirm button in that
 * case). */
export function computePrunePreview(volumes: Volume[], scope: PruneScope): VolumePrunePreview {
  const candidates = volumes.filter((v) => !v.inUse && (scope === "all" || v.anonymous));
  let totalBytes = 0;
  let unknownSizeCount = 0;
  let namedCount = 0;
  for (const v of candidates) {
    if (v.sizeBytes != null) totalBytes += v.sizeBytes;
    else unknownSizeCount++;
    if (!v.anonymous) namedCount++;
  }
  return { volumes: candidates, totalBytes, unknownSizeCount, namedCount };
}

/** Sum of `sizeBytes` across volumes whose size is known (unknown sizes are
 * simply excluded from the total, not treated as zero — used for the
 * "reclaimable" stat tile). */
export function totalReclaimableBytes(volumes: Volume[]): number {
  return volumes.filter((v) => !v.inUse).reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0);
}

/** Short label for the "Source" column: the volume's compose project if
 * set, else "named" for a plain user/compose-less named volume, else
 * "anonymous". */
export function volumeSourceLabel(v: Volume): string {
  if (v.composeProject) return v.composeProject;
  if (v.anonymous) return "anonymous";
  return "named";
}
