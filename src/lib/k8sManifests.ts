// Pure manifest builders + validators for the Kubernetes "Create" forms (§6.10).
// No React, no I/O: every function maps form values to YAML text (or an error list).
import { stringify } from "yaml";

export type CreatableKind = "pod" | "deployment" | "service" | "ingress" | "statefulset" | "daemonset";
export type ServiceType = "ClusterIP" | "NodePort" | "LoadBalancer";

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;

export const NODE_PORT_MIN = 30000;
export const NODE_PORT_MAX = 32767;

/** Parse a form string to an integer; null when blank or not an integer. */
export function parseIntStrict(s: string): number | null {
  const t = s.trim();
  if (!/^-?\d+$/.test(t)) return null;
  return Number(t);
}

/** RFC 1123 label (<= 63 chars). Returns an error message or null. */
export function validateName(name: string, label = "Name"): string | null {
  if (!name) return `${label} is required`;
  if (name.length > 63) return `${label} must be at most 63 characters`;
  if (!DNS_LABEL.test(name)) return `${label} must be lowercase letters, digits or '-', starting and ending with a letter or digit`;
  return null;
}

/** 1–65535. `required` false lets blank pass. */
export function validatePort(value: number | null, label: string, required = true): string | null {
  if (value == null) return required ? `${label} is required` : null;
  if (!Number.isInteger(value) || value < 1 || value > 65535) return `${label} must be between 1 and 65535`;
  return null;
}

export function validateNodePort(value: number | null): string | null {
  if (value == null) return null; // optional: the cluster picks one
  if (!Number.isInteger(value) || value < NODE_PORT_MIN || value > NODE_PORT_MAX) {
    return `NodePort must be between ${NODE_PORT_MIN} and ${NODE_PORT_MAX}`;
  }
  return null;
}

export function validateReplicas(value: number | null): string | null {
  if (value == null) return "Replicas is required";
  if (!Number.isInteger(value) || value < 0 || value > 1000) return "Replicas must be between 0 and 1000";
  return null;
}

export function validateImage(image: string): string | null {
  if (!image.trim()) return "Image is required";
  if (/\s/.test(image.trim())) return "Image must not contain spaces";
  return null;
}

const compact = (errs: (string | null)[]): string[] => errs.filter((e): e is string => e != null);

function toYaml(doc: unknown): string {
  return stringify(doc, { lineWidth: 0 });
}

function containerPorts(port: number | null) {
  return port != null ? { ports: [{ containerPort: port }] } : {};
}

// ---------------------------------------------------------------------------
// Pod
// ---------------------------------------------------------------------------

export interface PodInput {
  name: string;
  namespace: string;
  image: string;
  containerPort: number | null;
  env?: { key: string; value: string }[];
}

export function validatePod(i: PodInput): string[] {
  const env = (i.env ?? []).filter((e) => e.key.trim() !== "" || e.value !== "");
  return compact([
    validateName(i.name),
    validateImage(i.image),
    validatePort(i.containerPort, "Container port", false),
    ...env.map((e) => (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(e.key.trim()) ? null : `Invalid env var name "${e.key}"`)),
  ]);
}

