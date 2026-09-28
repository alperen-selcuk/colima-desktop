// Pure helpers for the Marketplace page (§6.8): catalog filtering/search,
// category counts, compose service/image/port extraction (for the detail
// drawer), password generation, port-conflict detection, and endpoint
// template rendering. Kept dependency-light (only `yaml`, already a
// dependency for the machine config editor) and unit-tested; the page and
// dialogs wrap these with React state and the actual IPC calls.
import { parse as parseYaml } from "yaml";
import type {
  CatalogItem,
  InstalledApp,
  MarketplaceCategory,
  MarketplaceEndpoint,
  MarketplaceEndpointTemplate,
  MarketplaceVariableType,
} from "./types";

// ---------------------------------------------------------------------------
// Browse: search + category filter + counts
// ---------------------------------------------------------------------------

export const MARKETPLACE_CATEGORIES: MarketplaceCategory[] = [
  "search",
  "database",
  "messaging",
  "monitoring",
  "storage",
  "auth",
  "devtools",
  "ai",
];

export const CATEGORY_LABEL: Record<MarketplaceCategory, string> = {
  search: "Search",
  database: "Database",
  messaging: "Messaging",
  monitoring: "Monitoring",
  storage: "Storage",
  auth: "Auth",
  devtools: "Dev tools",
  ai: "AI",
};

/** Matches a catalog item against a free-text query: name, description, tags
 * and id, case-insensitive. Empty query matches everything. */
export function matchesSearch(item: CatalogItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    item.name.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q) ||
    item.id.toLowerCase().includes(q) ||
    item.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/** Filters the catalog by an optional category chip (`null` = "All") and a
 * search query, preserving catalog order. */
export function filterCatalog(
  items: CatalogItem[],
  category: MarketplaceCategory | null,
  query: string,
): CatalogItem[] {
  return items.filter((item) => (category ? item.category === category : true) && matchesSearch(item, query));
}

/** Counts items per category (for the filter chips), plus an implicit "all"
 * total under the empty-string key. Only categories present in `items` (or
 * in `MARKETPLACE_CATEGORIES`, with 0) need to be looked up by the caller. */
export function categoryCounts(items: CatalogItem[]): Record<MarketplaceCategory, number> {
  const counts = Object.fromEntries(MARKETPLACE_CATEGORIES.map((c) => [c, 0])) as Record<MarketplaceCategory, number>;
  for (const item of items) counts[item.category] = (counts[item.category] ?? 0) + 1;
  return counts;
}

/** Set of installed catalog item ids (by itemId), for the Browse grid's
 * "Installed" badge — an item can have more than one installed instance. */
export function installedItemIds(installed: InstalledApp[]): Set<string> {
  return new Set(installed.map((a) => a.itemId));
}

// ---------------------------------------------------------------------------
// Compose parsing (detail drawer: services, images, ports)
// ---------------------------------------------------------------------------

export interface ComposeServiceSummary {
  name: string;
  image: string | null;
  ports: string[]; // raw "published[:target][/proto]" strings, as declared
}

interface RawComposeService {
  image?: string;
  ports?: (string | number | { published?: string | number; target?: string | number })[];
}

interface RawComposeDoc {
  services?: Record<string, RawComposeService>;
}

/** Parses a catalog item's embedded `compose.yml` text (via the `yaml`
 * package, same one used for `colima.yaml`) into a summary of its services:
 * name, image and declared ports. `${VAR}` interpolation is left as-is (not
 * substituted) — this is a read-only preview of the compose file's shape,
 * not a resolved render. Malformed YAML returns an empty list rather than
 * throwing, so a bad catalog entry never crashes the detail drawer. */
export function parseComposeServices(composeText: string): ComposeServiceSummary[] {
  let doc: RawComposeDoc;
  try {
    doc = (parseYaml(composeText) as RawComposeDoc) ?? {};
  } catch {
    return [];
  }
  const services = doc.services ?? {};
  return Object.entries(services).map(([name, svc]) => ({
    name,
    image: svc?.image ?? null,
    ports: (svc?.ports ?? []).map(normalizePortEntry).filter((p): p is string => p !== null),
  }));
}

function normalizePortEntry(entry: string | number | { published?: string | number; target?: string | number }): string | null {
  if (typeof entry === "string") return entry;
  if (typeof entry === "number") return String(entry);
  if (entry && typeof entry === "object") {
    const published = entry.published != null ? String(entry.published) : "";
    const target = entry.target != null ? String(entry.target) : "";
    if (published && target) return `${published}:${target}`;
    return target || published || null;
  }
  return null;
}

/** All distinct images referenced across a compose file's services, in
 * first-seen order. */
export function composeImages(composeText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const svc of parseComposeServices(composeText)) {
    if (svc.image && !seen.has(svc.image)) {
      seen.add(svc.image);
      out.push(svc.image);
    }
  }
  return out;
}

