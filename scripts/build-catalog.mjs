#!/usr/bin/env node
// Builds catalog/dist/catalog.json from catalog/apps/<id>/{app.json,compose.yml}.
//
// Usage:
//   node scripts/build-catalog.mjs           # build and write catalog/dist/catalog.json
//   node scripts/build-catalog.mjs --check    # fail (exit 1) if dist is out of date, without writing
//
// See catalog/README.md for the authoring rules this validates and docs/SPEC.md §6.8 for the
// full app.json contract.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const catalogDir = join(repoRoot, 'catalog');
const appsDir = join(catalogDir, 'apps');
const distDir = join(catalogDir, 'dist');
const distFile = join(distDir, 'catalog.json');
const versionFile = join(catalogDir, 'VERSION');

const CHECK_MODE = process.argv.includes('--check');

const CATEGORIES = new Set([
  'search',
  'database',
  'messaging',
  'monitoring',
  'storage',
  'auth',
  'devtools',
  'ai',
]);

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const VAR_REF_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

class ValidationError extends Error {}

function fail(msg) {
  throw new ValidationError(msg);
}

/** Collect every ${VAR} reference in a string. */
function findVarRefs(str, out) {
  if (typeof str !== 'string') return;
  for (const m of str.matchAll(VAR_REF_RE)) {
    out.add(m[1]);
  }
}

