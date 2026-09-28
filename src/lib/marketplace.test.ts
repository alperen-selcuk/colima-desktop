import { describe, expect, it } from "vitest";
import {
  categoryCounts,
  composeDeclaredPorts,
  composeImages,
  filterCatalog,
  generatePassword,
  installedItemIds,
  isMaskedVariableType,
  isPortConflict,
  matchesSearch,
  nextFreePort,
  parseComposeServices,
  primaryEndpoint,
  renderEndpoints,
  renderTemplate,
  splitAdvancedVariables,
} from "./marketplace";
import type { CatalogItem, InstalledApp, MarketplaceEndpointTemplate } from "./types";

function makeItem(overrides: Partial<CatalogItem>): CatalogItem {
  return {
    id: "elasticsearch-kibana",
    name: "Elasticsearch + Kibana",
    description: "Search and visualize logs and data.",
    category: "search",
    tags: ["elk", "logs"],
    icon: "elasticsearch",
    website: "https://www.elastic.co",
    source: { name: "docker/awesome-compose", url: "https://example.com", license: "CC0-1.0" },
    architectures: ["amd64", "arm64"],
    minMemoryMB: 3072,
    variables: [],
    endpoints: [],
    preflight: [],
    ready: { type: "running", timeoutSec: 60 },
    notes: null,
    compose: "",
    ...overrides,
  };
}

describe("matchesSearch / filterCatalog", () => {
  const items = [
    makeItem({ id: "elasticsearch-kibana", name: "Elasticsearch + Kibana", category: "search", tags: ["elk", "logs"] }),
    makeItem({ id: "postgres-pgadmin", name: "Postgres + pgAdmin", category: "database", tags: ["sql"], description: "Relational database with an admin UI." }),
    makeItem({ id: "redis", name: "Redis", category: "database", tags: ["cache", "kv"] }),
  ];

  it("empty query matches everything", () => {
    expect(matchesSearch(items[0], "")).toBe(true);
    expect(matchesSearch(items[0], "   ")).toBe(true);
  });

  it("matches name, description, id and tags case-insensitively", () => {
    expect(matchesSearch(items[0], "KIBANA")).toBe(true);
    expect(matchesSearch(items[1], "admin ui")).toBe(true);
    expect(matchesSearch(items[2], "kv")).toBe(true);
    expect(matchesSearch(items[2], "postgres-pgadmin")).toBe(false);
    expect(matchesSearch(items[1], "postgres-pgadmin")).toBe(true);
  });

  it("filterCatalog combines category + search, preserving order", () => {
    expect(filterCatalog(items, "database", "").map((i) => i.id)).toEqual(["postgres-pgadmin", "redis"]);
    expect(filterCatalog(items, null, "cache").map((i) => i.id)).toEqual(["redis"]);
    expect(filterCatalog(items, "search", "cache")).toEqual([]);
    expect(filterCatalog(items, null, "").map((i) => i.id)).toEqual(items.map((i) => i.id));
  });
});

describe("categoryCounts / installedItemIds", () => {
  it("counts items per category, zero-filling absent categories", () => {
    const items = [makeItem({ category: "search" }), makeItem({ id: "b", category: "search" }), makeItem({ id: "c", category: "ai" })];
    const counts = categoryCounts(items);
    expect(counts.search).toBe(2);
    expect(counts.ai).toBe(1);
    expect(counts.database).toBe(0);
    expect(counts.devtools).toBe(0);
  });

  it("collects installed item ids as a set", () => {
    const installed: InstalledApp[] = [
      { projectName: "cd-redis", itemId: "redis", name: "Redis", icon: "redis", createdAt: "2026-01-01T00:00:00Z", status: "running(1)", endpoints: [], notes: null },
      { projectName: "cd-redis-2", itemId: "redis", name: "Redis", icon: "redis", createdAt: "2026-01-02T00:00:00Z", status: "running(1)", endpoints: [], notes: null },
    ];
    const ids = installedItemIds(installed);
    expect(ids.size).toBe(1);
    expect(ids.has("redis")).toBe(true);
  });
});

