import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { saveObservation } from '../floor-plans/archive.js';
import { useTestArchive } from './helpers/floor-plan-file-store.js';

useTestArchive();

const origin = 'https://opereta.hr/stan/123';
const finalUrl = 'https://www.opereta.hr/stan/123/';
const body = Buffer.from('<html>listing page</html>');
const hash = createHash('sha256').update(body).digest('hex');

function database({ existingFinal = null } = {}) {
  let inTransaction = false;
  const calls = [];
  const targets = new Map();
  if (existingFinal) targets.set(finalUrl, { url: finalUrl, ...existingFinal });
  const db = { calls, targets, query: vi.fn(async (sql, args = []) => {
    calls.push({ sql, args, inTransaction });
    if (sql.includes('AS allowed FROM floor_plan.target')) return { rows: [{ allowed: true }] };
    if (sql === 'BEGIN') { inTransaction = true; return { rows: [], rowCount: null }; }
    if (sql === 'COMMIT') { inTransaction = false; return { rows: [], rowCount: null }; }
    if (sql === 'ROLLBACK') { inTransaction = false; return { rows: [], rowCount: null }; }
    if (/^(INSERT INTO|UPDATE floor_plan\.(?:blob|observation|target))/.test(sql.trim()) && !inTransaction) {
      throw new Error('Observation writes must stay inside the caller transaction.');
    }
    if (sql.includes('INSERT INTO floor_plan.blob')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO floor_plan.observation')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO floor_plan.target')) {
      if (!targets.has(args[0])) targets.set(args[0], { url: args[0], agency_id: args[1], kind: args[2], image_kind: null, image_classified_sha256: null });
      return { rows: [], rowCount: targets.get(args[0]).url === args[0] ? 1 : 0 };
    }
    if (sql.includes('SELECT kind,image_kind,image_classified_sha256 FROM floor_plan.target')) {
      const target = targets.get(args[0]);
      return { rows: target ? [{ kind: target.kind, image_kind: target.image_kind, image_classified_sha256: target.image_classified_sha256 }] : [] };
    }
    if (sql.includes("SET agency_id=COALESCE(agency_id,$2),state='ok'")) {
      const target = targets.get(args[0]);
      if (!target || !['home', 'page'].includes(target.kind) || target.image_kind || target.image_classified_sha256) return { rows: [], rowCount: 0 };
      Object.assign(target, { agency_id: target.agency_id ?? args[1], state: 'ok', http_status: args[2], etag: args[3],
        last_modified: args[4], current_sha256: args[5], last_fetched_at: args[6], next_check_at: 'now()+1 day' });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET state='ok',http_status=$2")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }) };
  return db;
}

async function save(db, target, response) {
  await db.query('BEGIN');
  try {
    const result = await saveObservation(db, target, response, { listing: null, assets: [], links: [] }, 'run-redirect');
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

const target = (overrides = {}) => ({ url: origin, kind: 'page', agency_id: 17, priority: 20, current_sha256: null, ...overrides });
const response = (overrides = {}) => ({ body, status: 200, finalUrl, headers: { contentType: 'text/html', etag: 'etag-123', lastModified: 'last-modified' }, ...overrides });

describe('same-host redirect observations', () => {
  it('records the exact www-folded final URL as observed within the caller transaction', async () => {
    const db = database();
    const result = await save(db, target(), response());

    expect(result).toMatchObject({ hash, changed: true, aliasUrl: finalUrl });
    expect(db.targets.get(finalUrl)).toMatchObject({ kind: 'page', state: 'ok', http_status: 200, etag: 'etag-123',
      last_modified: 'last-modified', current_sha256: hash, next_check_at: 'now()+1 day' });
    const aliasObservation = db.calls.find(call => call.sql.includes('INSERT INTO floor_plan.observation') && call.args[0] === finalUrl);
    expect(aliasObservation).toBeDefined();
    expect(JSON.parse(aliasObservation.args[2])).toMatchObject({ listing: null, assets: [], links: [], fetchedVia: origin, actualFinalUrl: finalUrl });
    expect(aliasObservation.args[1]).toBe(hash);
    expect(aliasObservation.args[3]).toBe('run-redirect');
    expect(aliasObservation.inTransaction).toBe(true);
    expect(db.calls.at(-1).sql).toBe('COMMIT');
    expect(db.calls.filter(call => call.sql === 'BEGIN')).toHaveLength(1);
    expect(db.calls.filter(call => call.sql === 'COMMIT')).toHaveLength(1);
  });

  it.each([
    ['cross-site final URL', target(), response({ finalUrl: 'https://other.example/stan/123' })],
    ['no actual redirect', target(), response({ finalUrl: origin })],
    ['non-200 response', target(), response({ status: 301 })],
    ['asset target', target({ kind: 'asset' }), response()],
  ])('does not add a final observation for %s', async (_name, requested, received) => {
    const db = database();
    const result = await save(db, requested, received);
    expect(result.aliasUrl).toBeNull();
    expect(db.calls.some(call => call.sql.includes('INSERT INTO floor_plan.observation') && call.args[0] === finalUrl)).toBe(false);
    expect(db.calls.some(call => call.sql.includes('INSERT INTO floor_plan.target') && call.args[0] === finalUrl)).toBe(false);
  });

  it('leaves an existing asset or classified target at the final URL untouched', async () => {
    const db = database({ existingFinal: { kind: 'asset', image_kind: 'photo', image_classified_sha256: hash, state: 'ok' } });
    const result = await save(db, target(), response());

    expect(result.aliasUrl).toBeNull();
    expect(db.targets.get(finalUrl)).toMatchObject({ kind: 'asset', image_kind: 'photo', image_classified_sha256: hash, state: 'ok' });
    expect(db.calls.some(call => call.sql.includes('INSERT INTO floor_plan.observation') && call.args[0] === finalUrl)).toBe(false);
    expect(db.calls.some(call => call.sql.includes("SET agency_id=COALESCE(agency_id,$2),state='ok'") && call.args[0] === finalUrl)).toBe(false);
  });
});
