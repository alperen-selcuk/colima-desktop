// Pure helpers for VM disk rules (docs/SPEC.md §6.4). Lima/colima cannot
// shrink a VM disk, so a smaller `disk:` on an existing machine is an error.
import { formatBytes } from "./format";

/** True when `configuredGiB` is smaller than the existing disk (tolerates 2-decimal rounding). */
export function isDiskShrink(configuredGiB: number, currentGiB: number | null | undefined): boolean {
  if (currentGiB == null || !Number.isFinite(configuredGiB)) return false;
  return configuredGiB + 0.01 < currentGiB;
}

export function formatGiB(gib: number): string {
  return `${Number.isInteger(gib) ? gib : gib.toFixed(2)} GiB`;
}

export function shrinkMessage(currentGiB: number): string {
  return `A VM disk can't be shrunk (current size ${Number.isInteger(currentGiB) ? currentGiB : currentGiB.toFixed(2)} GiB). Recreate the machine to use a smaller disk.`;
}

/** Toast text after a reclaim run, from used-on-host bytes before/after. */
export function reclaimResultMessage(before: number | null, after: number | null): string {
  if (before == null || after == null) return "Reclaim finished";
  const freed = before - after;
  const MIN = 50 * 1024 * 1024; // below ~50 MiB counts as "no change"
  if (freed < MIN) {
    return "Space inside the VM was freed, but the disk file on your Mac didn't shrink";
  }
  return `Freed ${formatBytes(freed)} on your Mac`;
}
