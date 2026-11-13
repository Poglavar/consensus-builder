// Serves the app's version-pinned CDN modules (three.js and its addons from jsdelivr, the photo
// view's 3d-tiles-renderer from esm.sh) from a disk cache shared by every test and worker.
// Each test opens a fresh browser context with an empty HTTP cache, so without this every first
// entry into the model view, photo view or globe downloads three.js again: about 5 s on a slow
// link, longer than the specs' default waits. Pinned versions do not change; delete .cdn-cache
// to fetch them again.
import { BrowserContext, Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CACHE_DIR = path.resolve(__dirname, '..', '.cdn-cache');
// A jsdelivr package path with an exact version, or an esm.sh module (the importmap pins those).
const PINNED = /^https:\/\/(cdn\.jsdelivr\.net\/npm\/[^/@]+@\d+\.\d+\.\d+\/|esm\.sh\/)/;
const KEPT_HEADERS = ['content-type', 'access-control-allow-origin', 'cache-control'];

type Entry = { status: number; headers: Record<string, string> };

function files(url: string) {
  const key = createHash('sha256').update(url).digest('hex');
  return { meta: path.join(CACHE_DIR, `${key}.json`), body: path.join(CACHE_DIR, `${key}.body`) };
}

// Written to a temporary name and renamed, so a parallel worker never reads half a file.
function store(file: string, data: string | Buffer) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, file);
}

async function serve(route: Route) {
  const url = route.request().url();
  if (route.request().method() !== 'GET') return route.fallback();
  const { meta, body } = files(url);
  try {
    const entry: Entry = JSON.parse(readFileSync(meta, 'utf8'));
    return await route.fulfill({ status: entry.status, headers: entry.headers, body: readFileSync(body) });
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // A redirect goes back to the browser as it came, so a module keeps the URL its imports resolve against.
  const response = await route.fetch({ maxRedirects: 0 });
  const content = await response.body();
  if (response.status() === 200) {
    const all = response.headers();
    const headers = Object.fromEntries(KEPT_HEADERS.filter(name => all[name]).map(name => [name, all[name]]));
    mkdirSync(CACHE_DIR, { recursive: true });
    store(body, content);
    store(meta, JSON.stringify({ status: 200, headers }));
  }
  return route.fulfill({ response, body: content });
}

export async function serveCdnFromCache(context: BrowserContext): Promise<void> {
  await context.route(PINNED, serve);
}
