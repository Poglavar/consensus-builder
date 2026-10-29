// In-memory courier and index for published designs and agreements (plan-design-agreement.md, M2):
// POST /pins, POST/GET /designs, /designs/batch, /designs/binding, POST/GET /agreements and the owner
// decisions relay; and the M3 routes around a minted agreement: POST /agreements/:cid/onchain,
// GET /agreements?minted=1, GET /markets?city= (contests of the minted agreements, with LMSR markets in
// `markets`), GET /bets/:account, GET /oracle/recipes/agreement-execution-v1, the lens directory
// (GET /lenses/members, one member) with that member's GET /lens/attestations, and the activity reads
// GET /agent/activity and /activity/cities. Every page gets its own index from mockAllApiRoutes;
// attaching one index to pages in separate browser contexts models another device reading what this
// one published.
import { Page, Request, Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sampleParcels } from './parcel-data';
import { fixtureSiteBinding } from './site-binding';

const backendRequire = createRequire(path.resolve(__dirname, '../../../backend/package.json'));
const turf = backendRequire('@turf/turf');
// The Bets sheet's own order (frontend/js/bets/bets-model.js), as backend/markets/contests.js uses it.
const { compareContests, compareRows } = createRequire(__filename)('../../../frontend/js/bets/bets-model.js');

export interface IndexRequest { method: string; path: string; body: any }

/** A minted agreement's current LMSR market shape. Quantities are six-decimal atomic strings. */
export interface MarketFixture {
  address: string; model: 'lmsr'; asset: 'devnet-usdc'; creator: string; b: string; qYes: string; qNo: string;
  seed: string; closesAt: number; graceSeconds: 0; maxPosition: '0'; paidOut: string;
  resolved?: boolean; outcome?: 'yes' | 'no' | 'void' | null;
}

export interface SharedIndex {
  /** Pinned objects by CID: their kind and canonical bytes as received (base64). */
  pins: Map<string, { kind: string; bytes: string }>;
  /** Indexed design rows by CID, as GET /designs/:cid answers them. */
  designs: Map<string, Record<string, any>>;
  /** Indexed agreement rows by CID, as GET /agreements/:cid answers them. */
  agreements: Map<string, Record<string, any>>;
  /** Named selections, independent of agreements. */
  plans: Map<string, Record<string, any>>;
  /** Relayed owner decisions (receipts) by agreement CID. */
  decisions: Map<string, any[]>;
  /** LMSR markets by agreement account, what GET /markets reads beside minted agreements. */
  markets: Map<string, MarketFixture>;
  /** The lens directory GET /lenses/members lists (one member with a service by default). */
  lensMembers: Array<Record<string, any>>;
  /** What the members' services list at GET <serviceUrl>/lens/attestations (filtered by kind, agreementCid). */
  lensAttestations: Array<Record<string, any>>;
  /** Every request the index answered, with its JSON body. */
  requests: IndexRequest[];
  /** The cadastre a design's site is bound against (backend checkProposalBinding, here by turf). */
  cadastre: any[];
}

// The directory's one member and the service it answers at (an origin no request leaves the browser for).
export const E2E_LENS_MEMBER_KEY = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
export const E2E_LENS_SERVICE_URL = 'https://lens-member.e2e.invalid';
// The program ids GET /markets names (agreement-client.js, market-client.js; devnet USDC).
export const AGREEMENT_PROGRAM_ID = 'GtdgeRH89f2qLj4j4v6NcecWSr6RDPP9y4TMfPCGA5jQ';
const MARKET_PROGRAM_ID = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';
const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

