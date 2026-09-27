// Typed wrapper around a colima.yaml document, built on `yaml` (eemeli/yaml)'s
// `parseDocument` so that comments, key ordering, and keys unknown to this app
// survive edits made through the machine configuration editor (§6.4 of
// docs/SPEC.md). Every setter mutates the underlying `yaml.Document` in place
// via `doc.setIn(path, value)` (or deletes via `doc.deleteIn`), and
// `stringify(doc)` (== `String(doc)`) serializes it back to text.
//
// This module intentionally does not "fully" type the whole colima.yaml
// shape as a TS interface: the document is the source of truth, and we only
// expose typed get/set helpers for the exact keys the dialog edits (per the
// section list in SPEC §6.4), plus generic list/map helpers for env, docker,
// dnsHosts, mounts and provision.

import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from "yaml";

export type ConfigDoc = Document.Parsed;

/** Parse raw colima.yaml text into an editable, comment-preserving document. */
export function parseConfig(content: string): ConfigDoc {
  return parseDocument(content, { keepSourceTokens: false });
}

/** Serialize a document back to YAML text (comments/ordering preserved). */
export function stringifyConfig(doc: ConfigDoc): string {
  return String(doc);
}

/** Deep-clone a document (e.g. to snapshot before an edit for undo/diff). */
export function cloneConfig(doc: ConfigDoc): ConfigDoc {
  return doc.clone() as ConfigDoc;
}

type Path = readonly (string | number)[];

/** Read a plain JS value at `path`, or `fallback` if absent/unparseable. */
export function getIn<T>(doc: ConfigDoc, path: Path, fallback: T): T {
  const value = doc.getIn(path as (string | number)[]);
  if (value === undefined || value === null) return fallback;
  return value as T;
}

/** Set a plain JS scalar/array/object value at `path`, creating intermediate maps as needed. */
export function setIn(doc: ConfigDoc, path: Path, value: unknown): void {
  doc.setIn(path as (string | number)[], value);
}

/** Remove the key at `path` entirely (used when a value should revert to "unset"). */
export function deleteIn(doc: ConfigDoc, path: Path): void {
  doc.deleteIn(path as (string | number)[]);
}

/** Whether a key exists at `path` (distinguishes "unset" from "set to a falsy value"). */
export function hasIn(doc: ConfigDoc, path: Path): boolean {
  return doc.hasIn(path as (string | number)[]);
}

// ---------------------------------------------------------------------------
// List-of-scalars helpers (network.dns, kubernetes.k3sArgs)
// ---------------------------------------------------------------------------