describe("parseComposeServices / composeImages / composeDeclaredPorts", () => {
  const compose = `
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.15.0
    ports:
      - "127.0.0.1:\${ES_PORT}:9200"
  kibana:
    image: docker.elastic.co/kibana/kibana:8.15.0
    ports:
      - published: 5601
        target: 5601
    depends_on:
      - elasticsearch
`;

  it("parses service names, images and raw port strings", () => {
    const services = parseComposeServices(compose);
    expect(services).toHaveLength(2);
    expect(services[0]).toEqual({
      name: "elasticsearch",
      image: "docker.elastic.co/elasticsearch/elasticsearch:8.15.0",
      ports: ["127.0.0.1:${ES_PORT}:9200"],
    });
    expect(services[1].ports).toEqual(["5601:5601"]);
  });

  it("returns [] for malformed YAML instead of throwing", () => {
    expect(parseComposeServices("services:\n  - not: [valid")).toEqual([]);
    expect(parseComposeServices("")).toEqual([]);
  });

  it("composeImages dedupes in first-seen order", () => {
    const dup = `
services:
  a:
    image: redis:7.2
  b:
    image: redis:7.2
  c:
    image: postgres:16
`;
    expect(composeImages(dup)).toEqual(["redis:7.2", "postgres:16"]);
  });

  it("composeDeclaredPorts extracts host ports, skipping unresolved \${VAR} entries, sorted", () => {
    const withPorts = `
services:
  kibana:
    image: kibana:8.15.0
    ports:
      - "5601:5601"
      - published: 9200
        target: 9200
  es:
    image: es:8.15.0
    ports:
      - "\${ES_PORT}:9200"
`;
    expect(composeDeclaredPorts(withPorts)).toEqual([5601, 9200]);
  });
});

describe("generatePassword", () => {
  it("generates alphanumeric strings of the requested length", () => {
    const pw = generatePassword(24);
    expect(pw).toHaveLength(24);
    expect(pw).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("defaults to length 24 and is different on each call", () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).toHaveLength(24);
    expect(a).not.toBe(b);
  });

  it("clamps to at least length 1", () => {
    expect(generatePassword(0)).toHaveLength(1);
    expect(generatePassword(-5)).toHaveLength(1);
  });
});

describe("isPortConflict / nextFreePort", () => {
  it("flags a port present in the taken list", () => {
    expect(isPortConflict(9200, [5432, 9200])).toBe(true);
    expect(isPortConflict(9201, [5432, 9200])).toBe(false);
  });

  it("ignores the field's own original port", () => {
    expect(isPortConflict(9200, [9200], 9200)).toBe(false);
  });

  it("nextFreePort walks upward past taken ports", () => {
    expect(nextFreePort(9200, [9200, 9201, 9202])).toBe(9203);
    expect(nextFreePort(9200, [])).toBe(9200);
    expect(nextFreePort(9200, [9201])).toBe(9200);
  });
});

describe("renderTemplate / renderEndpoints / primaryEndpoint", () => {
  const values = { ES_PORT: "9200", KIBANA_PORT: "5601", ELASTIC_PASSWORD: "s3cr3t" };

  it("substitutes known variables and leaves unknown placeholders as-is", () => {
    expect(renderTemplate("http://localhost:${ES_PORT}", values)).toBe("http://localhost:9200");
    expect(renderTemplate("http://localhost:${MISSING}", values)).toBe("http://localhost:${MISSING}");
  });

  it("renders endpoint templates into display endpoints", () => {
    const templates: MarketplaceEndpointTemplate[] = [
      { name: "Kibana", url: "http://localhost:${KIBANA_PORT}", username: "elastic", password: "${ELASTIC_PASSWORD}", primary: true },
      { name: "Elasticsearch API", url: "http://localhost:${ES_PORT}", username: "elastic", password: "${ELASTIC_PASSWORD}" },
      { name: "Connection string", value: "postgres://app:${ELASTIC_PASSWORD}@localhost:${ES_PORT}/app" },
    ];
    const rendered = renderEndpoints(templates, values);
    expect(rendered[0]).toEqual({
      name: "Kibana",
      url: "http://localhost:5601",
      value: null,
      username: "elastic",
      password: "s3cr3t",
      primary: true,
    });
    expect(rendered[2].value).toBe("postgres://app:s3cr3t@localhost:9200/app");
    expect(rendered[2].primary).toBe(false);
  });

  it("primaryEndpoint prefers the flagged one, else the first with a URL, else null", () => {
    const templates: MarketplaceEndpointTemplate[] = [
      { name: "API", url: "http://localhost:9200" },
      { name: "UI", url: "http://localhost:5601", primary: true },
    ];
    const rendered = renderEndpoints(templates, values);
    expect(primaryEndpoint(rendered)?.name).toBe("UI");
    expect(primaryEndpoint(renderEndpoints([{ name: "API", url: "http://localhost:9200" }], values))?.name).toBe("API");
    expect(primaryEndpoint(renderEndpoints([{ name: "Connection string", value: "postgres://..." }], values))).toBeNull();
  });
});

describe("splitAdvancedVariables / isMaskedVariableType", () => {
  it("splits visible vs hidden variables", () => {
    const vars = [
      { hidden: false, name: "A" },
      { hidden: true, name: "B" },
      { hidden: false, name: "C" },
    ];
    const { visible, advanced } = splitAdvancedVariables(vars);
    expect(visible.map((v) => v.name)).toEqual(["A", "C"]);
    expect(advanced.map((v) => v.name)).toEqual(["B"]);
  });

  it("only password variables are masked by default", () => {
    expect(isMaskedVariableType("password")).toBe(true);
    expect(isMaskedVariableType("string")).toBe(false);
    expect(isMaskedVariableType("port")).toBe(false);
  });
});