export function createSharedIndex(options: { cadastre?: any[] } = {}): SharedIndex {
  return {
    pins: new Map(), designs: new Map(), agreements: new Map(), plans: new Map(), decisions: new Map(), markets: new Map(),
    lensMembers: [{ key: E2E_LENS_MEMBER_KEY, kind: 'owner-consent', name: 'E2E lens member', serviceUrl: E2E_LENS_SERVICE_URL }],
    lensAttestations: [], requests: [],
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
  const hash = (input: Uint8Array) => createHash('sha256').update(input).digest();
  const root = bytes.length <= 256 * 1024 ? { codec: 0x55, digest: hash(bytes) }
    : backendRequire('../frontend/vendor/ipfs-file-cid/ipfs-file-cid.js').fileRoot(bytes, hash);
  return `b${base32(Uint8Array.from([0x01, root.codec, 0x12, 0x20, ...root.digest]))}`;
}

/** The CID of an object's canonical bytes. */
export const cidOfObject = (value: any): string => cidOfBytes(Buffer.from(canonicalJson(value), 'utf8'));

const isCid = (value: unknown): value is string => typeof value === 'string' && /^baf(?:krei|ybei)[a-z2-7]{52}$/.test(value);

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

function agreementRow(index: SharedIndex, cid: string, content: Record<string, any>, designs: Array<Record<string, any>>): Record<string, any> {
  const plan = index.plans.get(content.planCid);
  if (!plan || plan.cid !== content.planCid || cidOfObject(plan.content) !== content.planCid) {
    throw new Error(`Agreement ${cid} must reference an indexed plan snapshot.`);
  }
  const deadline = content.deadline ?? null;
  return {
    cid,
    city: designs[0]?.city ?? cityIdOf(content.city),
    title: content.title ?? null,
    author: content.author ?? null,
    planCid: plan.cid,
    designCids: [...plan.content.designCids],
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

// ---- markets: the city's agreements grouped by shared input land (backend/markets/contests.js) -------

const sortedIds = (ids: unknown): string[] => [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id ?? '').trim()).filter(Boolean))].sort();

// One agreement as GET /markets lists it: its chain status as the index recorded it, and its market.
function contestEntry(index: SharedIndex, row: Record<string, any>, contest: string): Record<string, any> {
  const account: string | null = row.onchain?.account ?? null;
  const market = account ? index.markets.get(account) || null : null;
  const chainStatus: string | null = account ? row.onchain.status ?? null : null;
  const deadlinePassed = !!row.deadline && Date.parse(row.deadline) <= Date.now();
  const closesAt = market?.closesAt ?? (row.deadline ? Math.floor(Date.parse(row.deadline) / 1000) : null);
  const live = chainStatus === 'active' && !deadlinePassed && closesAt !== null && Date.now() < closesAt * 1000;
  const canSettle = Boolean(market && !market.resolved && ((chainStatus && ['executed', 'cancelled', 'expired'].includes(chainStatus))
    || (chainStatus && closesAt !== null && Date.now() >= closesAt * 1000 + market.graceSeconds * 1000)));
  return {
    kind: 'agreement', cid: row.cid, account, title: row.title, author: row.author, city: row.city,
    status: ['executed', 'cancelled', 'expired'].includes(chainStatus || '') ? chainStatus : deadlinePassed ? 'expired' : 'active',
    chainStatus, deadline: row.deadline, createdAt: row.createdAt,
    designTitles: row.designCids.map((cid: string) => index.designs.get(cid)?.title ?? null).filter(Boolean),
    screenshotUrl: row.screenshotUrl, screenshotBeforeUrl: row.screenshotBeforeUrl, screenshotPairUrl: row.screenshotPairUrl,
    sponsor: row.onchain?.sponsor ?? null,
    parcelIds: sortedIds(row.inputParcelIds), parcelRefs: [], market,
    bettable: Boolean(market && !market.resolved && live), canSettle, canOpenMarket: Boolean(account && !market && live), contest,
  };
}

/** GET /markets?city=: the city's agreements in contests over shared input parcels, those with a minted one. */
export function marketsPayload(index: SharedIndex, city: string): Record<string, any> {
  const rows = [...index.agreements.values()].filter(row => row.city === city);
  // Union-find over shared input parcel ids.
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstByParcel = new Map<string, number>();
  rows.forEach((row, i) => sortedIds(row.inputParcelIds).forEach(id => {
    if (firstByParcel.has(id)) parent[find(i)] = find(firstByParcel.get(id)!);
    else firstByParcel.set(id, i);
  }));
  const groups = new Map<number, Record<string, any>[]>();
  rows.forEach((row, i) => groups.set(find(i), [...(groups.get(find(i)) || []), row]));
  const contests = [...groups.values()].map(group => {
    const parcelIds = sortedIds(group.flatMap(row => row.inputParcelIds));
    const id = `c-${createHash('sha256').update(`land:${JSON.stringify(parcelIds)}`).digest('hex').slice(0, 12)}`;
    const agreements = group.map(row => contestEntry(index, row, id)).sort(compareRows);
    const withMarket = agreements.filter(entry => entry.market);
    return {
      id, parcelIds, parcelRefs: [], agreementCount: agreements.length,
      mintedCount: agreements.filter(entry => entry.account).length,
      marketCount: withMarket.length, openMarketCount: agreements.filter(entry => entry.bettable).length,
      sharesAtomic: withMarket.reduce((sum, entry) => sum + BigInt(entry.market.qYes) + BigInt(entry.market.qNo), 0n).toString(),
      latestCreatedAt: agreements.map(entry => entry.createdAt).sort().at(-1) ?? null,
      agreements,
    };
  }).filter(contest => contest.mintedCount > 0).sort(compareContests);
  const summary = {
    contests: contests.length, agreements: contests.reduce((sum, contest) => sum + contest.agreementCount, 0),
    markets: contests.reduce((sum, contest) => sum + contest.marketCount, 0),
    openMarkets: contests.reduce((sum, contest) => sum + contest.openMarketCount, 0),
    sharesAtomic: contests.reduce((sum, contest) => sum + BigInt(contest.sharesAtomic), 0n).toString(),
  };
  return {
    city, generatedAt: new Date().toISOString(), summary, contests,
    cluster: 'devnet', agreementProgram: AGREEMENT_PROGRAM_ID, marketProgram: MARKET_PROGRAM_ID, stakeMint: DEVNET_USDC_MINT, stakeDecimals: 6,
  };
}