export function buildPod(i: PodInput): string {
  const env = (i.env ?? []).filter((e) => e.key.trim() !== "").map((e) => ({ name: e.key.trim(), value: e.value }));
  return toYaml({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: i.name, namespace: i.namespace, labels: { app: i.name } },
    spec: {
      containers: [
        { name: i.name, image: i.image.trim(), ...containerPorts(i.containerPort), ...(env.length ? { env } : {}) },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

export interface DeploymentInput {
  name: string;
  namespace: string;
  image: string;
  replicas: number | null;
  containerPort: number | null;
}

export function validateDeployment(i: DeploymentInput): string[] {
  return compact([
    validateName(i.name),
    validateImage(i.image),
    validateReplicas(i.replicas),
    validatePort(i.containerPort, "Container port", false),
  ]);
}

export function buildDeployment(i: DeploymentInput): string {
  const labels = { app: i.name };
  return toYaml({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: i.name, namespace: i.namespace, labels },
    spec: {
      replicas: i.replicas ?? 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: { containers: [{ name: i.name, image: i.image.trim(), ...containerPorts(i.containerPort) }] },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// DaemonSet
// ---------------------------------------------------------------------------

export interface DaemonSetInput {
  name: string;
  namespace: string;
  image: string;
  containerPort: number | null;
}

export function validateDaemonSet(i: DaemonSetInput): string[] {
  return compact([validateName(i.name), validateImage(i.image), validatePort(i.containerPort, "Container port", false)]);
}

export function buildDaemonSet(i: DaemonSetInput): string {
  const labels = { app: i.name };
  return toYaml({
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name: i.name, namespace: i.namespace, labels },
    spec: {
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: { containers: [{ name: i.name, image: i.image.trim(), ...containerPorts(i.containerPort) }] },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// StatefulSet (+ optional headless Service, created as a separate object)
// ---------------------------------------------------------------------------

export interface StatefulSetInput {
  name: string;
  namespace: string;
  image: string;
  replicas: number | null;
  containerPort: number | null;
  headlessService: boolean;
  /** e.g. "1Gi"; blank = no volumeClaimTemplates. */
  storageSize: string;
}

const STORAGE_RE = /^[1-9][0-9]*(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/;

export function validateStatefulSet(i: StatefulSetInput): string[] {
  return compact([
    validateName(i.name),
    validateImage(i.image),
    validateReplicas(i.replicas),
    validatePort(i.containerPort, "Container port", i.headlessService),
    i.storageSize.trim() && !STORAGE_RE.test(i.storageSize.trim()) ? `Storage size "${i.storageSize}" is invalid (e.g. 1Gi)` : null,
  ]);
}

export function buildStatefulSet(i: StatefulSetInput): string {
  const labels = { app: i.name };
  const storage = i.storageSize.trim();
  return toYaml({
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name: i.name, namespace: i.namespace, labels },
    spec: {
      serviceName: i.name,
      replicas: i.replicas ?? 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: i.name,
              image: i.image.trim(),
              ...containerPorts(i.containerPort),
              ...(storage ? { volumeMounts: [{ name: "data", mountPath: "/data" }] } : {}),
            },
          ],
        },
      },
      ...(storage
        ? {
            volumeClaimTemplates: [
              {
                metadata: { name: "data" },
                spec: {
                  accessModes: ["ReadWriteOnce"],
                  storageClassName: "local-path",
                  resources: { requests: { storage } },
                },
              },
            ],
          }
        : {}),
    },
  });
}

/** The headless Service a StatefulSet's `serviceName` points at. */
export function buildHeadlessService(i: Pick<StatefulSetInput, "name" | "namespace" | "containerPort">): string {
  return toYaml({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: i.name, namespace: i.namespace, labels: { app: i.name } },
    spec: {
      clusterIP: "None",
      selector: { app: i.name },
      ports: [{ port: i.containerPort ?? 80, targetPort: i.containerPort ?? 80 }],
    },
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ServiceInput {
  name: string;
  namespace: string;
  type: ServiceType;
  port: number | null;
  targetPort: number | null;
  nodePort: number | null;
  selectorKey: string;
  selectorValue: string;
}

export function validateService(i: ServiceInput): string[] {
  const k = i.selectorKey.trim();
  const v = i.selectorValue.trim();
  return compact([
    validateName(i.name),
    validatePort(i.port, "Port"),
    validatePort(i.targetPort, "Target port"),
    i.type === "NodePort" ? validateNodePort(i.nodePort) : null,
    k === "" && v !== "" ? "Selector key is required" : null,
    k !== "" && !LABEL_KEY.test(k) ? `Selector key "${k}" is invalid` : null,
    v !== "" && !LABEL_VALUE.test(v) ? `Selector value "${v}" is invalid` : null,
  ]);
}

export function buildService(i: ServiceInput): string {
  const k = i.selectorKey.trim();
  const v = i.selectorValue.trim();
  return toYaml({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: i.name, namespace: i.namespace, labels: { app: i.name } },
    spec: {
      type: i.type,
      ...(k ? { selector: { [k]: v } } : {}),
      ports: [
        {
          port: i.port,
          targetPort: i.targetPort,
          protocol: "TCP",
          ...(i.type === "NodePort" && i.nodePort != null ? { nodePort: i.nodePort } : {}),
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

export interface IngressInput {
  name: string;
  namespace: string;
  host: string;
  path: string;
  pathType: "Prefix" | "Exact" | "ImplementationSpecific";
  serviceName: string;
  servicePort: number | null;
  ingressClassName: string;
}

const HOST_RE = /^(\*\.)?[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export function validateIngress(i: IngressInput): string[] {
  const host = i.host.trim();
  return compact([
    validateName(i.name),
    host && !HOST_RE.test(host) ? `Host "${host}" is invalid` : null,
    i.path.startsWith("/") ? null : "Path must start with '/'",
    i.serviceName ? null : "Backend service is required",
    validatePort(i.servicePort, "Service port"),
  ]);
}

export function buildIngress(i: IngressInput): string {
  const host = i.host.trim();
  return toYaml({
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name: i.name, namespace: i.namespace },
    spec: {
      ...(i.ingressClassName ? { ingressClassName: i.ingressClassName } : {}),
      rules: [
        {
          ...(host ? { host } : {}),
          http: {
            paths: [
              {
                path: i.path || "/",
                pathType: i.pathType,
                backend: { service: { name: i.serviceName, port: { number: i.servicePort } } },
              },
            ],
          },
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Service selector suggestions
// ---------------------------------------------------------------------------

export interface LabelSource {
  kind: string; // "deployment" | "statefulset" | "daemonset" | "pod"
  name: string;
  labels: Record<string, string>;
}

export interface SelectorOption {
  key: string;
  value: string;
  label: string;
}

/** Preferred label of an object for a Service selector: `app`, then
 * `app.kubernetes.io/name`, then the first label. Null when it has none. */
export function pickSelectorLabel(labels: Record<string, string>): [string, string] | null {
  for (const k of ["app", "app.kubernetes.io/name"]) {
    if (labels[k] != null) return [k, labels[k]];
  }
  const first = Object.entries(labels)[0];
  return first ?? null;
}

/** One option per distinct key=value, in input order (so list workloads
 * before pods and a pod's inherited label doesn't repeat). */
export function selectorOptions(sources: LabelSource[]): SelectorOption[] {
  const seen = new Set<string>();
  const out: SelectorOption[] = [];
  for (const s of sources) {
    const picked = pickSelectorLabel(s.labels);
    if (!picked) continue;
    const [key, value] = picked;
    const id = `${key}=${value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key, value, label: `${s.kind}/${s.name} · ${id}` });
  }
  return out;
}
