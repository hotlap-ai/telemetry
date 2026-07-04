/**
 * Golden fixture puller (RFC-0001 §5).
 *
 * Downloads .ibt fixture binaries listed in tests/fixtures/manifest.json into
 * tests/fixtures/files/ (gitignored) and verifies sha256 — a mismatch deletes
 * the file and fails hard: golden fixtures are immutable by definition.
 *
 * Sources, in order:
 *   1. FIXTURES_LOCAL_DIR  — copy from a local directory (dev machines that
 *      already have the samples; hash-verified like any other source)
 *   2. FIXTURES_BASE_URL   — HTTP base (e.g. a signed/public Supabase Storage
 *      prefix for the 'fixtures' bucket); FIXTURES_AUTH_BEARER optional
 *
 * Usage: bun run fixtures:pull
 */
import { join, dirname } from 'node:path';
import { mkdirSync, existsSync, copyFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, 'tests', 'fixtures', 'manifest.json');
const outDir = join(root, 'tests', 'fixtures', 'files');

interface FixtureEntry { name: string; sha256: string; sizeBytes: number; exercises: string }
const manifest = (await Bun.file(manifestPath).json()) as { fixtures: FixtureEntry[] };

const localDir = process.env.FIXTURES_LOCAL_DIR;
const baseUrl = process.env.FIXTURES_BASE_URL;
const bearer = process.env.FIXTURES_AUTH_BEARER;

mkdirSync(outDir, { recursive: true });

async function sha256(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let failures = 0;
for (const fx of manifest.fixtures) {
  const dest = join(outDir, fx.name);

  if (existsSync(dest)) {
    const hash = await sha256(dest);
    if (hash === fx.sha256) {
      console.log(`ok        ${fx.name}`);
      continue;
    }
    console.error(`STALE     ${fx.name} — hash mismatch, re-fetching`);
    unlinkSync(dest);
  }

  let fetched = false;
  if (localDir && existsSync(join(localDir, fx.name))) {
    copyFileSync(join(localDir, fx.name), dest);
    fetched = true;
  } else if (baseUrl) {
    const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(fx.name)}`;
    const resp = await fetch(url, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined);
    if (resp.ok) {
      writeFileSync(dest, new Uint8Array(await resp.arrayBuffer()));
      fetched = true;
    } else {
      console.error(`FETCH ${resp.status} ${fx.name}`);
    }
  }

  if (!fetched) {
    console.error(`MISSING   ${fx.name} — set FIXTURES_LOCAL_DIR or FIXTURES_BASE_URL`);
    failures++;
    continue;
  }

  const hash = await sha256(dest);
  if (hash !== fx.sha256) {
    unlinkSync(dest);
    console.error(`CORRUPT   ${fx.name} — sha256 ${hash} != manifest ${fx.sha256}`);
    failures++;
    continue;
  }
  console.log(`fetched   ${fx.name}`);
}

if (failures > 0) {
  console.error(`\n${failures} fixture(s) unavailable or corrupt`);
  process.exit(1);
}
console.log(`\nAll ${manifest.fixtures.length} fixtures present and hash-verified in ${outDir}`);