/** Walk any JSON value collecting ${VAR} refs from every string found. */
function collectVarRefsDeep(value, out) {
  if (typeof value === 'string') {
    findVarRefs(value, out);
  } else if (Array.isArray(value)) {
    for (const v of value) collectVarRefsDeep(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectVarRefsDeep(v, out);
  }
}

function loadApp(id) {
  const dir = join(appsDir, id);
  const appJsonPath = join(dir, 'app.json');
  const composePath = join(dir, 'compose.yml');

  if (!existsSync(appJsonPath)) fail(`${id}: missing app.json`);
  if (!existsSync(composePath)) fail(`${id}: missing compose.yml`);

  let app;
  try {
    app = JSON.parse(readFileSync(appJsonPath, 'utf8'));
  } catch (e) {
    fail(`${id}: app.json is not valid JSON (${e.message})`);
  }

  const compose = readFileSync(composePath, 'utf8');
  let composeDoc;
  try {
    composeDoc = parseDocument(compose, { strict: true });
  } catch (e) {
    fail(`${id}: compose.yml is not valid YAML (${e.message})`);
  }
  if (composeDoc.errors && composeDoc.errors.length > 0) {
    fail(`${id}: compose.yml parse error: ${composeDoc.errors[0].message}`);
  }
  const composeObj = composeDoc.toJS();

  validateApp(id, dir, app, compose, composeObj);

  return { app, compose };
}

function validateApp(id, dir, app, composeText, composeObj) {
  // --- app.json structural rules ---
  if (app.id !== id) fail(`${id}: app.json "id" (${app.id}) must equal the folder name`);
  if (!ID_RE.test(app.id)) fail(`${id}: "id" must match ${ID_RE}`);
  if (!app.name) fail(`${id}: "name" is required`);
  if (!app.description) fail(`${id}: "description" is required`);
  if (!CATEGORIES.has(app.category)) fail(`${id}: unknown category "${app.category}"`);
  if (!Array.isArray(app.tags)) fail(`${id}: "tags" must be an array`);
  if (!app.icon) fail(`${id}: "icon" is required`);
  if (!app.website) fail(`${id}: "website" is required`);
  if (!app.source || !app.source.name || !app.source.url || !app.source.license) {
    fail(`${id}: "source" must have name, url and license (provenance/attribution)`);
  }
  if (!Array.isArray(app.architectures) || app.architectures.length === 0) {
    fail(`${id}: "architectures" must be a non-empty array`);
  }
  for (const a of app.architectures) {
    if (a !== 'amd64' && a !== 'arm64') fail(`${id}: unknown architecture "${a}"`);
  }
  if (!Number.isInteger(app.minMemoryMB) || app.minMemoryMB < 256) {
    fail(`${id}: "minMemoryMB" must be an integer >= 256`);
  }
  if (!Array.isArray(app.variables)) fail(`${id}: "variables" must be an array`);
  if (!Array.isArray(app.endpoints) || app.endpoints.length === 0) {
    fail(`${id}: "endpoints" must be a non-empty array`);
  }
  if (!app.ready || !app.ready.type) fail(`${id}: "ready" probe is required`);

  const declaredVars = new Set();
  for (const v of app.variables) {
    if (!v.name || !VAR_NAME_RE.test(v.name)) {
      fail(`${id}: variable name "${v.name}" must match ${VAR_NAME_RE} (SCREAMING_SNAKE_CASE)`);
    }
    if (declaredVars.has(v.name)) fail(`${id}: duplicate variable "${v.name}"`);
    declaredVars.add(v.name);
    if (!['password', 'port', 'string'].includes(v.type)) {
      fail(`${id}: variable "${v.name}" has unknown type "${v.type}"`);
    }
    if (v.type === 'port' && v.default === undefined) {
      fail(`${id}: port variable "${v.name}" must declare a "default"`);
    }
  }

  // COMPOSE_PROJECT_NAME and the well-known instance vars are always available at render time,
  // in addition to whatever this app declares in "variables".
  const implicitVars = new Set(['COMPOSE_PROJECT_NAME']);

  // --- every ${VAR} used anywhere (compose, endpoints, ready.url) must be declared ---
  const usedVars = new Set();
  findVarRefs(composeText, usedVars);
  collectVarRefsDeep(app.endpoints, usedVars);
  if (app.ready) collectVarRefsDeep(app.ready, usedVars);
  if (app.notes) findVarRefs(app.notes, usedVars);

  for (const used of usedVars) {
    if (!declaredVars.has(used) && !implicitVars.has(used)) {
      fail(`${id}: "\${${used}}" is used but not declared in "variables"`);
    }
  }

  // --- compose.yml structural rules ---
  if (!composeObj || typeof composeObj !== 'object' || !composeObj.services) {
    fail(`${id}: compose.yml must have a top-level "services" map`);
  }
  const services = composeObj.services;
  const portVarNames = new Set(app.variables.filter((v) => v.type === 'port').map((v) => v.name));

  for (const [svcName, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;

    if (svc.container_name) {
      fail(`${id}: service "${svcName}" must not set container_name (blocks multiple instances)`);
    }

    const image = svc.image;
    if (image) {
      if (/:latest$/.test(image) || !image.includes(':')) {
        fail(`${id}: service "${svcName}" image "${image}" must be pinned to an explicit tag, not "latest"/untagged`);
      }
      if (/(^|\/)bitnami\//i.test(image)) {
        fail(`${id}: service "${svcName}" image "${image}" must not be a Bitnami image`);
      }
    }

    if (Array.isArray(svc.ports)) {
      for (const p of svc.ports) {
        const portStr = typeof p === 'string' ? p : JSON.stringify(p);
        if (typeof p !== 'string') {
          fail(`${id}: service "${svcName}" port entry must be a "host:container" string, got ${portStr}`);
        }
        if (!p.startsWith('127.0.0.1:')) {
          fail(`${id}: service "${svcName}" published port "${p}" must bind to 127.0.0.1`);
        }
        // host part must reference a declared port variable: 127.0.0.1:${VAR}:container[...]
        const hostPortMatch = p.match(/^127\.0\.0\.1:\$\{([A-Z][A-Z0-9_]*)\}:/);
        if (!hostPortMatch) {
          fail(`${id}: service "${svcName}" published port "${p}" must use a \${PORT_VAR} for the host port`);
        }
        if (!portVarNames.has(hostPortMatch[1])) {
          fail(`${id}: service "${svcName}" published port uses "\${${hostPortMatch[1]}}", which is not declared as a "port" variable`);
        }
      }
    }

    if (Array.isArray(svc.volumes)) {
      for (const v of svc.volumes) {
        if (typeof v !== 'string') continue;
        // Bind mounts contain a "/" (absolute host path) or "./" before the colon; named volumes
        // are a bare identifier. Reject anything that looks like a host path.
        const src = v.split(':')[0];
        if (src.startsWith('.') || src.startsWith('/') || src.startsWith('~')) {
          fail(`${id}: service "${svcName}" volume "${v}" looks like a bind mount; named volumes only`);
        }
      }
    }
  }

  if (composeObj.volumes) {
    for (const volName of Object.keys(composeObj.volumes)) {
      // top-level named volume declarations are fine as-is (no driver_opts host paths expected)
      const vol = composeObj.volumes[volName];
      if (vol && typeof vol === 'object' && vol.driver_opts && vol.driver_opts.device) {
        fail(`${id}: volume "${volName}" declares a host device path; named volumes only`);
      }
    }
  }

  // --- passwords must be alphanumeric-safe (length is enforced by schema; charset by generator,
  //     but catch obviously non-alphanumeric defaults here) ---
  for (const v of app.variables) {
    if (v.type === 'password' && v.default !== undefined && !/^[A-Za-z0-9]*$/.test(String(v.default))) {
      fail(`${id}: password variable "${v.name}" has a non-alphanumeric default`);
    }
  }
}

function listAppIds() {
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function readGeneratedAt() {
  if (!existsSync(versionFile)) {
    fail('catalog/VERSION is missing (should contain a single ISO date, e.g. 2026-09-28)');
  }
  const v = readFileSync(versionFile, 'utf8').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    fail(`catalog/VERSION must contain a single YYYY-MM-DD date, got "${v}"`);
  }
  return v;
}

function build() {
  const ids = listAppIds();
  if (ids.length === 0) fail('no apps found under catalog/apps/');

  const seen = new Set();
  const loaded = [];
  for (const id of ids) {
    if (seen.has(id)) fail(`duplicate app id "${id}"`);
    seen.add(id);
    loaded.push({ id, ...loadApp(id) });
  }

  // Sort by category, then name (case-insensitive), for a deterministic, browsable order.
  loaded.sort((a, b) => {
    const catCmp = a.app.category.localeCompare(b.app.category);
    if (catCmp !== 0) return catCmp;
    return a.app.name.localeCompare(b.app.name, undefined, { sensitivity: 'base' });
  });

  const generatedAt = readGeneratedAt();

  const items = loaded.map(({ app, compose }) => stableItem(app, compose));

  const catalog = {
    schemaVersion: 1,
    generatedAt,
    items,
  };

  return catalog;
}

/** Re-emit an app.json + compose text as an item with a stable, explicit key order. */
function stableItem(app, compose) {
  const item = {
    id: app.id,
    name: app.name,
    description: app.description,
    category: app.category,
    tags: [...app.tags],
    icon: app.icon,
    website: app.website,
    source: {
      name: app.source.name,
      url: app.source.url,
      license: app.source.license,
    },
    architectures: [...app.architectures],
    minMemoryMB: app.minMemoryMB,
    variables: app.variables.map((v) => {
      const out = { name: v.name, type: v.type };
      if (v.label !== undefined) out.label = v.label;
      if (v.default !== undefined) out.default = v.default;
      if (v.length !== undefined) out.length = v.length;
      if (v.hidden !== undefined) out.hidden = v.hidden;
      return out;
    }),
    endpoints: app.endpoints.map((e) => {
      const out = { name: e.name };
      if (e.url !== undefined) out.url = e.url;
      if (e.value !== undefined) out.value = e.value;
      if (e.username !== undefined) out.username = e.username;
      if (e.password !== undefined) out.password = e.password;
      if (e.primary !== undefined) out.primary = e.primary;
      return out;
    }),
  };
  if (app.preflight) {
    item.preflight = app.preflight.map((p) => ({ ...p }));
  }
  item.ready = { ...app.ready };
  if (app.notes !== undefined) item.notes = app.notes;
  item.compose = compose;
  return item;
}

function stableStringify(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function main() {
  let catalog;
  try {
    catalog = build();
  } catch (e) {
    if (e instanceof ValidationError) {
      console.error(`catalog:build: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const output = stableStringify(catalog);

  if (CHECK_MODE) {
    if (!existsSync(distFile)) {
      console.error('catalog:build --check: catalog/dist/catalog.json does not exist');
      process.exit(1);
    }
    const current = readFileSync(distFile, 'utf8');
    if (current !== output) {
      console.error('catalog:build --check: catalog/dist/catalog.json is out of date; run `npm run catalog:build`');
      process.exit(1);
    }
    console.log(`catalog:build --check: OK (${catalog.items.length} apps, dist is up to date)`);
    return;
  }

  writeFileSync(distFile, output);
  console.log(`catalog:build: wrote catalog/dist/catalog.json (${catalog.items.length} apps)`);
}

main();
