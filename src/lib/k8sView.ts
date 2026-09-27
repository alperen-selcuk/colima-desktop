// Pure view helpers for the Kubernetes page (§6.6). Kept dependency-free and
// unit-testable: usage-bar percentage selection (limit -> request -> node
// allocatable) and color thresholds, millicore/byte formatting for tooltips,
// ingress URL building, and the kube-system/deployment "type to confirm"
// delete rule.
import type { K8sIngress, K8sIngressRule, K8sKind } from "./types";

// ---------------------------------------------------------------------------
// Usage bars: which denominator to use, and the resulting percentage.
// ---------------------------------------------------------------------------

export type UsageBasis = "limit" | "request" | "allocatable";

export interface UsageResult {
  /** null when there is no denominator at all (limit, request, and
   * allocatable all missing/null) -> render "—", not a bar. */
  percent: number | null;
  basis: UsageBasis | null;
  denominator: number | null;
}

/**
 * Pick the denominator per §6.6: "percentage of limit, else request, else
 * node allocatable". `usedValue` is the live metrics value (cpuMilli or
 * memBytes); the three candidate denominators are in the same unit.
 */
export function selectUsage(
  usedValue: number | null,
  limit: number | null,
  request: number | null,
  allocatable: number | null,
): UsageResult {
  if (usedValue == null) return { percent: null, basis: null, denominator: null };

  let basis: UsageBasis | null = null;
  let denominator: number | null = null;
  if (limit != null && limit > 0) {
    basis = "limit";
    denominator = limit;
  } else if (request != null && request > 0) {
    basis = "request";
    denominator = request;
  } else if (allocatable != null && allocatable > 0) {
    basis = "allocatable";
    denominator = allocatable;
  }

  if (basis == null || denominator == null) return { percent: null, basis: null, denominator: null };

  const percent = (usedValue / denominator) * 100;
  return { percent, basis, denominator };
}

export type UsageTone = "good" | "warn" | "bad";

/** §6.6 thresholds: green < 60%, amber < 85%, red >= 85%. */
export function usageTone(percent: number): UsageTone {
  if (percent >= 85) return "bad";
  if (percent >= 60) return "warn";
  return "good";
}

// ---------------------------------------------------------------------------
// Formatting for usage-bar tooltips
// ---------------------------------------------------------------------------

/** Format millicores for display: values >= 1000m are shown as whole/fractional
 * cores (e.g. "1.5" not "1500m"), matching kubectl's own convention loosely
 * while staying compact for a tooltip. */
export function formatMillicores(milli: number): string {
  if (!Number.isFinite(milli)) return "?";
  if (milli < 1000) return `${Math.round(milli)}m`;
  const cores = milli / 1000;
  return `${cores % 1 === 0 ? cores.toFixed(0) : cores.toFixed(1)}`;
}

/** Format a byte count using binary units (MiB/GiB) for compact tooltips
 * (e.g. §6.6's "180 MiB / 256 MiB"): whole numbers show no decimals, other
 * values show up to 2 significant decimals with trailing zeros trimmed. */
export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  const decimals = exponent === 0 ? 0 : value < 10 ? 2 : 1;
  const rounded = Number(value.toFixed(decimals));
  return `${rounded} ${units[exponent]}`;
}

const BASIS_LABEL: Record<UsageBasis, string> = {
  limit: "limit",
  request: "request",
  allocatable: "node allocatable",
};

/** Build the exact-values tooltip text, e.g. "120m / 500m limit" or
 * "180 MiB / 256 MiB node allocatable". */
export function usageTooltip(
  usedValue: number,
  result: UsageResult,
  kind: "cpu" | "memory",
): string {
  const fmt = kind === "cpu" ? formatMillicores : formatBytesShort;
  const usedStr = kind === "cpu" ? `${formatMillicores(usedValue)}${usedValue < 1000 ? "" : " cores"}` : fmt(usedValue);
  if (result.denominator == null || result.basis == null) return usedStr;
  const denomStr = fmt(result.denominator);
  return `${usedStr} / ${denomStr} ${BASIS_LABEL[result.basis]}`;
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

/** Build the clickable URL for an ingress host: https when the ingress has
 * TLS configured, http otherwise. `host` may be empty/null for a
 * default-backend rule, in which case there's nothing to link. */
export function ingressHostUrl(host: string | null, tls: boolean): string | null {
  if (!host) return null;
  const scheme = tls ? "https" : "http";
  return `${scheme}://${host}`;
}

/** All distinct hosts referenced across an ingress's rules (falls back to
 * the ingress's own `hosts` field, deduped, dropping empties). */
export function ingressAllHosts(ingress: Pick<K8sIngress, "hosts" | "rules">): string[] {
  const set = new Set<string>();
  for (const h of ingress.hosts) if (h) set.add(h);
  for (const r of ingress.rules) if (r.host) set.add(r.host);
  return Array.from(set);
}

/** Render a single ingress rule's backend + path as a compact one-liner. */
export function formatIngressRule(rule: K8sIngressRule): string {
  const host = rule.host ?? "*";
  const path = rule.path || "/";
  return `${host}${path} -> ${rule.backend}`;
}

// ---------------------------------------------------------------------------
// Delete confirmation rule (§6.6): "delete confirm requires typing the name
// for deployments and for anything in kube-system"
// ---------------------------------------------------------------------------

/** Whether deleting this object requires the user to type its name to
 * confirm (as opposed to a plain confirm button): true for every deployment
 * regardless of namespace, and for any namespaced object in `kube-system`. */
export function requiresTypedDeleteConfirm(kind: K8sKind, namespace: string | null): boolean {
  if (kind === "deployment") return true;
  if (namespace === "kube-system") return true;
  return false;
}
