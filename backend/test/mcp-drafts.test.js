// Intent artifacts are validated by the real index validators, and previews round-trip without writes.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { validateDesignContent } from '../routes/designs.js';
import { cidOf, cidOfObject } from '../cid.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { createTestPreviewLinks as createPreviewLinks } from './helpers/mcp-preview-store.js';
const require = createRequire(import.meta.url);
const builder = require('../../frontend/js/intent-design.js');
const links = require('../../frontend/js/draft-link.js');
const approval = require('../../frontend/js/approval-link.js');
const site = { type: 'Polygon', coordinates: [[[-0.1, 51.5], [-0.099, 51.5], [-0.099, 51.501], [-0.1, 51.501], [-0.1, 51.5]]] };
const common = { site, city: 'london', title: 'A drawing', authoredAt: '2026-10-23T00:00:00.000Z' };
describe('intent design artifacts', () => {
    it('enforces Row parcel eligibility and allows a site-first Row through the MCP draft operation', async () => {
        const first = { type:'Feature', id:'A', properties:{parcelId:'A'}, geometry:site };
        const tools = createUrbanGameTheoryTools({ mode:'hosted', env:{}, fetchImpl:async url => {
            const path = new URL(url).pathname;
            if (path === '/parcel-sources/test-source') return Response.json({ complete:true, features:[first] });
            if (path === '/designs/binding') return Response.json({ parcelSourceId:'test-source', binding:{coverage:'complete', parcels:[{parcelId:'A'}]} });
            throw new Error(`Unexpected route ${path}`);
        } });
        await expect(tools.draftBuilding({ city:'london', parcelSourceId:'test-source', parcelIds:['A'], typology:'row' }))
            .rejects.toMatchObject({ code:'row-needs-two-parcels' });
        const result = await tools.draftBuilding({ city:'london', parcelSourceId:'test-source', outline:site, typology:'row' });
        expect(result.design.goal).toBe('row');
        expect(result.design.site).toEqual(site);
        expect(result.design.geometry.buildings.length).toBeGreaterThan(0);
    });
    it('regenerates an exact layout member in place and refuses stale or unrelated replacement conflicts', async () => {
        const neighbor = { type: 'Polygon', coordinates: [[[-0.099, 51.5], [-0.098, 51.5], [-0.098, 51.501], [-0.099, 51.501], [-0.099, 51.5]]] };
        const expanded = { type: 'Polygon', coordinates: [[[-0.1, 51.5], [-0.098, 51.5], [-0.098, 51.501], [-0.1, 51.501], [-0.1, 51.5]]] };
        const calls = [];
        const previews = createPreviewLinks({ origin: 'https://mcp.example', appOrigin: 'https://app.example' });
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, resolveDraftReference: previews.resolve,
            fetchImpl: async (url, init) => {
                const path = new URL(url).pathname; calls.push(path);
                if (path === '/designs/binding') return Response.json({ parcelSourceId: 'test-source', binding: { coverage: 'complete', parcels: [] } });
                throw new Error(`Unexpected route ${path}`);
            } });
        const four = await tools.draftParcelLayout({ city: 'london', outline: site, algorithm: 'equal', count: 4, title: 'Equal plots' });
        expect(four.placement.status).toBe('placed');
        expect(four.design.parcelLayout.plots).toHaveLength(4);
        const beforePlan = structuredClone(four.plan);
        const requestsBeforeStale = calls.length;
        await expect(tools.draftParcelLayout({ city: 'london', outline: site, algorithm: 'equal', count: 5,
            plan: four.plan, replaceDesignCid: 'bafkreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }))
            .rejects.toMatchObject({ code: 'replace-design-not-found' });
        expect(calls).toHaveLength(requestsBeforeStale);
        expect(four.plan).toEqual(beforePlan);

        const five = await tools.draftParcelLayout({ city: 'london', outline: site, algorithm: 'equal', count: 5,
            plan: four.plan, replaceDesignCid: four.cid });
        expect(five.placement.status).toBe('placed');
        expect(five.design.parcelLayout.plots).toHaveLength(5);
        expect(five.plan.plan.designCids).toEqual([five.cid]);
        expect(four.plan.plan.designCids).toEqual([four.cid]);
        expect(four.design.parcelLayout.plots).toHaveLength(4);

        const withNeighbor = await tools.draftSpace({ city: 'london', outline: neighbor, spaceKind: 'park', plan: five.plan });
        expect(withNeighbor.placement.status).toBe('placed');
        const conflict = await tools.draftParcelLayout({ city: 'london', outline: expanded, algorithm: 'equal', count: 5,
            plan: withNeighbor.plan, replaceDesignCid: five.cid });
        expect(conflict.placement.status).toBe('refused');
        expect(conflict.plan).toMatchObject({ cid: withNeighbor.plan.cid, status: 'unchanged' });
        expect(conflict.designs).toBeUndefined();
    });
    it('places and relocates a tram station on its named track without displacing that plan member', async () => {
        const previews = createPreviewLinks({ origin: 'https://mcp.example', appOrigin: 'https://app.example' });
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, resolveDraftReference: previews.resolve,
            fetchImpl: async url => {
                if (new URL(url).pathname === '/designs/binding') return Response.json({ parcelSourceId: 'test-source', binding: { coverage: 'complete', parcels: [] } });
                throw new Error(`Unexpected route ${new URL(url).pathname}`);
            } });
        const track = await tools.draftTrack({ city: 'london', points: [[-0.1,51.5],[-0.099,51.5]], gauge: 1435, speed: 80, title: 'Tram line' });
        expect(track.placement.status).toBe('placed');
        const station = await tools.draftStation({ city: 'london', stationType: 'tram', point: [-0.0995,51.5],
            corridors: [track.cid], plan: track.plan, title: 'First stop' });
        expect(station.placement.status).toBe('placed');
        expect(station.plan.plan.designCids).toHaveLength(2);
        expect(station.plan.plan.designCids).toEqual(expect.arrayContaining([track.cid, station.cid]));
        expect(station.design.structureProposal.attachment.sourceId).toBe(track.cid);

        const relocated = await tools.draftStation({ city: 'london', stationType: 'tram', point: [-0.0994,51.5],
            corridors: [track.cid], plan: station.plan, replaceDesignCid: station.cid, title: 'Moved stop' });
        expect(relocated.placement.status).toBe('placed');
        expect(relocated.plan.plan.designCids).toHaveLength(2);
        expect(relocated.plan.plan.designCids).toEqual(expect.arrayContaining([track.cid, relocated.cid]));
        expect(relocated.design.structureProposal.attachment.sourceId).toBe(track.cid);
    });
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
        const plan = store.decorate(await tools.draftPlan({ designs: [first.draftRef], title: 'Park agreement plan' }));
        const ground = await tools.inspectGround({ designs: [first.draftRef] });
        const allocations = ground.outputs.map(output => ({ output: output.hash, to: { kind: 'public' } }));
        const agreement = store.decorate(await tools.draftAgreement({ currency: 'EUR', plan: plan.draftRef, allocations }));
        expect(agreement.agreement.planCid).toBe(plan.cid);
        expect(agreement.plan.content.designCids).toContain(first.cid);
        const compared = await tools.compare({ buildingSources:['osm'], targets: [fork.draftRef, agreement.draftRef] });
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
    ]) it(`${intent.kind} ${intent.algorithm || ''} yields an index-valid canonical design and object-reference preview`, async () => {
        const design = builder.build({ ...common, ...intent }, { turf });
        expect(validateDesignContent(design)).toMatchObject({ ok: true });
        const store = createPreviewLinks({ origin: 'https://mcp.example', appOrigin: 'https://app.example' });
        const { previewUrl, draftRef } = store.create({ design });
        expect(new URL(previewUrl).pathname).toBe('/designs');
        expect(new URL(previewUrl).hash).toBe('');
        expect(new URL(previewUrl).searchParams.get('draft')).toBe(draftRef);
        const decoded = await links.load(previewUrl, { fetchImpl: async url => Response.json(store.get(new URL(url).pathname.split('/').at(-1))), cidOf: cidOfObject });
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
        expect(result.parcelSourceId).toBe('selected-source');
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
        const plan = await tools.draftPlan({ designs: [cid], title: 'Indexed source plan' });
        const ground = await tools.inspectGround({ designs: [cid] });
        const allocations = ground.outputs.map(output => ({ output: output.hash, to: { kind: 'public' } }));
        expect((await tools.draftAgreement({ currency: 'EUR', plan: plan.draftArtifact, allocations })).parcelSourceId).toBe('non-default');
        const compared = await tools.compare({ buildingSources:['osm'], targets: [cid, cid] });
        expect(compared.alternatives.every(a => a.measurementErrors.length === 0)).toBe(true);
        expect(bindings).toEqual(['non-default', 'non-default', 'non-default', 'non-default', 'non-default']);
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
