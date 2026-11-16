// Idle auto-stop (§6.11): the limits the UI offers and the one-line state
// shown on a machine card.
import type { AutoStopStatus } from "./types";

/** Must match `ALLOWED_MINUTES` in src-tauri/src/autostop.rs. */
export const AUTOSTOP_MINUTES = [5, 15, 30, 60] as const;

const REASONS: Record<string, string> = {
  kubernetes: "Kubernetes is running",
  containers: "containers are running",
  "docker activity": "Docker is in use",
  "open sessions": "a terminal, log or port-forward is open",
  "cpu load": "the VM is busy",
  "unknown load": "checking…",
  "operation in progress": "an operation is running",
};

/** Card hint for an enabled auto-stop; `null` when there is nothing to say. */
export function autostopHint(status: AutoStopStatus | undefined, running: boolean): string | null {
  if (!running || !status) return null;
  if (status.busyReason === "stopped") return null;
  if (status.busyReason) return `Not idle: ${REASONS[status.busyReason] ?? status.busyReason}`;
  const idleMin = Math.floor(status.idleSeconds / 60);
  return `Idle ${idleMin} min · stops at ${status.minutes} min`;
}
