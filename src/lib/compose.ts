// Pure helpers for the Compose Up dialog (§6.7): project-name derivation/
// sanitisation and the "recent compose files" localStorage list. Kept
// dependency-free and unit-testable; the dialog component wraps these with
// the actual `@tauri-apps/plugin-dialog` file picker and `compose_preview`
// IPC call.

const RECENT_KEY = "colima-desktop.composeRecentFiles";
const MAX_RECENT = 8;

/** Project name validation, matching Docker Compose's own rule: lowercase
 * start with a letter or digit, then letters/digits/underscore/hyphen. */
export const COMPOSE_PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidComposeProjectName(name: string): boolean {
  return COMPOSE_PROJECT_NAME_PATTERN.test(name);
}

/** Sanitises an arbitrary string (typically a directory name) into a valid
 * compose project name: lowercase, replace runs of anything outside
 * [a-z0-9_-] with a single hyphen, trim leading characters that aren't
 * letters/digits, and fall back to "project" if nothing usable remains. */
export function sanitizeComposeProjectName(input: string): string {
  const lowered = (input || "").toLowerCase();
  const collapsed = lowered.replace(/[^a-z0-9_-]+/g, "-");
  const trimmedLeading = collapsed.replace(/^[^a-z0-9]+/, "");
  const trimmedTrailing = trimmedLeading.replace(/-+$/, "");
  return trimmedTrailing || "project";
}

/** The parent directory name of a compose file path (POSIX-style; Tauri's
 * file picker returns forward-slash paths on both macOS and Linux), used as
 * the default project name per §6.7 ("project name default = parent
 * directory name lowercased/sanitised"). */
export function parentDirName(filePath: string): string {
  if (!filePath) return "";
  const normalized = filePath.replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  // Drop the file name itself; the parent directory is the segment before it.
  return segments.length >= 2 ? segments[segments.length - 2] : "";
}

/** Combines `parentDirName` + `sanitizeComposeProjectName` into the default
 * project name shown (and editable) in the Compose Up dialog. */
export function defaultProjectNameForFile(filePath: string): string {
  return sanitizeComposeProjectName(parentDirName(filePath));
}

export interface RecentComposeFile {
  path: string;
  lastUsed: string; // ISO timestamp
}

/** Reads the persisted "recent compose files" list (most-recent first),
 * silently returning an empty list on any storage error (private mode,
 * corrupted JSON, quota, ...). */
export function readRecentComposeFiles(): RecentComposeFile[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentComposeFile => e && typeof e.path === "string" && typeof e.lastUsed === "string",
    );
  } catch {
    return [];
  }
}

function writeRecentComposeFiles(list: RecentComposeFile[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // ignore (private mode, quota, ...)
  }
}

/** Moves `path` to the front of the recent list (deduping), caps it at
 * `MAX_RECENT` entries, persists it, and returns the new list. */
export function recordRecentComposeFile(path: string, now: () => string = () => new Date().toISOString()): RecentComposeFile[] {
  const existing = readRecentComposeFiles().filter((e) => e.path !== path);
  const next = [{ path, lastUsed: now() }, ...existing].slice(0, MAX_RECENT);
  writeRecentComposeFiles(next);
  return next;
}
