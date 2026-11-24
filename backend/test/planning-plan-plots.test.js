import { describe, expect, it, vi } from 'vitest';
import * as turf from '@turf/turf';
import { loadParcelEnvelopes } from '../planning/parcel-envelopes.js';
import { createAtlasProvider } from '../planning/providers/atlas.js';
import { createEnvelopeCache, setupPlanningRoutes } from '../routes/planning.js';

const metadata = { id: 'atlas-plan-test', city: 'colorado', label: 'Plan test', edition: 'test', url: 'https://example.test', parcelSourceId: 'us-co-oit-statewide-parcels' };
const props = { slice_id: 'zone', jurisdiction: 'Synthetic', family1_treatment: 'allowed', family1_frontsetbackft: 0, family1_frontsetbackft_method: 'direct_number', family1_sidesetbackft: 0, family1_sidesetbackft_method: 'direct_number', family1_rearsetbackft: 0, family1_rearsetbackft_method: 'direct_number', family1_maxheightft: 35, family1_maxheightft_method: 'direct_number' };
const source = () => createAtlasProvider({ type: 'FeatureCollection', features: [{ ...turf.bboxPolygon([-105.002, 39.999, -105, 40.001]), properties: props }] }, metadata);
const lot = (id, box) => ({ ...turf.bboxPolygon(box), id, properties: { parcelNumber: id } });
const bbox = [-105.001, 40, -105, 40.0004];
const plot = (id, ids, box, extra = {}) => ({ id, kind: 'formed', cadastreParcelIds: ids, geometry: turf.bboxPolygon(box).geometry, ...extra });
const options = (features, provider = source()) => ({ sources: [provider], parcelProvider: () => ({ queryBounds: vi.fn(async () => ({ features, complete: true })) }) });
const query = plots => ({ city: 'colorado', source: metadata.id, bbox, plots });

