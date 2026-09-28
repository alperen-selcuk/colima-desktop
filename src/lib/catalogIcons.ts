// Maps a catalog item's `icon` slug (app.json, §6.8) to a `simple-icons`
// brand mark. Only NAMED imports (`siRedis`, ...) so bundlers tree-shake
// every icon this module doesn't reference out of the ~5MB `simple-icons` ES
// module — same reasoning as `src/lib/imageIcon.ts` for the Containers page.
//
// Every slug in the §6.8 brief's catalog list is covered here except
// "mailpit", which has no `simple-icons` entry (verified against the
// installed package) — it falls back to the generic glyph, same as any
// unrecognized slug.
import {
  siApachekafka,
  siElasticsearch,
  siGrafana,
  siJaeger,
  siKeycloak,
  siKibana,
  siMinio,
  siMongodb,
  siMysql,
  siN8n,
  siOllama,
  siOpensearch,
  siPostgresql,
  siPrometheus,
  siRabbitmq,
  siRedis,
  siVault,
  type SimpleIcon,
} from "simple-icons";

/** Slug -> simple-icons mark. Keys match `CatalogItem.icon` in app.json
 * (lowercase, hyphen-free brand slugs, per the catalog authoring guide). */
const CATALOG_ICON_MAP: Record<string, SimpleIcon> = {
  elasticsearch: siElasticsearch,
  opensearch: siOpensearch,
  kibana: siKibana,
  postgresql: siPostgresql,
  postgres: siPostgresql,
  mysql: siMysql,
  mongodb: siMongodb,
  redis: siRedis,
  apachekafka: siApachekafka,
  kafka: siApachekafka,
  rabbitmq: siRabbitmq,
  minio: siMinio,
  grafana: siGrafana,
  prometheus: siPrometheus,
  jaeger: siJaeger,
  keycloak: siKeycloak,
  vault: siVault,
  n8n: siN8n,
  ollama: siOllama,
  // "mailpit" intentionally omitted: no simple-icons entry as of the
  // installed version — resolveCatalogIcon() falls back to the generic tile.
};

export interface ResolvedCatalogIcon {
  icon: SimpleIcon;
}

/** Looks up a catalog item's brand icon by its `icon` slug, or `null` when
 * unrecognized (caller falls back to the generic glyph, same convention as
 * `resolveImageIcon` on the Containers page). */
export function resolveCatalogIcon(slug: string): ResolvedCatalogIcon | null {
  const icon = CATALOG_ICON_MAP[slug.toLowerCase().trim()];
  return icon ? { icon } : null;
}