// ---- activity: what the index received, as GET /agent/activity and /activity/cities read it ---------

function indexEvents(index: SharedIndex): Record<string, any>[] {
  const agreements = [...index.agreements.values()].map(row => ({
    id: `agreement:${row.cid}:proposed`, source: 'live', action: { type: 'propose', agreementCid: row.cid },
    entity: { type: 'agreement', id: row.cid }, ok: true, transaction: null, occurredAt: row.createdAt, recordedAt: row.createdAt,
    message: `Agreement ${row.title || row.cid} was proposed.`,
    agreementName: row.title ?? null, designGoal: index.designs.get(row.designCids[0])?.goal ?? null, cityId: row.city ?? null,
  }));
  const designs = [...index.designs.values()].map(row => ({
    id: `design:${row.cid}:published`, source: 'live', action: { type: 'design', designCid: row.cid },
    entity: { type: 'design', id: row.cid }, ok: true, transaction: null, occurredAt: row.createdAt, recordedAt: row.createdAt,
    message: `Design ${row.title || row.cid} was published.`,
    designName: row.title ?? null, designGoal: row.goal ?? null, cityId: row.city ?? null,
  }));
  return [...agreements, ...designs].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
}

// ---- routes ----------------------------------------------------------------------------------------

const INDEX_PATH = /\/(pins|designs|agreements|plans|search)(?:\/([^?#]*))?$/;

function indexPathOf(request: Request): { root: string; rest: string } | null {
  // A navigation to /designs/<cid> or /agreements/<cid> is the app's own page, served by the frontend.
  if (request.isNavigationRequest() || (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr')) return null;
  const pathname = new URL(request.url()).pathname.replace(/\/$/, '');
  const match = INDEX_PATH.exec(pathname);
  return match ? { root: match[1], rest: match[2] || '' } : null;
}

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const membershipPage = (kind: string, rows: Record<string, any>[], params: URLSearchParams) => {
  const limit = Math.max(1, Math.min(200, Number(params.get('limit')) || 100));
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const items = rows.slice(offset, offset + limit), hasMore = offset + items.length < rows.length;
  return { [kind]: items, count: items.length, hasMore, nextOffset: hasMore ? offset + items.length : null };
};
const refuse = (route: Route, status: number, code: string, error: string, extra: Record<string, unknown> = {}) => json(route, status, { error, code, ...extra });

function bodyOf(request: Request): any {
  try { return request.postDataJSON(); } catch (_) { return null; }
}

// A design as POST /designs and the carried designs of POST /agreements index it, or a refusal.
function indexDesign(index: SharedIndex, entry: any):
    { row: Record<string, any>; existing: boolean } | { status: number; code: string; error: string; extra?: Record<string, unknown> } {
  if (!entry || !isCid(entry.cid)) return { status: 400, code: 'invalid-cid', error: 'cid must be a CIDv1 raw sha2-256 base32 CID (bafkrei…).' };
  const content = entry.content;
  if (!content || typeof content !== 'object' || content.schema !== 'design/v1') return { status: 400, code: 'invalid-design', error: 'content must be a design/v1 object.' };
  const computedCid = cidOfObject(content);
  if (computedCid !== entry.cid) return { status: 400, code: 'cid-mismatch', error: `The content is ${computedCid}, not ${entry.cid}.`, extra: { cid: entry.cid, computedCid } };
  const existing = index.designs.get(entry.cid);
  if (existing) return { row: existing, existing: true };
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

    if (root === 'search' && !rest && method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const limit = Math.min(50, Number(url.searchParams.get('limit')) || 20);
      const plans = [...index.plans.values()]
        .filter(row => row.content.title.toLowerCase().includes(q) || row.cid === q)
        .slice(0, limit).map(row => ({ cid: row.cid, title: row.content.title,
          city: row.content.view.city, designCount: row.content.designCids.length }));
      const designs = [...index.designs.values()]
        .filter(row => [row.title, row.author, row.cid].some(value => String(value || '').toLowerCase().includes(q)))
        .slice(0, limit).map(({ cid, title, author, city, goal }) => ({ cid, title, author, city, goal }));
      return json(route, 200, { plans, designs });
    }

    if (root === 'plans') {
      if (!rest && method === 'GET') {
        const design = url.searchParams.get('design');
        const rows = [...index.plans.values()].filter(row => !design || row.content.designCids.includes(design))
          .map(row => ({ ...row, title: row.content.title, designCids: row.content.designCids })).reverse();
        return json(route, 200, membershipPage('plans', rows, url.searchParams));
      }
      if (!rest && method === 'POST') {
        const content = body?.content;
        const cid = cidOfObject(content);
        if (!content || content.schema !== 'plan/v1' || !isCid(cid) || !Array.isArray(content.designCids) || !content.designCids.length) {
          return refuse(route, 400, 'invalid-plan', 'content must be a plan/v1 object with designCids.');
        }
        if (content.designCids.some((id: string) => !isCid(id) || !index.designs.has(id))) return refuse(route, 409, 'missing-designs', 'Publish every selected design before saving the plan.');
        const record = { cid, content };
        index.plans.set(cid, record);
        return json(route, 201, record);
      }
      const record = index.plans.get(rest);
      return record ? json(route, 200, record) : refuse(route, 404, 'missing-plan', 'This named plan was not found.');
    }

    if (root === 'pins' && !rest && method === 'POST') {
      if (!body || !['design', 'plan', 'agreement'].includes(body.kind)) return refuse(route, 400, 'invalid-kind', 'kind must be design, plan or agreement.');
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
        const outcome = indexDesign(index, body);
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
        return json(route, 200, { city: null, parcelSourceId: body.parcelSourceId, binding: {
          ...fixtureSiteBinding(body.site, Number(body.toleranceM) || 0, index.cadastre),
          parcelSource: { sourceId: body.parcelSourceId, snapshotId: null },
        } });
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
        const carriedPlan = body.plan;
        if (carriedPlan !== undefined && (!carriedPlan || carriedPlan.cid !== body.content.planCid
            || !carriedPlan.content || carriedPlan.content.schema !== 'plan/v1'
            || cidOfObject(carriedPlan.content) !== carriedPlan.cid)) {
          return refuse(route, 400, 'plan-mismatch', 'The carried plan must match agreement.planCid and its content identifier.');
        }
        const plan = carriedPlan || index.plans.get(body.content.planCid);
        if (!plan || plan.cid !== body.content.planCid || cidOfObject(plan.content) !== body.content.planCid) {
          return refuse(route, 422, 'plan-not-indexed', 'The agreement references a plan that is not indexed; send its content in plan.');
        }
        if (!Array.isArray(plan.content.designCids) || !plan.content.designCids.length
            || plan.content.designCids.some((designCid: unknown) => !isCid(designCid))) {
          return refuse(route, 400, 'invalid-plan', 'The referenced plan must list design CIDs.');
        }
        const linked: string[] = plan.content.designCids;
        for (const entry of body.designs || []) {
          if (!linked.includes(entry?.cid)) return refuse(route, 400, 'design-not-in-agreement', `Design ${entry?.cid} is not linked by the agreement.`, { design: entry?.cid });
          const outcome = indexDesign(index, entry);
          if (!('row' in outcome)) return refuse(route, outcome.status, outcome.code, outcome.error, { ...outcome.extra, design: entry.cid });
        }
        const missing = linked.filter(cid => !index.designs.has(cid));
        if (missing.length) return refuse(route, 422, 'design-not-indexed', `The agreement links ${missing.length} design(s) the index does not hold.`, { missing });
        index.plans.set(plan.cid, plan);
        const row = agreementRow(index, body.cid, body.content, linked.map(cid => index.designs.get(cid)!));
        index.agreements.set(body.cid, row);
        return json(route, 201, row);
      }
      if (!rest && method === 'GET') {
        const design = url.searchParams.get('design');
        const plan = url.searchParams.get('plan');
        const parcel = url.searchParams.get('parcel');
        const city = cityIdOf(url.searchParams.get('city'));
        const minted = url.searchParams.get('minted');
        if (minted !== null && minted !== '1') return refuse(route, 400, 'bad-request', 'minted must be 1.');
        const agreements = [...index.agreements.values()].filter(row => (!design || row.designCids.includes(design))
          && (!plan || row.planCid === plan)
          && (!parcel || row.inputParcelIds.includes(parcel)) && (!city || row.city === city)
          && (minted !== '1' || row.onchain)).reverse();
        return json(route, 200, membershipPage('agreements', agreements, url.searchParams));
      }
      // The index learns the chain account a sponsor minted (M3). It derives and reads nothing here: the
      // pointer is kept as sent, Active with its decision pending; 201 the first time, then 200.
      const onchain = /^([^/]+)\/onchain$/.exec(rest);
      if (onchain && method === 'POST') {
        const row = index.agreements.get(onchain[1]);
        if (!row) return refuse(route, 404, 'agreement-not-found', 'Agreement not found');
        if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['chain', 'cluster', 'account', 'signature'].includes(key))
            || body.chain !== 'solana' || typeof body.cluster !== 'string' || typeof body.account !== 'string') {
          return refuse(route, 400, 'bad-request', 'Body must be { chain, cluster, account, signature? }.');
        }
        if (row.content?.rule?.binding !== true) return refuse(route, 422, 'not-binding', 'Only a binding owners\' agreement is minted; this one does not bind.');
        if (row.onchain && (row.onchain.account !== body.account || row.onchain.cluster !== body.cluster)) {
          return refuse(route, 409, 'onchain-recorded-elsewhere', `The agreement is recorded on ${row.onchain.cluster} as ${row.onchain.account}.`);
        }
        const first = !row.onchain;
        row.onchain = first
          ? { chain: 'solana', cluster: body.cluster, programId: AGREEMENT_PROGRAM_ID, account: body.account, sponsor: row.content?.sponsor ?? null,
            status: 'active', decision: 'pending', signature: body.signature ?? null, observedAt: new Date().toISOString() }
          : { ...row.onchain, ...(body.signature && !row.onchain.signature ? { signature: body.signature } : {}), observedAt: new Date().toISOString() };
        return json(route, first ? 201 : 200, row);
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

  // The reads around minted agreements (M3), all GET: answered from the same index.
  const READ_PATH = /\/(markets|bets\/[^/]+|oracle\/recipes\/agreement-execution-v1|lenses\/members|lens\/attestations|agent\/activity|activity\/cities)$/;
  await page.route(url => READ_PATH.test(url.pathname.replace(/\/$/, '')), async route => {
    const request = route.request();
    if (request.method() !== 'GET' || request.isNavigationRequest() || !['fetch', 'xhr'].includes(request.resourceType())) return route.fallback();
    const url = new URL(request.url());
    const pathname = url.pathname.replace(/\/$/, '');
    // A member's service is its own origin; another service (a lens console typed URL) is not ours.
    if (pathname.endsWith('/lens/attestations') && url.origin !== E2E_LENS_SERVICE_URL) return route.fallback();
    index.requests.push({ method: 'GET', path: url.pathname + url.search, body: null });
    const params = url.searchParams;

    if (pathname.endsWith('/markets')) {
      const city = cityIdOf(params.get('city'));
      if (!city) return refuse(route, 400, 'bad-request', 'city query parameter is required');
      return json(route, 200, marketsPayload(index, city));
    }
    const bet = /\/bets\/([^/]+)$/.exec(pathname);
    if (bet) {
      // The link preview page; the browser navigates there, a fetch only reads it.
      const row = [...index.agreements.values()].find(item => item.onchain?.account === bet[1]);
      const next = `/?${new URLSearchParams({ ...(row?.city ? { city: row.city } : {}), bets: bet[1] })}`;
      return route.fulfill({
        status: row ? 200 : 404, contentType: 'text/html',
        body: `<!doctype html><title>${row ? `Will ${row.title || 'this agreement'} execute on-chain?` : 'Bet on cities'}</title><a href="${next}">Open</a>`,
      });
    }
    if (pathname.endsWith('/oracle/recipes/agreement-execution-v1')) {
      const account = params.get('agreement');
      if (!account) return refuse(route, 400, 'bad-request', 'agreement must be a Solana address');
      const row = [...index.agreements.values()].find(item => item.onchain?.account === account);
      if (!row) return refuse(route, 404, 'not-found', 'No minted agreement has this account.');
      return json(route, 200, { recipe: {
        id: 'agreement-execution-v1', version: 1, question: 'Will this agreement execute on-chain?',
        subject: { chain: 'solana:devnet', agreementAccount: account, agreementCid: row.cid, marketAccount: params.get('market') },
        outcomes: { executed: 'YES', cancelled: 'NO', expired: 'NO' },
      } });
    }
    if (pathname.endsWith('/lenses/members')) return json(route, 200, { members: index.lensMembers });
    if (pathname.endsWith('/lens/attestations')) {
      const kind = params.get('kind');
      const agreementCid = params.get('agreementCid');
      const attestations = index.lensAttestations.filter(att => (!kind || att.kind === kind)
        && (!agreementCid || att.payload?.agreementCid === agreementCid));
      return json(route, 200, { attestations, count: attestations.length });
    }
    if (pathname.endsWith('/agent/activity')) {
      const limit = Math.min(Math.max(Number.parseInt(params.get('limit') || '', 10) || 100, 1), 250);
      const agreement = params.get('agreement');
      const city = cityIdOf(params.get('city'));
      const indexed = indexEvents(index);
      // Match the live route: city filtering happens before the response limit, and unlocated
      // activity belongs only to the all-cities feed. Keep cityId on each event for the UI's
      // current-city filter and the scope assertions to inspect.
      const matching = indexed.filter(event =>
        (!agreement || event.entity?.id === agreement)
        && (!city || cityIdOf(event.cityId) === city));
      const events = matching.slice(-limit);
      const filters = {
        ...(agreement ? { agreement } : {}),
        ...(city ? { city } : {}),
      };
      return json(route, 200, {
        events, count: events.length, source: 'live',
        ...(Object.keys(filters).length ? { filters, scanWindow: 1000 } : {}),
      });
    }
    // /activity/cities: how many agreements each city holds (the globe's counts).
    const counts = new Map<string, number>();
    index.agreements.forEach(row => { if (row.city) counts.set(row.city, (counts.get(row.city) || 0) + 1); });
    const cities = [...counts].map(([id, agreements]) => ({ id, agreements })).sort((a, b) => b.agreements - a.agreements || a.id.localeCompare(b.id));
    return json(route, 200, { cities });
  });
}

/** Files a design/v1 object in the index as if it had been published elsewhere; returns its CID. */
export function fileDesign(index: SharedIndex, content: Record<string, any>, row: Record<string, any> = {}): string {
  const cid = cidOfObject(content);
  index.designs.set(cid, { ...designRow(index, cid, content), ...row });
  return cid;
}

/** Files an immutable plan snapshot that references designs already filed in this mock index. */
export function filePlan(index: SharedIndex, content: Record<string, any>): string {
  const cid = cidOfObject(content);
  if (!content || content.schema !== 'plan/v1' || !isCid(cid)) throw new Error('filePlan needs a plan/v1 object.');
  if (!Array.isArray(content.designCids) || !content.designCids.length
      || content.designCids.some((designCid: string) => !isCid(designCid) || !index.designs.has(designCid))) {
    throw new Error('filePlan needs every referenced design filed first.');
  }
  index.plans.set(cid, { cid, content });
  return cid;
}

/**
 * Files an agreement/v1 object in the index as if it had been proposed elsewhere (file its designs
 * first: the row takes its city from them); `row` overrides fields of the row, such as `onchain`.
 * Returns its CID.
 */
export function fileAgreement(index: SharedIndex, content: Record<string, any>, row: Record<string, any> = {}): string {
  const cid = cidOfObject(content);
  if (!content || content.schema !== 'agreement/v1' || Object.hasOwn(content, 'designs') || !isCid(content.planCid)) {
    throw new Error('fileAgreement needs agreement/v1 content with planCid and no inline designs.');
  }
  const plan = index.plans.get(content.planCid);
  if (!plan) throw new Error(`fileAgreement needs plan ${content.planCid} filed first.`);
  const designs = plan.content.designCids.map((designCid: string) => index.designs.get(designCid)).filter(Boolean);
  index.agreements.set(cid, { ...agreementRow(index, cid, content, designs), ...row });
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
