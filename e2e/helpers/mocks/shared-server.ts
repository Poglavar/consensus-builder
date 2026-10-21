// In-memory courier and index for published designs and agreements (plan-design-agreement.md, M2):
// POST /pins, POST/GET /designs, /designs/batch, /designs/binding, POST/GET /agreements and the owner
// decisions relay. Every page gets its own index from mockAllApiRoutes; attaching one index to pages
// in separate browser contexts models another device reading what this one published.
import { Page, Request, Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sampleParcels } from './parcel-data';
import { fixtureSiteBinding } from './site-binding';

const backendRequire = createRequire(path.resolve(__dirname, '../../../backend/package.json'));
const turf = backendRequire('@turf/turf');

export interface IndexRequest { method: string; path: string; body: any }

export interface SharedIndex {
  /** Pinned objects by CID: their kind and canonical bytes as received (base64). */
  pins: Map<string, { kind: string; bytes: string }>;
  /** Indexed design rows by CID, as GET /designs/:cid answers them. */
  designs: Map<string, Record<string, any>>;
  /** Indexed agreement rows by CID, as GET /agreements/:cid answers them. */
  agreements: Map<string, Record<string, any>>;
  /** Relayed owner decisions (receipts) by agreement CID. */
  decisions: Map<string, any[]>;
  /** Every request the index answered, with its JSON body. */
  requests: IndexRequest[];
  /** The cadastre a design's site is bound against (backend checkProposalBinding, here by turf). */
  cadastre: any[];
}

export function createSharedIndex(options: { cadastre?: any[] } = {}): SharedIndex {
  return {
    pins: new Map(), designs: new Map(), agreements: new Map(), decisions: new Map(), requests: [],
    cadastre: options.cadastre || sampleParcels.features,
  };
}

// ---- the CID scheme, computed with node's crypto (frontend/js/cid.js computes it in the browser) ----

// JSON with keys sorted at every depth by UTF-16 code unit and no whitespace (cid.js stableStringify).
export function canonicalJson(value: any): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes: Uint8Array): string {
  let text = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += BASE32[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits) text += BASE32[(buffer << (5 - bits)) & 31];
  return text;
}

/** CIDv1, codec raw, sha2-256, base32 lower case (`bafkrei…`) of exactly these bytes. */
export function cidOfBytes(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest();
  return `b${base32(Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...digest]))}`;
}

/** The CID of an object's canonical bytes. */
export const cidOfObject = (value: any): string => cidOfBytes(Buffer.from(canonicalJson(value), 'utf8'));

const isCid = (value: unknown): value is string => typeof value === 'string' && /^bafkrei[a-z2-7]{52}$/.test(value);

// ---- binding: the parcels a design's ground takes ------------------------------------------------

// Every polygon a design is bound by: its site, else the polygons of its own geometry and payload.
function groundPolygons(content: Record<string, any>): any[] {
  const isPolygon = (value: any) => value && (value.type === 'Polygon' || value.type === 'MultiPolygon') && Array.isArray(value.coordinates);
  if (isPolygon(content.site)) return [content.site];
  const found: any[] = [];
  const visit = (value: any, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (isPolygon(value)) { found.push(value); return; }
    (Array.isArray(value) ? value : Object.values(value)).forEach(item => visit(item, depth + 1));
  };
  visit(content.geometry, 0);
  ['roadProposal', 'buildingProposal', 'structureProposal', 'parcelLayout'].forEach(key => visit(content[key], 0));
  return found;
}

export function bindContent(index: SharedIndex, content: Record<string, any>): Record<string, any> {
  const polygons = groundPolygons(content);
  if (!polygons.length) return { parcels: [], touched: [], toleranceM: 0, coverage: 'none', unsurveyedM2: 0, siteM2: 0, source: 'server:e2e-fixture-cadastre' };
  let ground = turf.feature(polygons[0]);
  for (const polygon of polygons.slice(1)) {
    const merged = turf.union(ground, turf.feature(polygon));
    if (merged) ground = merged;
  }
  return fixtureSiteBinding(ground.geometry, Number(content.toleranceM) || 0, index.cadastre);
}

// ---- rows ------------------------------------------------------------------------------------------

