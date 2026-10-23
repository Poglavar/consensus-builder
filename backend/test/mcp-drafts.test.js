// Intent artifacts are validated by the real index validators, and previews round-trip without writes.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { validateDesignContent } from '../routes/designs.js';
import { cidOf, cidOfObject } from '../cid.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { createPreviewLinks } from '../agents/mcp-preview-links.js';
const require = createRequire(import.meta.url);
const builder = require('../../frontend/js/intent-design.js');
const links = require('../../frontend/js/draft-link.js');
const approval = require('../../frontend/js/approval-link.js');
const site = { type: 'Polygon', coordinates: [[[-0.1, 51.5], [-0.099, 51.5], [-0.099, 51.501], [-0.1, 51.501], [-0.1, 51.5]]] };
const common = { site, city: 'london', title: 'A drawing', authoredAt: '2026-10-23T00:00:00.000Z' };
describe('intent design artifacts', () => {
    it('modifies, compares and assembles private drafts by reference without copying geometry or publishing', async () => {
        const store = createPreviewLinks({ origin: 'https://mcp.example', appOrigin: 'https://urbangametheory.xyz' });
        const paths = [];
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, resolveDraftReference: store.resolve, fetchImpl: async (url, init) => {
            const path = new URL(url).pathname; paths.push(path);
            if (path === '/designs/binding') return Response.json({ parcelSourceId: 'private-test', binding: { coverage: 'complete', parcels: [{ parcelId: 'A' }] } });
            if (path === '/parcel-sources/private-test') return Response.json({ complete: true, features: [{ type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site }] });
            if (path === '/buildings/under') return Response.json({ supported: true, regions: Object.fromEntries(JSON.parse(init.body).regions.map(region => [region.key, []])) });
            throw new Error(`Unexpected index/publication route ${path}`);
        } });
        const first = store.decorate(await tools.draftSpace({ city: 'london', outline: site, spaceKind: 'park' }));
        const fork = store.decorate(await tools.modifyDesign({ design: { draftRef: first.draftRef, cid: first.cid }, changes: [{ type: 'set_kind', value: 'square' }] }));
        expect(fork.design.origin.cid).toBe(first.cid);
        expect(fork.parcelSourceId).toBe('private-test');
        await expect(tools.modifyDesign({ design: { draftRef: first.draftRef, cid: fork.cid }, changes: [{ type: 'retitle', value: 'Wrong identity' }] })).rejects.toMatchObject({ code: 'cid-mismatch' });
        await expect(tools.modifyDesign({ design: { design: first.design, cid: fork.cid }, changes: [{ type: 'retitle', value: 'Wrong copied identity' }] })).rejects.toMatchObject({ code: 'cid-mismatch' });
        const agreement = store.decorate(await tools.draftAgreement({ designs: [first.draftRef] }));
        expect(agreement.agreement.designs[0].cid).toBe(first.cid);
        const compared = await tools.compare({ targets: [fork.draftRef, agreement.draftRef] });
        expect(compared.alternatives.every(alternative => alternative.measurementErrors.length === 0)).toBe(true);
        expect(paths.some(path => /^\/designs\//.test(path) && path !== '/designs/binding')).toBe(false);
        await expect(store.resolve(first.draftRef.replace('mcp.example', 'other.example'))).rejects.toThrow(/this server/);
        store.clear(); await expect(tools.modifyDesign({ design: first.draftRef, changes: [{ type: 'retitle', value: 'Expired' }] })).rejects.toMatchObject({ code: 'draft-reference-expired' });
    });
    for (const intent of [
        { kind: 'road', points: [[-0.1, 51.5], [-0.099, 51.5]], preset: '1+1 with cycle lanes' },
        { kind: 'space', spaceKind: 'park' }, { kind: 'building', floors: 5, coverage: 0.4 },
        { kind: 'parcel-layout', algorithm: 'equal', count: 4 }, { kind: 'parcel-layout', algorithm: 'schelling' },
        { kind: 'urban-rule', rule: { floors: 6 } }
    ]) it(`${intent.kind} ${intent.algorithm || ''} yields an index-valid canonical design and reversible preview`, async () => {
        const design = builder.build({ ...common, ...intent }, { turf });
        expect(validateDesignContent(design)).toMatchObject({ ok: true });
        const preview = await links.build({ origin: 'https://app.example', design });
        expect(new URL(preview).pathname).toBe('/designs');
        const decoded = await links.parse(new URL(preview).hash);
        expect(decoded.design).toEqual(design);
        expect(cidOfObject(decoded.design)).toBe(cidOfObject(design));
    });
    it('widens an eastbound road northward and preserves its south boundary', () => {
        const road = builder.build({ ...common, kind: 'road', points: [[-0.1, 51.5], [-0.099, 51.5]], preset: '1+1' }, { turf });
        const wider = builder.modify(road, [{ type: 'widen', metres: 4, side: 'north' }], { turf });
        const before = turf.bbox(turf.feature(road.site)), after = turf.bbox(turf.feature(wider.site));
        expect(after[1]).toBeCloseTo(before[1], 7);
        expect(after[3]).toBeGreaterThan(before[3]);
        expect(validateDesignContent(wider)).toMatchObject({ ok: true });
    });
    it('rejects malformed lanes, null floors and oversized ground', () => {
        expect(() => builder.build({ ...common, kind: 'building', floors: null }, { turf })).toThrow(/floors or height/);
        expect(() => builder.build({ ...common, kind: 'road', points: [[0, 0], [0.001, 0]], lanes: [{ type: 'made-up', width: 4 }] }, { turf })).toThrow(/known lane/);
    });
    it('drafts through a read-only binding call, derives takes and never pins', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push([new URL(url).pathname, init?.method || 'GET']);
            return new Response(JSON.stringify({ parcelSourceId: 'selected-source', binding: { parcels: [{ parcelId: 'parcel-A' }], coverage: 'complete' } }));
        };
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl });
        const result = await tools.draftSpace({ city: 'london', outline: site, spaceKind: 'park' });
        expect(result.cid).toBe(cidOfObject(result.design));
        expect(new Date(result.design.authoredAt).toISOString()).toBe(result.design.authoredAt);
        expect(result.takes).toEqual(['parcel-A']);
        expect(result.parcelSourceId).toBe('selected-source');
        expect((await links.parse(new URL(result.previewUrl).hash)).parcelSourceId).toBe('selected-source');
        expect(calls).toEqual([['/designs/binding', 'POST']]);
    });
    it('preserves the indexed non-default parcel source when forking, comparing and drafting an agreement', async () => {
        const design = builder.build({ ...common, kind: 'space', spaceKind: 'park' }, { turf });
        const cid = cidOfObject(design), bindings = [];
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: async (url, init) => {
            const path = new URL(url).pathname;
            if (path === `/designs/${cid}`) return Response.json({ cid, content: design, binding: { parcelSource: { sourceId: 'non-default' } } });
            if (path === '/designs/binding') {
                bindings.push(JSON.parse(init.body).parcelSourceId);
                return Response.json({ binding: { coverage: 'complete', parcels: [{ parcelId: 'A' }] } });
            }
            if (path === '/parcel-sources/non-default') return Response.json({ complete: true, features: [{ type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site }] });
            if (path === '/buildings/under') return Response.json({ supported: true, regions: { [cid]: [] } });
            throw new Error(`Unexpected source route ${path}`);
        } });
        expect((await tools.modifyDesign({ design: cid, changes: [{ type: 'retitle', value: 'A fork' }] })).parcelSourceId).toBe('non-default');
        expect((await tools.draftAgreement({ designs: [cid] })).parcelSourceId).toBe('non-default');
        const compared = await tools.compare({ targets: [cid, cid] });
        expect(compared.alternatives.every(a => a.measurementErrors.length === 0)).toBe(true);
        expect(bindings).toEqual(['non-default', 'non-default', 'non-default', 'non-default']);
    });
});
describe('approval links', () => {
    it('round-trips a UnixFS agreement CID as an approval intent', () => {
        const bytes = new Uint8Array(256 * 1024 + 1);
        bytes.fill(0x61);
        const target = cidOf(bytes);
        expect(target).toMatch(/^bafybei[a-z2-7]{52}$/);
        const intent = { action: 'execute', target, params: { city: 'test-city' } };
        const url = new URL(approval.build({ origin: 'https://app.example', ...intent }));
        expect(url.pathname).toBe(`/agreements/${target}`);
        expect(approval.parse(url)).toEqual(intent);
    });

    it('round-trips a bet and refuses injected targets or amounts', () => {
        const intent = { action: 'bet', target: '11111111111111111111111111111111', params: { amount: '0.05', side: 'yes', city: 'london' } };
        expect(approval.parse(new URL(approval.build({ origin: 'https://app.example', ...intent })))).toEqual(intent);
        expect(() => approval.build({ action: 'mint', target: '../evil' })).toThrow();
        expect(() => approval.build({ ...intent, params: { amount: '-1' } })).toThrow();
        const button = { focus() {}, setAttribute() {} };
        expect(approval.preselect({ querySelector: () => button }, intent)).toBe(true);
        expect(button.click).toBeUndefined();
    });
});
