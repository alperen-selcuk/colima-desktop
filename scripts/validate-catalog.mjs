#!/usr/bin/env node
// Renders every catalog app's compose.yml with dummy variable values and validates it with
// `docker compose config -q` (works without a running Docker daemon — it only parses/interpolates
// the compose file). Shared by CI (.github/workflows/ci.yml, job "catalog") and local development.
//
// Usage:
//   node scripts/validate-catalog.mjs               # validate every app
//   node scripts/validate-catalog.mjs elasticsearch  # validate one app by id
//
// Requires catalog/dist/catalog.json to be up to date (run `npm run catalog:build` first).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const distFile = join(repoRoot, 'catalog', 'dist', 'catalog.json');

const only = process.argv.slice(2);

function dummyValueFor(v) {
  if (v.type === 'port') return String(v.default ?? 10000);
  if (v.type === 'password') return 'DummyPassw0rd1234'.slice(0, v.length ?? 20).padEnd(Math.min(v.length ?? 12, 12), '0');
  // string
  if (v.default !== undefined) return String(v.default);
  return 'dummyvalue';
}

function main() {
  const catalog = JSON.parse(readFileSync(distFile, 'utf8'));
  let items = catalog.items;
  if (only.length > 0) {
    items = items.filter((i) => only.includes(i.id));
    const missing = only.filter((id) => !items.some((i) => i.id === id));
    if (missing.length > 0) {
      console.error(`validate-catalog: unknown app id(s): ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  let failures = 0;

  for (const item of items) {
    const workDir = mkdtempSync(join(tmpdir(), `colima-catalog-${item.id}-`));
    const composePath = join(workDir, 'compose.yml');
    const envPath = join(workDir, '.env');

    writeFileSync(composePath, item.compose);

    const envLines = [`COMPOSE_PROJECT_NAME=cd-${item.id}-validate`];
    for (const v of item.variables) {
      envLines.push(`${v.name}=${dummyValueFor(v)}`);
    }
    writeFileSync(envPath, envLines.join('\n') + '\n');

    const result = spawnSync(
      'docker',
      ['compose', '-f', composePath, '--env-file', envPath, 'config', '-q'],
      { encoding: 'utf8' },
    );

    if (result.status !== 0) {
      failures++;
      console.error(`FAIL ${item.id}`);
      console.error(result.stderr || result.stdout);
    } else {
      console.log(`OK   ${item.id}`);
    }

    rmSync(workDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\nvalidate-catalog: ${failures} of ${items.length} app(s) failed \`docker compose config\``);
    process.exit(1);
  }
  console.log(`\nvalidate-catalog: all ${items.length} app(s) passed \`docker compose config\``);
}

main();