// Short city codes the frontend sends (?city=zg) name the city id rows are filed under, as the API's
// normalizeCityCode reads them (backend/routes/proposals.js CITY_CODE_TO_ID).
const CITY_CODE_TO_ID: Record<string, string> = {
  zg: 'zagreb', zgb: 'zagreb', st: 'split', si: 'sibenik', bg: 'belgrade', ba: 'buenos_aires', caba: 'buenos_aires',
  'ar-ba': 'buenos_aires', lj: 'ljubljana', co: 'colorado', ny: 'new_york',
};
const cityIdOf = (code: unknown): string | null => {
  const raw = typeof code === 'string' ? code.trim().toLowerCase() : '';
  return raw ? CITY_CODE_TO_ID[raw] || raw : null;
};

function designRow(index: SharedIndex, cid: string, content: Record<string, any>): Record<string, any> {
  return {
    cid,
    city: cityIdOf(content.city),
    goal: content.goal,
    title: content.title ?? null,
    author: content.author ?? null,
    originCid: content.origin?.cid ?? null,
    binding: bindContent(index, content),
    content,
    screenshotUrl: null,
    screenshotBeforeUrl: null,
    screenshotPairUrl: null,
    createdAt: new Date().toISOString(),
  };
}

function agreementRow(cid: string, content: Record<string, any>, designs: Array<Record<string, any>>): Record<string, any> {
  const deadline = content.deadline ?? null;
  return {
    cid,
    city: designs[0]?.city ?? cityIdOf(content.city),
    title: content.title ?? null,
    author: content.author ?? null,
    designCids: content.designs.map((design: any) => design.cid),
    inputParcelIds: (content.inputs?.parcels || []).map((parcel: any) => String(parcel.parcelId)),
    parcelSourceId: content.inputs?.parcels?.[0]?.parcelSourceId ?? null,
    deadline,
    status: deadline && Date.parse(deadline) <= Date.now() ? 'expired' : 'active',
    content,
    onchain: null,
    screenshotUrl: null,
    screenshotBeforeUrl: null,
    screenshotPairUrl: null,
    createdAt: new Date().toISOString(),
  };
}

// ---- routes ----------------------------------------------------------------------------------------