describe('plan plot envelope composition', () => {
    it('uses the same rules on all three land origins and names an unresolved government overlap', async () => {
        const base = createAtlasProvider(turf.featureCollection([{ ...turf.bboxPolygon(bbox), properties:props }]), metadata);
        const government = { ...base, record: async (...args) => (await base.record(...args)).map(zone => ({ ...zone, landBasis:'zone' })) };
        const cadastre = [lot('registered', bbox)];
        const official = (await loadParcelEnvelopes(query([]), options(cadastre, government))).items[0];
        const registered = (await loadParcelEnvelopes(query([]), options(cadastre, base))).items[0];
        const derived = plot('layout#1', [], bbox, { kind:'plot', producedByProposalId:'layout',
            planningArea:{ source:metadata.id, recordId:'zone' } });
        const answer = await loadParcelEnvelopes(query([derived]), options(cadastre, government));
        expect(answer.unavailable).toEqual([]);
        expect(answer.items).toHaveLength(1);
        const item = answer.items[0];
        expect([official, registered].map(entry => entry.metrics.heightM)).toEqual([item.metrics.heightM, item.metrics.heightM]);
        expect([official.site, registered.site]).toEqual([item.site, item.site]);
        expect(item.sourceEvidence).toMatchObject({ zoningRecordId:'zone', parcelReference:{ sourceId:'plan', parcelId:'layout#1', planningArea:derived.planningArea } });
        const conflict = await loadParcelEnvelopes(query([{ ...derived, planningArea:undefined }]), options(cadastre, government));
        expect(conflict.items).toEqual([]);
        expect(conflict.unavailable.map(x => [x.parcelId,x.reason])).toEqual([['layout#1','plan-plot-source-conflict'],['zone:zone','plan-plot-source-conflict']]);
    });
    it('a corridor supplies frontage and an unchanged multipart sibling still has its own envelope', async () => {
        const parent = 'registered', split = -105.0007;
        const parts = [plot('road#1', [parent], [bbox[0],bbox[1],split,bbox[3]], {kind:'road'}),
            plot('registered#cadastre-2', [parent], [split,bbox[1],bbox[2],bbox[3]], {kind:'part'})];
        const answer = await loadParcelEnvelopes(query(parts),options([lot(parent,bbox)]));
        expect(answer.items).toHaveLength(1);
        expect(answer.items[0].sourceEvidence).toMatchObject({ parcelReference:{kind:'part'},frontage:{basis:'street',source:'plan'} });
    });
    it('keeps a neighbouring government lot when a layout leaves cadastral ground outside its selected area', async () => {
        const middle = (bbox[0] + bbox[2]) / 2;
        const first = [bbox[0],bbox[1],middle,bbox[3]], next = [middle,bbox[1],bbox[2],bbox[3]];
        const base = createAtlasProvider(turf.featureCollection([first,next].map((box,i) =>
            ({...turf.bboxPolygon(box),properties:{...props,slice_id:String(i+1)}}))),metadata);
        const government = {...base,record: async (...args) => (await base.record(...args)).map(record => ({...record,landBasis:'zone'}))};
        const planningArea = {source:metadata.id,recordId:'1'};
        const pieces = [plot('layout#1',['a'],first,{kind:'plot',planningArea}),plot('a',['a'],next,{kind:'remainder',planningArea})];
        const answer = await loadParcelEnvelopes(query(pieces),options([lot('a',bbox)],government));
        expect(answer.unavailable).toEqual([]);
        expect(answer.items.map(item => item.id)).toEqual(['envelope:atlas-plan-test:layout#1','envelope:atlas-plan-test:zone:2']);
    });
    it('shares empty GET/POST answers and recomputes for a changed polygon with the same ID', async () => {
        const read = vi.fn(async () => ({})), cached = createEnvelopeCache(read);
        await Promise.all([cached(query(undefined)), cached(query([]))]);
        const a = plot('layout#1', [], bbox), b = plot(a.id, [], [bbox[0],bbox[1],bbox[2],40.0003]);
        await Promise.all([cached(query([a])),cached(query([a])),cached(query([b]))]);
        expect(read).toHaveBeenCalledTimes(3);
    });
    it('keeps unrelated saved massing and routes only the new plot to a lot-record adapter', async () => {
        const a = lot('a', [bbox[0],bbox[1],-105.0005,bbox[3]]), b = lot('b', [-105.0005,bbox[1],bbox[2],bbox[3]]);
        const provider = { descriptor: {id:'saved',city:'colorado',scenario:'edition'}, query: vi.fn(async () => ({
            items:[a,b].map(feature => ({id:'stored:' + feature.id,source:{parcel:feature.id}})), nextAfter:null })),
            plotGround:vi.fn(async () => ({features:[a,b],complete:true})),
            evaluatePlot:vi.fn(async (_pool, { parcel }) => ({item:{source:{id:'saved'},site:parcel.geometry,sourceEvidence:{solverVersion:'v1'}}})) };
        const get = {source:'saved',city:'colorado',bbox};
        const original = await loadParcelEnvelopes(get,{sources:[provider]});
        expect(original.items.map(item => item.id)).toEqual(['stored:a','stored:b']);
        expect(provider.plotGround).not.toHaveBeenCalled();
        const composed = await loadParcelEnvelopes({...get,plots:[plot('layout#1',['a'],turf.bbox(a))]},{sources:[provider]});
        expect(composed.items.map(item => item.id)).toEqual(['stored:b','envelope:saved:layout#1']);
        expect(composed.items[1].sourceEvidence).toMatchObject({solverVersion:'v1',parcelReference:{sourceId:'plan',cadastreParcelIds:['a']}});
        expect(provider.evaluatePlot).toHaveBeenCalledOnce();
    });
    it('replaces two cadastral lots with one envelope and retains unrelated lots', async () => {
        const lots = [lot('a', [-105.001, 40, -105.0007, 40.0004]), lot('b', [-105.0007, 40, -105.0004, 40.0004]), lot('c', [-105.0004, 40, -105, 40.0004])];
        const result = await loadParcelEnvelopes(query([plot('merged', ['a', 'b'], [-105.001, 40, -105.0004, 40.0004])]), options(lots));
        expect(result.items.map(item => item.source.parcel).sort()).toEqual(['c', 'merged']);
        expect(result.summaries[0].planPlots).toMatchObject({ replacedLots: 2, unmatchedCadastreIds: [] });
    });
    it('reports an unmatched replacement id as unavailable input', async () => {
        const result = await loadParcelEnvelopes(query([plot('formed', ['missing'], [-105.001, 40, -105.0004, 40.0004])]), options([lot('a', [-105.001, 40, -105, 40.0004])]));
        expect(result.summaries[0].planPlots.unmatchedCadastreIds).toEqual(['missing']);
        expect(result.unavailable.some(item => item.parcelId === 'a')).toBe(true);
    });
    it('keeps corridor plots for street frontage but does not draw an envelope', async () => {
        const roads = [plot('road', ['a'], [-105.001, 40, -105.0008, 40.0004], { kind: 'road' })];
        const result = await loadParcelEnvelopes(query(roads), options([lot('a', [-105.001, 40, -105, 40.0004])]));
        expect(result.unavailable).toEqual([]);
        expect(result.items).toHaveLength(0);
        expect(result.summaries[0].planPlots.replacedLots).toBe(1);
    });
    it('rejects malformed POST plot payloads with 422', async () => {
        const handlers = {};
        const app = { get: (path, fn) => { handlers[`GET ${path}`] = fn; }, post: (path, fn) => { handlers[`POST ${path}`] = fn; } };
        setupPlanningRoutes(app, null, { sources: [source()], envelopeQuery: vi.fn() });
        const res = { status: vi.fn(function () { return this; }), json: vi.fn(), set: vi.fn() };
        await handlers['POST /planning/envelopes']({ method: 'POST', body: { city: 'colorado', source: metadata.id, bbox, plots: [{ id: 'bad', kind: 'formed', cadastreParcelIds: [], geometry: { type: 'Point', coordinates: [0, 0] } }] } }, res);
        expect(res.status).toHaveBeenCalledWith(422);
    });
    it('shares identical envelope computations and evicts failed cache entries', async () => {
        let calls = 0, now = 0;
        const cache = createEnvelopeCache(async () => { calls++; return { value: 1 }; }, { now: () => now });
        const a = await cache({ city: 'colorado', source: metadata.id, bbox, plots: [] });
        const b = await cache({ city: 'colorado', source: metadata.id, bbox, plots: [] });
        expect(a).toEqual(b); expect(calls).toBe(1);
        now += 10 * 60 * 1000 + 1;
        await cache({ city: 'colorado', source: metadata.id, bbox, plots: [] });
        expect(calls).toBe(2);
    });
});
