#!/usr/bin/env node
// Real `docker compose up` smoke test for a set of "light" (fast-starting, small-image) catalog
// apps. Requires an actual Docker daemon (unlike build-catalog.mjs/validate-catalog.mjs, which
// only need the docker CLI). Used by CI's `catalog` job on Ubuntu; can also be run locally against
// a running Colima machine with `docker -H <socket> ...` via DOCKER_HOST.
//
// For each app: render compose.yml + a dummy .env, `docker compose up -d --wait`, curl the
// primary endpoint's URL (HEAD-ish GET, any 2xx/3xx/401/404 counts as "the server answered"),
// then always `docker compose down -v` even on failure.
//
// Usage: node scripts/smoke-catalog.mjs <app-id> [<app-id> ...]

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const distFile = join(repoRoot, 'catalog', 'dist', 'catalog.json');

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: node scripts/smoke-catalog.mjs <app-id> [<app-id> ...]');
  process.exit(1);
}

function dummyValueFor(v) {
  if (v.type === 'port') return String(v.default ?? 10000);
  if (v.type === 'password') {
    const raw = 'Sm0keTestPassw0rd1234567890';
    const len = Math.min(Math.max(v.length ?? 20, 8), raw.length);
    return raw.slice(0, len);
  }
  if (v.default !== undefined) return String(v.default);
  return 'smoketest';
}

function renderVars(str, values) {
  return str.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => (name in values ? values[name] : ''));
}

async function waitForHttp(url, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      // Any response at all (2xx/3xx/401/404/...) means the server is up and answering.
      if (res.status >= 200 && res.status < 500) return true;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message ?? 'no response'}`);
}

async function smokeOne(item) {
  const workDir = mkdtempSync(join(tmpdir(), `colima-smoke-${item.id}-`));
  const composePath = join(workDir, 'compose.yml');
  const envPath = join(workDir, '.env');

  writeFileSync(composePath, item.compose);

  const values = { COMPOSE_PROJECT_NAME: `cd-${item.id}-smoke` };
  for (const v of item.variables) values[v.name] = dummyValueFor(v);
  const envLines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, envLines.join('\n') + '\n');

  const composeArgs = ['compose', '-f', composePath, '--env-file', envPath, '-p', values.COMPOSE_PROJECT_NAME];

  console.log(`\n=== ${item.id}: docker compose up -d --wait ===`);
  const up = spawnSync('docker', [...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '180'], {
    encoding: 'utf8',
    stdio: 'inherit',
  });

  try {
    if (up.status !== 0) {
      throw new Error('docker compose up --wait failed (see output above)');
    }

    const primary = item.endpoints.find((e) => e.primary && e.url) ?? item.endpoints.find((e) => e.url);
    if (primary) {
      const url = renderVars(primary.url, values);
      console.log(`=== ${item.id}: curl ${url} ===`);
      await waitForHttp(url, 60);
      console.log(`=== ${item.id}: endpoint answered ===`);
    } else {
      console.log(`=== ${item.id}: no HTTP endpoint to curl; --wait already confirmed health/startup ===`);
    }
  } finally {
    console.log(`=== ${item.id}: docker compose down -v ===`);
    spawnSync('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const catalog = JSON.parse(readFileSync(distFile, 'utf8'));
  const missing = ids.filter((id) => !catalog.items.some((i) => i.id === id));
  if (missing.length > 0) {
    console.error(`smoke-catalog: unknown app id(s): ${missing.join(', ')}`);
    process.exit(1);
  }

  let failures = 0;
  for (const id of ids) {
    const item = catalog.items.find((i) => i.id === id);
    try {
      await smokeOne(item);
      console.log(`OK   ${id}`);
    } catch (e) {
      failures++;
      console.error(`FAIL ${id}: ${e.message}`);
    }
  }

  if (failures > 0) {
    console.error(`\nsmoke-catalog: ${failures} of ${ids.length} app(s) failed`);
    process.exit(1);
  }
  console.log(`\nsmoke-catalog: all ${ids.length} app(s) passed`);
}

main();