const INDEX_PATH = /\/(pins|designs|agreements)(?:\/([^?#]*))?$/;

function indexPathOf(request: Request): { root: string; rest: string } | null {
  // A navigation to /designs/<cid> or /agreements/<cid> is the app's own page, served by the frontend.
  if (request.isNavigationRequest() || (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr')) return null;
  const pathname = new URL(request.url()).pathname.replace(/\/$/, '');
  const match = INDEX_PATH.exec(pathname);
  return match ? { root: match[1], rest: match[2] || '' } : null;
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const refuse = (route: Route, status: number, code: string, error: string, extra: Record<string, unknown> = {}) => json(route, status, { error, code, ...extra });

function bodyOf(request: Request): any {
  try { return request.postDataJSON(); } catch (_) { return null; }
}

// A design as POST /designs and the carried designs of POST /agreements index it, or a refusal.
function indexDesign(index: SharedIndex, entry: any, { allowLayout }: { allowLayout: boolean }):
    { row: Record<string, any>; existing: boolean } | { status: number; code: string; error: string; extra?: Record<string, unknown> } {
  if (!entry || !isCid(entry.cid)) return { status: 400, code: 'invalid-cid', error: 'cid must be a CIDv1 raw sha2-256 base32 CID (bafkrei…).' };
  const content = entry.content;
  if (!content || typeof content !== 'object' || content.schema !== 'design/v1') return { status: 400, code: 'invalid-design', error: 'content must be a design/v1 object.' };
  const computedCid = cidOfObject(content);
  if (computedCid !== entry.cid) return { status: 400, code: 'cid-mismatch', error: `The content is ${computedCid}, not ${entry.cid}.`, extra: { cid: entry.cid, computedCid } };
  const existing = index.designs.get(entry.cid);
  if (existing) return { row: existing, existing: true };
  if (content.parcelLayout != null && !allowLayout) {
    return { status: 422, code: 'layout-needs-agreement', error: 'A parcel layout is published with the agreement that settles its land: send it in the designs of POST /agreements.' };
  }
  const row = designRow(index, entry.cid, content);
  index.designs.set(entry.cid, row);
  return { row, existing: false };
}

function listDesigns(index: SharedIndex, params: URLSearchParams): Record<string, any>[] {
  const city = cityIdOf(params.get('city'));
  const query = (params.get('q') || '').trim().toLowerCase();
  const bbox = params.get('bbox')?.split(',').map(Number);
  const limit = Number.parseInt(params.get('limit') || '', 10);
  const rows = [...index.designs.values()].filter(row => {
    if (city && row.city !== city) return false;
    if (query && !`${row.title || ''}\n${row.author || ''}`.toLowerCase().includes(query)) return false;
    if (bbox && bbox.length === 4 && bbox.every(Number.isFinite)) {
      const polygons = groundPolygons(row.content || {});
      const box = turf.bboxPolygon(bbox);
      if (!polygons.some(polygon => turf.booleanIntersects(turf.feature(polygon), box))) return false;
    }
    return true;
  }).reverse();
  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
}

/**
 * Answers the courier and index routes from `index` on this page. Registered after mockAllApiRoutes,
 * it takes precedence over the page's own index (Playwright tries the newest route first).
 */
export async function attachSharedIndex(page: Page, index: SharedIndex): Promise<void> {
  await page.route(url => INDEX_PATH.test(url.pathname.replace(/\/$/, '')), async route => {
    const request = route.request();
    const target = indexPathOf(request);
    if (!target) return route.fallback();
    const method = request.method();
    const body = method === 'GET' || method === 'HEAD' ? null : bodyOf(request);
    const url = new URL(request.url());
    index.requests.push({ method, path: url.pathname + url.search, body });
    const { root, rest } = target;

    if (root === 'pins' && !rest && method === 'POST') {
      if (!body || !['design', 'agreement'].includes(body.kind)) return refuse(route, 400, 'invalid-kind', 'kind must be design or agreement.');
      if (!isCid(body.cid) || typeof body.bytes !== 'string') return refuse(route, 400, 'bad-request', 'Body must be { kind, cid, bytes }.');
      const bytes = Buffer.from(body.bytes, 'base64');
      const computedCid = cidOfBytes(bytes);
      if (computedCid !== body.cid) return refuse(route, 400, 'cid-mismatch', `The bytes are ${computedCid}, not ${body.cid}.`, { cid: body.cid, computedCid });
      let content: any;
      try { content = JSON.parse(bytes.toString('utf8')); } catch (_) { return refuse(route, 400, 'invalid-object', 'The bytes are not UTF-8 JSON.'); }
      if (canonicalJson(content) !== bytes.toString('utf8')) return refuse(route, 400, 'not-canonical', 'The bytes are not the object\'s canonical form.');
      if (content.schema !== `${body.kind}/v1`) return refuse(route, 400, 'invalid-kind', `Pins of kind ${body.kind} hold ${body.kind}/v1 objects.`);
      index.pins.set(body.cid, { kind: body.kind, bytes: body.bytes });
      return json(route, 200, { cid: body.cid, pinnedAt: new Date().toISOString() });
    }

    if (root === 'designs') {
      if (!rest && method === 'POST') {
        const outcome = indexDesign(index, body, { allowLayout: false });
        if ('row' in outcome) return json(route, outcome.existing ? 409 : 201, outcome.row);
        return refuse(route, outcome.status, outcome.code, outcome.error, outcome.extra);
      }
      if (!rest && method === 'GET') {
        const designs = listDesigns(index, url.searchParams);
        return json(route, 200, { designs, count: designs.length });
      }
      if (rest === 'batch' && method === 'POST') {
        const cids: string[] = Array.isArray(body?.cids) ? [...new Set<string>(body.cids)] : [];
        if (!cids.length || !cids.every(isCid)) return refuse(route, 400, 'bad-request', 'Body must be { cids: [1 to 1000 CIDs] }.');
        const items = cids.map(cid => ({ cid, design: index.designs.get(cid) ?? null }));
        return json(route, 200, { items, count: items.filter(item => item.design).length });
      }
      if (rest === 'binding' && method === 'POST') {
        if (!body?.site) return refuse(route, 400, 'bad-request', 'Body must be { site, toleranceM?, city?, parcelSourceId? }.');
        return json(route, 200, { city: null, parcelSourceId: null, binding: fixtureSiteBinding(body.site, Number(body.toleranceM) || 0, index.cadastre) });
      }
      if (/^[^/]+$/.test(rest) && method === 'GET') {
        if (!isCid(rest)) return refuse(route, 400, 'invalid-cid', 'Not a design CID.');
        const row = index.designs.get(rest);
        return row ? json(route, 200, row) : refuse(route, 404, 'design-not-found', 'Design not found');
      }
    }

    if (root === 'agreements') {
      if (!rest && method === 'POST') {
        if (!body || !isCid(body.cid) || !body.content || body.content.schema !== 'agreement/v1') {
          return refuse(route, 400, 'bad-request', 'Body must be { cid, content, designs? }.');
        }
        const computedCid = cidOfObject(body.content);
        if (computedCid !== body.cid) return refuse(route, 400, 'cid-mismatch', `The content is ${computedCid}, not ${body.cid}.`, { cid: body.cid, computedCid });
        const existing = index.agreements.get(body.cid);
        if (existing) return json(route, 409, existing);
        const linked: string[] = body.content.designs.map((design: any) => design.cid);
        for (const entry of body.designs || []) {
          if (!linked.includes(entry?.cid)) return refuse(route, 400, 'design-not-in-agreement', `Design ${entry?.cid} is not linked by the agreement.`, { design: entry?.cid });
          const outcome = indexDesign(index, entry, { allowLayout: true });
          if (!('row' in outcome)) return refuse(route, outcome.status, outcome.code, outcome.error, { ...outcome.extra, design: entry.cid });
        }
        const missing = linked.filter(cid => !index.designs.has(cid));
        if (missing.length) return refuse(route, 422, 'design-not-indexed', `The agreement links ${missing.length} design(s) the index does not hold.`, { missing });
        const row = agreementRow(body.cid, body.content, linked.map(cid => index.designs.get(cid)!));
        index.agreements.set(body.cid, row);
        return json(route, 201, row);
      }
      if (!rest && method === 'GET') {
        const design = url.searchParams.get('design');
        const parcel = url.searchParams.get('parcel');
        const agreements = [...index.agreements.values()].filter(row => (!design || row.designCids.includes(design))
          && (!parcel || row.inputParcelIds.includes(parcel))).reverse();
        return json(route, 200, { agreements, count: agreements.length });
      }
      const decisions = /^([^/]+)\/decisions$/.exec(rest);
      if (decisions) {
        const cid = decisions[1];
        if (!index.agreements.has(cid)) return refuse(route, 404, 'agreement_not_found', 'Agreement not found');
        if (method === 'GET') return json(route, 200, { agreementCid: cid, decisions: index.decisions.get(cid) || [] });
        if (method === 'POST') {
          const receipt = body?.receipt;
          if (!receipt || typeof receipt !== 'object') return refuse(route, 400, 'invalid_receipt', 'Body must be { receipt }.');
          const stored = index.decisions.get(cid) || [];
          const signature = receipt.decisionProof?.signature;
          const duplicate = !!signature && stored.some(item => item.decisionProof?.signature === signature);
          if (!duplicate) index.decisions.set(cid, [...stored, receipt]);
          return json(route, duplicate ? 200 : 201, { stored: true, duplicate });
        }
      }
      if (/^[^/]+$/.test(rest) && method === 'GET') {
        if (!isCid(rest)) return refuse(route, 400, 'invalid-cid', 'Not an agreement CID.');
        const row = index.agreements.get(rest);
        return row ? json(route, 200, row) : refuse(route, 404, 'agreement-not-found', 'Agreement not found');
      }
    }

    return refuse(route, 404, 'not-mocked', `The e2e index does not answer ${method} ${url.pathname}.`);
  });
}

/** Files a design/v1 object in the index as if it had been published elsewhere; returns its CID. */
export function fileDesign(index: SharedIndex, content: Record<string, any>, row: Record<string, any> = {}): string {
  const cid = cidOfObject(content);
  index.designs.set(cid, { ...designRow(index, cid, content), ...row });
  return cid;
}

// The index mockAllApiRoutes gave each page, for specs that read what the page published.
const pageIndexes = new WeakMap<Page, SharedIndex>();

/** The page's index, installed on first use (mockAllApiRoutes installs it before navigation). */
export async function ensurePageIndex(page: Page): Promise<SharedIndex> {
  const existing = pageIndexes.get(page);
  if (existing) return existing;
  const index = createSharedIndex();
  pageIndexes.set(page, index);
  await attachSharedIndex(page, index);
  return index;
}

/** The index this page publishes into (installed by mockAllApiRoutes). */
export function pageIndex(page: Page): SharedIndex {
  const index = pageIndexes.get(page);
  if (!index) throw new Error('This page has no e2e index: mock it with mockAllApiRoutes first.');
  return index;
}