/** All distinct host ports declared across a compose file's services
 * (the left side of `published:target`, or a bare number), as integers.
 * `${VAR}` placeholders (unresolved) are skipped. */
export function composeDeclaredPorts(composeText: string): number[] {
  const ports = new Set<number>();
  for (const svc of parseComposeServices(composeText)) {
    for (const p of svc.ports) {
      const hostPart = p.split(":")[0];
      const n = Number(hostPart.replace(/\/(tcp|udp)$/i, ""));
      if (Number.isFinite(n) && n > 0) ports.add(n);
    }
  }
  return Array.from(ports).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Password generation (client-side regenerate, mirrors the backend's CSPRNG
// alphanumeric generation described in §6.8 so "regenerate" never round-trips)
// ---------------------------------------------------------------------------

const PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generates an alphanumeric (URL/YAML-safe, per §6.8's catalog rules)
 * password of the given length using `crypto.getRandomValues` — never
 * `Math.random()`. Rejection sampling avoids modulo bias. */
export function generatePassword(length: number = 24): string {
  const n = Math.max(1, Math.floor(length));
  const bytes = new Uint8Array(n);
  const max = 256 - (256 % PASSWORD_ALPHABET.length);
  let out = "";
  // Fill in batches, rejecting bytes that would bias the modulo.
  while (out.length < n) {
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < n; i++) {
      if (bytes[i] < max) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Port conflict detection (Install dialog's editable port fields)
// ---------------------------------------------------------------------------

/** Returns true if `port` collides with any port in `taken` (host-bound
 * ports already in use by running containers or other Marketplace
 * instances — the caller assembles that list from `Container.portLinks` +
 * other installed apps' resolved port variables) other than `ignorePort`
 * itself (so editing a variable's own field doesn't immediately flag). */
export function isPortConflict(port: number, taken: number[], ignorePort?: number): boolean {
  if (!Number.isFinite(port) || port <= 0) return false;
  return taken.some((t) => t === port && t !== ignorePort);
}

/** Finds the next free port at or above `preferred`, skipping anything in
 * `taken` — used for local, client-side suggestions; the backend's
 * `marketplace_prepare` does the authoritative allocation against the real
 * host, this is only for instant UI feedback (e.g. a "use 5433 instead"
 * hint) before that round-trip resolves. */
export function nextFreePort(preferred: number, taken: number[]): number {
  const takenSet = new Set(taken);
  let port = preferred;
  while (takenSet.has(port)) port++;
  return port;
}

// ---------------------------------------------------------------------------
// Endpoint rendering (Ready card / Installed card's Credentials view)
// ---------------------------------------------------------------------------

/** Substitutes `${VAR}` placeholders in a template string with values from
 * `values` (missing variables are left as-is, e.g. for partially-prepared
 * previews). */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match,
  );
}

/** Renders a catalog item's endpoint templates against a set of resolved
 * variable values (§6.8: `InstalledApp.endpoints` are "endpoint templates
 * rendered with the instance values" — this is that rendering, usable both
 * for the Install dialog's live preview before install and to re-derive a
 * display view from `InstalledApp` data already rendered server-side). */
export function renderEndpoints(
  templates: MarketplaceEndpointTemplate[],
  values: Record<string, string>,
): MarketplaceEndpoint[] {
  return templates.map((t) => ({
    name: t.name,
    url: t.url ? renderTemplate(t.url, values) : null,
    value: t.value ? renderTemplate(t.value, values) : null,
    username: t.username ? renderTemplate(t.username, values) : null,
    password: t.password ? renderTemplate(t.password, values) : null,
    primary: t.primary ?? false,
  }));
}

/** The endpoint to use for a card's primary "Open" action: the one marked
 * `primary`, else the first with a URL, else `null` (e.g. a connection-
 * string-only app has no clickable primary endpoint). */
export function primaryEndpoint(endpoints: MarketplaceEndpoint[]): MarketplaceEndpoint | null {
  return endpoints.find((e) => e.primary && e.url) ?? endpoints.find((e) => e.url) ?? null;
}

// ---------------------------------------------------------------------------
// Misc small helpers
// ---------------------------------------------------------------------------

/** Splits an app's variables into the ones shown by default and the ones
 * collapsed under "Advanced" (§6.8: hidden variables). */
export function splitAdvancedVariables<T extends { hidden: boolean }>(variables: T[]): { visible: T[]; advanced: T[] } {
  return {
    visible: variables.filter((v) => !v.hidden),
    advanced: variables.filter((v) => v.hidden),
  };
}

/** True if a variable's type should be masked-by-default in the Install
 * dialog (password fields; reveal is an explicit per-field toggle). */
export function isMaskedVariableType(type: MarketplaceVariableType): boolean {
  return type === "password";
}
