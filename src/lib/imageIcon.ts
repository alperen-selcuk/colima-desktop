// Pure helpers mapping a Docker image reference to a brand icon (§6.7).
//
// Only a curated set of `simple-icons` (CC0) icons is imported, and only via
// NAMED imports (`siNginx`, `siRedis`, ...) so bundlers can tree-shake every
// icon we don't use out of the ~5MB `simple-icons` ES module — see the
// bundle-size note in the PR description for the measured impact.
//
// This module has no React/DOM dependency so it's trivially unit-testable;
// `src/components/containers/ImageIcon.tsx` renders what this returns.
import {
  siAlpinelinux,
  siApachekafka,
  siDebian,
  siDocker,
  siElasticsearch,
  siGo,
  siGrafana,
  siMariadb,
  siMinio,
  siMongodb,
  siMysql,
  siNodedotjs,
  siNginx,
  siPostgresql,
  siPrometheus,
  siPython,
  siRabbitmq,
  siRedis,
  siTraefikproxy,
  siUbuntu,
  type SimpleIcon,
} from "simple-icons";

/** One entry per well-known image family (§6.7's list). `match` tests the
 * bare repository name (registry/namespace/tag already stripped — see
 * `parseImageRepository`); kept as small literal arrays rather than regexes
 * so they're trivial to read/extend. */
interface IconEntry {
  icon: SimpleIcon;
  match: (repo: string) => boolean;
}

function nameIs(...names: string[]): (repo: string) => boolean {
  return (repo: string) => names.includes(repo);
}

function nameIncludes(...needles: string[]): (repo: string) => boolean {
  return (repo: string) => needles.some((n) => repo.includes(n));
}

const ICON_ENTRIES: IconEntry[] = [
  { icon: siNginx, match: nameIs("nginx") },
  { icon: siRedis, match: nameIs("redis") },
  { icon: siPostgresql, match: nameIs("postgres", "postgresql") },
  { icon: siMariadb, match: nameIs("mariadb") },
  { icon: siMysql, match: nameIs("mysql") },
  { icon: siMongodb, match: nameIs("mongo", "mongodb") },
  { icon: siNodedotjs, match: nameIs("node") },
  { icon: siPython, match: nameIs("python") },
  { icon: siGo, match: nameIs("golang") },
  { icon: siAlpinelinux, match: nameIs("alpine") },
  { icon: siUbuntu, match: nameIs("ubuntu") },
  { icon: siDebian, match: nameIs("debian") },
  { icon: siRabbitmq, match: nameIs("rabbitmq") },
  { icon: siElasticsearch, match: nameIs("elasticsearch") },
  { icon: siGrafana, match: nameIs("grafana") },
  { icon: siPrometheus, match: nameIs("prometheus") },
  { icon: siTraefikproxy, match: nameIs("traefik") },
  { icon: siApachekafka, match: nameIncludes("kafka") },
  { icon: siMinio, match: nameIs("minio") },
  { icon: siDocker, match: nameIncludes("docker") },
];

/** Strip registry host, namespace and tag/digest from a full image
 * reference, leaving just the bare repository name used to match a brand
 * icon, e.g.:
 *   "docker.io/library/postgres:16"     -> "postgres"
 *   "bitnami/redis:7.2"                 -> "redis"
 *   "redis@sha256:abcd..."              -> "redis"
 *   "ghcr.io/myorg/myapp:latest"        -> "myapp"
 *   "myapp"                             -> "myapp"
 */
export function parseImageRepository(image: string): string {
  if (!image) return "";
  // Split off a digest first (may coexist with a tag: "name:tag@sha256:...").
  const [withoutDigest] = image.split("@");
  // Registry hosts contain a "." or ":" (port) before the first "/", and a
  // bare namespace/name never does (e.g. "bitnami/redis" has no host).
  const firstSlash = withoutDigest.indexOf("/");
  let rest = withoutDigest;
  if (firstSlash !== -1) {
    const maybeHost = withoutDigest.slice(0, firstSlash);
    if (maybeHost.includes(".") || maybeHost.includes(":") || maybeHost === "localhost") {
      rest = withoutDigest.slice(firstSlash + 1);
    }
  }
  // Now `rest` is "[namespace/]name[:tag]" (possibly with more slashes for
  // registries with nested paths); take the last path segment, then drop tag.
  const segments = rest.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const name = last.split(":")[0];
  return name.trim().toLowerCase();
}

export interface ResolvedImageIcon {
  kind: "brand";
  icon: SimpleIcon;
}

/** Looks up a brand icon for an image reference, or `null` for an unknown
 * image (caller should fall back to the generic tinted glyph). */
export function resolveImageIcon(image: string): ResolvedImageIcon | null {
  const repo = parseImageRepository(image);
  if (!repo) return null;
  for (const entry of ICON_ENTRIES) {
    if (entry.match(repo)) return { kind: "brand", icon: entry.icon };
  }
  return null;
}

/** The ~8 harmonious fallback tile colours (CSS variable names defined in
 * both themes in src/styles/containers.css), selected by a stable hash of
 * the image name so the same unknown image always gets the same colour. */
export const FALLBACK_TILE_VARS = [
  "--ctr-fallback-1",
  "--ctr-fallback-2",
  "--ctr-fallback-3",
  "--ctr-fallback-4",
  "--ctr-fallback-5",
  "--ctr-fallback-6",
  "--ctr-fallback-7",
  "--ctr-fallback-8",
] as const;

/** Simple, stable (deterministic across runs) string hash — good enough to
 * spread image names across the fallback palette, not cryptographic. */
export function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0; // force 32-bit int
  }
  return Math.abs(hash);
}

/** Picks one of `FALLBACK_TILE_VARS` for an image name, stable across calls. */
export function fallbackTileVar(image: string): string {
  const idx = stableHash(image || "unknown") % FALLBACK_TILE_VARS.length;
  return FALLBACK_TILE_VARS[idx];
}