/** Read a list of strings at `path` (e.g. `network.dns`, `kubernetes.k3sArgs`). */
export function getStringList(doc: ConfigDoc, path: Path): string[] {
  const raw = doc.getIn(path as (string | number)[], true);
  if (isSeq(raw)) return (raw.toJSON() as unknown[]).map(String);
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

/** Replace a list of strings at `path`, written as a block sequence for readability. */
export function setStringList(doc: ConfigDoc, path: Path, values: string[]): void {
  const seq = doc.createNode(values) as YAMLSeq;
  seq.flow = false;
  doc.setIn(path as (string | number)[], seq);
}

// ---------------------------------------------------------------------------
// Key-value map helpers (env, network.dnsHosts, docker)
// ---------------------------------------------------------------------------

/** Read a string->string map at `path` (e.g. `env`, `network.dnsHosts`). */
export function getStringMap(doc: ConfigDoc, path: Path): Record<string, string> {
  const raw = doc.getIn(path as (string | number)[], true);
  const out: Record<string, string> = {};
  if (isMap(raw)) {
    const plain = raw.toJSON() as Record<string, unknown> | null;
    for (const [key, value] of Object.entries(plain ?? {})) {
      out[key] = value === null || value === undefined ? "" : String(value);
    }
  }
  return out;
}

/** Replace a string->string map at `path`, written as a block mapping. */
export function setStringMap(doc: ConfigDoc, path: Path, entries: Record<string, string>): void {
  const map = doc.createNode(entries) as YAMLMap;
  map.flow = false;
  doc.setIn(path as (string | number)[], map);
}

/** Read `docker:` (arbitrary daemon.json-shaped map) as a plain JS object. */
export function getDockerConfig(doc: ConfigDoc): Record<string, unknown> {
  const raw = doc.getIn(["docker"], true);
  if (isMap(raw)) return (raw.toJSON() as Record<string, unknown>) ?? {};
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

/** Replace `docker:` from a plain JS object (e.g. parsed from the JSON editor). */
export function setDockerConfig(doc: ConfigDoc, value: Record<string, unknown>): void {
  const map = doc.createNode(value) as YAMLMap;
  map.flow = false;
  doc.setIn(["docker"], map);
}

// ---------------------------------------------------------------------------
// Mounts: list of { location, mountPoint?, writable }
// ---------------------------------------------------------------------------

export interface MountRow {
  location: string;
  mountPoint: string;
  writable: boolean;
}

export function getMounts(doc: ConfigDoc): MountRow[] {
  const raw = doc.getIn(["mounts"], true);
  if (!isSeq(raw)) return [];
  return raw.items.map((item) => {
    const obj = isMap(item) ? ((item.toJSON() as Record<string, unknown>) ?? {}) : {};
    return {
      location: typeof obj.location === "string" ? obj.location : "",
      mountPoint: typeof obj.mountPoint === "string" ? obj.mountPoint : "",
      writable: Boolean(obj.writable),
    };
  });
}

export function setMounts(doc: ConfigDoc, rows: MountRow[]): void {
  const plain = rows.map((r) => {
    const entry: Record<string, unknown> = { location: r.location };
    if (r.mountPoint) entry.mountPoint = r.mountPoint;
    entry.writable = r.writable;
    return entry;
  });
  const seq = doc.createNode(plain) as YAMLSeq;
  seq.flow = false;
  for (const item of seq.items) {
    if (isMap(item)) item.flow = false;
  }
  doc.setIn(["mounts"], seq);
}

// ---------------------------------------------------------------------------
// Provision: list of { mode, script }
// ---------------------------------------------------------------------------

export interface ProvisionRow {
  mode: "system" | "user" | "after-boot" | "ready";
  script: string;
}

export function getProvision(doc: ConfigDoc): ProvisionRow[] {
  const raw = doc.getIn(["provision"], true);
  if (!isSeq(raw)) return [];
  return raw.items.map((item) => {
    const obj = isMap(item) ? ((item.toJSON() as Record<string, unknown>) ?? {}) : {};
    const mode = obj.mode;
    return {
      mode: mode === "user" || mode === "after-boot" || mode === "ready" ? mode : "system",
      script: typeof obj.script === "string" ? obj.script : "",
    };
  });
}

export function setProvision(doc: ConfigDoc, rows: ProvisionRow[]): void {
  const plain = rows.map((r) => ({ mode: r.mode, script: r.script }));
  const seq = doc.createNode(plain) as YAMLSeq;
  seq.flow = false;
  for (const item of seq.items) {
    if (isMap(item)) {
      item.flow = false;
      // Multi-line scripts read far better as a block scalar than a quoted string.
      const scriptPair = item.items.find((p) => String(p.key) === "script");
      if (scriptPair && typeof scriptPair.value === "object" && scriptPair.value && "value" in scriptPair.value) {
        const scalar = scriptPair.value as { type?: string; value: string };
        if (scalar.value.includes("\n")) scalar.type = "BLOCK_LITERAL";
      }
    }
  }
  doc.setIn(["provision"], seq);
}

// ---------------------------------------------------------------------------
// Typed accessors for every field listed in SPEC §6.4, grouped by section.
// Each getter falls back to colima's own documented default when the key is
// absent, so the form always shows a sensible value even for older files
// that predate a given key (e.g. 0.8.1 templates lacking modelRunner/rootDisk/
// portForwarder).
// ---------------------------------------------------------------------------

export interface ResourcesConfig {
  cpu: number;
  memory: number;
  disk: number;
  rootDisk: number;
  cpuType: string;
  arch: string;
  hostname: string;
}

export function getResources(doc: ConfigDoc): ResourcesConfig {
  return {
    cpu: getIn(doc, ["cpu"], 2),
    memory: getIn(doc, ["memory"], 2),
    disk: getIn(doc, ["disk"], 100),
    rootDisk: getIn(doc, ["rootDisk"], 20),
    cpuType: getIn(doc, ["cpuType"], "host"),
    arch: getIn(doc, ["arch"], "host"),
    hostname: getIn<string | null>(doc, ["hostname"], null) ?? "",
  };
}

export interface RuntimeConfig {
  runtime: string;
  autoActivate: boolean;
  modelRunner: string;
}

export function getRuntime(doc: ConfigDoc): RuntimeConfig {
  return {
    runtime: getIn(doc, ["runtime"], "docker"),
    autoActivate: getIn(doc, ["autoActivate"], true),
    modelRunner: getIn(doc, ["modelRunner"], "docker"),
  };
}

export interface KubernetesConfig {
  enabled: boolean;
  version: string;
  k3sArgs: string[];
  port: number;
}

export function getKubernetes(doc: ConfigDoc): KubernetesConfig {
  return {
    enabled: getIn(doc, ["kubernetes", "enabled"], false),
    version: getIn(doc, ["kubernetes", "version"], ""),
    k3sArgs: getStringList(doc, ["kubernetes", "k3sArgs"]),
    port: getIn(doc, ["kubernetes", "port"], 0),
  };
}

export interface VirtualMachineConfig {
  vmType: string;
  rosetta: boolean;
  binfmt: boolean;
  nestedVirtualization: boolean;
  portForwarder: string;
  diskImage: string;
  diskImageMirror: string;
  forceDiskImage: boolean;
}

export function getVirtualMachine(doc: ConfigDoc): VirtualMachineConfig {
  return {
    vmType: getIn(doc, ["vmType"], "qemu"),
    rosetta: getIn(doc, ["rosetta"], false),
    binfmt: getIn(doc, ["binfmt"], true),
    nestedVirtualization: getIn(doc, ["nestedVirtualization"], false),
    portForwarder: getIn(doc, ["portForwarder"], "ssh"),
    diskImage: getIn(doc, ["diskImage"], ""),
    diskImageMirror: getIn(doc, ["diskImageMirror"], ""),
    forceDiskImage: getIn(doc, ["forceDiskImage"], false),
  };
}

export interface NetworkConfig {
  address: boolean;
  mode: string;
  bridgeInterface: string;
  subnet: string;
  preferredRoute: boolean;
  hostAddresses: boolean;
  gatewayAddress: string;
  nat66Prefix: string;
  dns: string[];
  dnsHosts: Record<string, string>;
}

export function getNetwork(doc: ConfigDoc): NetworkConfig {
  return {
    address: getIn(doc, ["network", "address"], false),
    mode: getIn(doc, ["network", "mode"], "shared"),
    bridgeInterface: getIn(doc, ["network", "interface"], "en0"),
    subnet: getIn(doc, ["network", "subnet"], ""),
    preferredRoute: getIn(doc, ["network", "preferredRoute"], false),
    hostAddresses: getIn(doc, ["network", "hostAddresses"], false),
    gatewayAddress: getIn(doc, ["network", "gatewayAddress"], "192.168.5.2"),
    nat66Prefix: getIn<string | null>(doc, ["network", "nat66Prefix"], null) ?? "",
    dns: getStringList(doc, ["network", "dns"]),
    dnsHosts: getStringMap(doc, ["network", "dnsHosts"]),
  };
}

export interface MountsConfig {
  mountType: string;
  mountInotify: boolean;
  mounts: MountRow[];
}

export function getMountsConfig(doc: ConfigDoc): MountsConfig {
  return {
    mountType: getIn(doc, ["mountType"], "sshfs"),
    mountInotify: getIn(doc, ["mountInotify"], false),
    mounts: getMounts(doc),
  };
}

export interface SshConfig {
  sshConfig: boolean;
  sshPort: number;
  forwardAgent: boolean;
}

export function getSsh(doc: ConfigDoc): SshConfig {
  return {
    sshConfig: getIn(doc, ["sshConfig"], true),
    sshPort: getIn(doc, ["sshPort"], 0),
    forwardAgent: getIn(doc, ["forwardAgent"], false),
  };
}

/** Convenience: every section's data in one call, for initializing form state. */
export function getFullConfig(doc: ConfigDoc) {
  return {
    resources: getResources(doc),
    runtime: getRuntime(doc),
    kubernetes: getKubernetes(doc),
    vm: getVirtualMachine(doc),
    network: getNetwork(doc),
    mounts: getMountsConfig(doc),
    ssh: getSsh(doc),
    env: getStringMap(doc, ["env"]),
    docker: getDockerConfig(doc),
    provision: getProvision(doc),
  };
}

export type FullConfig = ReturnType<typeof getFullConfig>;
