// Pure helpers that turn colima's streamed log lines into a human "phase"
// ("Starting VM", "Starting Docker", …) and track the lifecycle operation that
// is currently running per profile. No React, no Tauri: unit-tested.
import type { OpEnd, OpLog } from "./types";

export interface ActiveOp {
  profile: string;
  op: string;
  /** Human phase, e.g. "Starting Docker". */
  phase: string;
  /** colima announced a k3s runtime (`runtime: docker+k3s`) or ran a kubernetes step. */
  kubernetes: boolean;
  startedAt: number;
  lastActivity: number;
}

export type OpsState = Record<string, ActiveOp>;

const LIFECYCLE = new Set([
  "start",
  "stop",
  "restart",
  "delete",
  "k8s-start",
  "k8s-stop",
  "k8s-reset",
  "k8s-delete",
]);

/** Ops that change a machine's lifecycle (others, like image pulls, are not tracked here). */
export function isLifecycleOp(op: string): boolean {
  return LIFECYCLE.has(op);
}

/** Phase shown before colima has printed anything useful. */
export function initialPhase(op: string): string {
  switch (op) {
    case "stop":
      return "Stopping";
    case "restart":
      return "Restarting";
    case "delete":
      return "Deleting";
    case "k8s-start":
      return "Starting Kubernetes";
    case "k8s-stop":
      return "Stopping Kubernetes";
    case "k8s-reset":
      return "Resetting Kubernetes";
    case "k8s-delete":
      return "Removing Kubernetes";
    default:
      return "Starting";
  }
}

/** `msg="..."` value of a logfmt line, or the raw line when there is none. */
function messageOf(line: string): string {
  const m = /msg="((?:[^"\\]|\\.)*)"/.exec(line);
  return (m ? m[1] : line).toLowerCase();
}

function contextOf(line: string): string | null {
  const m = /\bcontext=("?)([\w.-]+)\1/.exec(line);
  return m ? m[2].toLowerCase() : null;
}

/** Does this line announce a k3s/kubernetes runtime or step? */
export function sawKubernetes(line: string): boolean {
  const msg = messageOf(line);
  if (msg.startsWith("runtime:") && msg.includes("k3s")) return true;
  return contextOf(line) === "kubernetes";
}

/**
 * Map one colima output line to a phase label, or `null` when the line says
 * nothing about progress (so the previous phase is kept).
 */
export function parsePhase(line: string, _op = "start"): string | null {
  void _op;
  const msg = messageOf(line);
  const ctx = contextOf(line);
  if (msg === "done" || msg.startsWith("done ")) return "Done";
  if (msg.includes("updating config") || msg.includes("updating kubeconfig")) return "Updating kubeconfig";
  if (msg.startsWith("stopping")) return ctx === "kubernetes" ? "Stopping Kubernetes" : "Stopping";
  if (msg.startsWith("deleting")) return "Deleting";
  if (msg.startsWith("starting colima")) return "Starting VM";
  if (msg.startsWith("runtime:")) return "Preparing";
  if (ctx === "kubernetes") return "Starting Kubernetes";
  if (ctx === "docker" || ctx === "containerd" || ctx === "incus") {
    return `Starting ${ctx === "docker" ? "Docker" : ctx === "containerd" ? "containerd" : "Incus"}`;
  }
  if (ctx === "vm" || msg.startsWith("creating and starting") || msg.includes("starting vm")) {
    return "Starting VM";
  }
  if (msg.startsWith("provisioning") || msg.startsWith("starting")) return "Provisioning";
  return null;
}

export function applyOpLog(state: OpsState, log: OpLog, now: number): OpsState {
  if (!isLifecycleOp(log.op)) return state;
  const prev = state[log.profile];
  const base: ActiveOp =
    prev && prev.op === log.op
      ? prev
      : {
          profile: log.profile,
          op: log.op,
          phase: initialPhase(log.op),
          kubernetes: log.op.startsWith("k8s-"),
          startedAt: now,
          lastActivity: now,
        };
  const phase = parsePhase(log.line, log.op);
  return {
    ...state,
    [log.profile]: {
      ...base,
      phase: phase ?? base.phase,
      kubernetes: base.kubernetes || sawKubernetes(log.line),
      lastActivity: now,
    },
  };
}

/** Removes the finished op and returns it (when it was the tracked one). */
export function applyOpEnd(
  state: OpsState,
  end: OpEnd,
): { state: OpsState; finished: ActiveOp | null } {
  if (!isLifecycleOp(end.op)) return { state, finished: null };
  const current = state[end.profile];
  const finished = current && current.op === end.op ? current : null;
  if (!finished) return { state, finished: null };
  const next = { ...state };
  delete next[end.profile];
  return { state: next, finished };
}

/** Drops ops the backend no longer reports as busy once they've been quiet for `graceMs`. */
export function pruneStale(state: OpsState, busyProfiles: string[], now: number, graceMs = 6000): OpsState {
  let changed = false;
  const next: OpsState = {};
  for (const [profile, op] of Object.entries(state)) {
    if (!busyProfiles.includes(profile) && now - op.lastActivity > graceMs) {
      changed = true;
      continue;
    }
    next[profile] = op;
  }
  return changed ? next : state;
}

export interface Completion {
  /** `null` when the op doesn't deserve a toast (e.g. a plain stop, which callers already announce). */
  title: string | null;
  detail?: string;
  /** Show an "Open Kubernetes" action. */
  openKubernetes: boolean;
}

/** Success toast content for a finished op. Only start/restart/k8s-start get one. */
export function completionMessage(op: ActiveOp): Completion {
  if (op.op === "start" || op.op === "restart") {
    return op.kubernetes
      ? { title: `${op.profile} is running · Kubernetes ready`, openKubernetes: true }
      : { title: `${op.profile} is running`, openKubernetes: false };
  }
  if (op.op === "k8s-start") {
    return { title: `Kubernetes is ready on ${op.profile}`, openKubernetes: true };
  }
  return { title: null, openKubernetes: false };
}

/** Short label for the global indicator, e.g. "default · Starting Docker". */
export function opLabel(op: ActiveOp): string {
  return `${op.profile} · ${op.phase}`;
}

/** Most recently started op (for the single-slot status bar / top bar). */
export function latestOp(state: OpsState): ActiveOp | null {
  const all = Object.values(state);
  if (all.length === 0) return null;
  return all.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a));
}
