// Viewport massing derives from full source parcels and supported dimensions, independently of a design study.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { loadParcelEnvelopes, parcelOverlapProblems } from '../planning/parcel-envelopes.js';
import { createAtlasProvider } from '../planning/providers/atlas.js';
import { assembleParcelStudy } from '../planning/parcel-study.js';
import { setupPlanningRoutes } from '../routes/planning.js';
const require = createRequire(import.meta.url);
const core = require('../../frontend/js/planning/parcel-assessment.js');
const scene = require('../../frontend/js/planning/scene.js');
const metadata = { id:'atlas-envelope-test',city:'colorado',label:'Synthetic Atlas source',edition:'test',
    url:'https://example.test/source',parcelSourceId:'us-co-oit-statewide-parcels' };
const bbox = [-105.001,40,-105.0005,40.0004];
const parcel = (id='parcel-one', box=bbox) => ({ ...turf.bboxPolygon(box), id, properties:{parcelNumber:id} });
const properties = { slice_id:'one',jurisdiction:'Synthetic',family1_treatment:'hearing',
    family1_frontsetbackft:20,family1_frontsetbackft_method:'estimation',
    family1_sidesetbackft:5,family1_sidesetbackft_method:'direct_number',
    family1_rearsetbackft:10,family1_rearsetbackft_method:'direct_number',
    family1_maxheightft:35,family1_maxheightft_method:'direct_number' };
const provider = (changes={}) => createAtlasProvider({type:'FeatureCollection',features:[{
    ...turf.bboxPolygon([-105.002,39.999,-105,40.001]),properties:{...properties,...changes}
}]},metadata);
const query = {city:'colorado',source:metadata.id,scenario:'family1',bbox};
const options = (features=[parcel()],source=provider(),complete=true) => ({sources:[source],
    parcelProvider:() => ({queryBounds:vi.fn(async () => ({features,complete}))})});

describe('viewport parcel envelopes', () => {
    it('produces height-bounded volumes for visible parcels without creating a study or proposal', async () => {
        const second = parcel('parcel-two',[-105.0005,40,-105,40.0004]);
        const features = [parcel(),second], before = JSON.stringify(features);
        const result = await loadParcelEnvelopes(query,options(features));
        expect(result.items).toHaveLength(2);
        expect(result.items[0]).toMatchObject({role:'permitted',proposalId:null,parcelEnvelope:true,areas:[],
            volumes:[{baseM:0}],assessment:{meaning:'partial-envelope',status:'unresolved'},
            sourceEvidence:{frontEdge:null,parcelReference:{parcelId:'parcel-one'}}});
        expect(result.items[1].id).not.toBe(result.items[0].id);
        expect(JSON.stringify(features)).toBe(before);
        expect(scene.volumeFeatures(result.items[0])).toHaveLength(1);
        expect(scene.mapFeatures(result.items[0],'footprint',turf)[0].properties.topM).toBeCloseTo(10.668,6);
    });
    it('unions alternative front-edge interpretations instead of inventing a street-facing edge', async () => {
        const source = provider(), records = await source.record(null,{recordId:'one',scenario:'family1'});
        const context = assembleParcelStudy(parcel(),{id:metadata.parcelSourceId},records);
        const envelope = core.unorientedEnvelope(context,turf);
        expect(envelope.interpretations).toBe(4);
        for (let edge=0;edge<4;edge++) {
            const bound = core.derive(context,edge,turf);
            const outside = turf.difference(turf.feature(bound.geometry),turf.feature(envelope.geometry));
            expect(outside ? turf.area(outside) : 0).toBeLessThan(0.01);
        }
        expect(turf.difference(turf.feature(envelope.geometry),parcel())).toBeNull();
    });
    it.each([
        [{family1_maxheightft_method:'estimation'},'missing-direct-height'],
        [{family1_maxheightft:null},'missing-direct-height'],
        [{family1_treatment:'prohibited'},'use-prohibited']
    ])('withholds unsupported massing with an explicit reason %#', async (changes,reason) => {
        const result = await loadParcelEnvelopes(query,options([parcel()],provider(changes)));
        expect(result.items).toEqual([]);
        expect(result.unavailable).toEqual([{parcelId:'parcel-one',reason}]);
    });
    it('does not pick one of several overlapping parcel identities', async () => {
        const result = await loadParcelEnvelopes(query,options([parcel(),parcel('condo-unit')]));
        expect(result.items).toEqual([]);
        expect(result.unavailable.map(row=>row.reason)).toEqual(['overlapping-parcel-identities','overlapping-parcel-identities']);
    });
    it('isolates a failed geometry comparison and never treats it as evidence of non-overlap', () => {
        const records=[parcel(),parcel('second'),parcel('distant',[-106,40,-105.9995,40.0004])].map(parcel=>({parcel,bbox:turf.bbox(parcel)}));
        const problems=parcelOverlapProblems(records,{intersect:()=>{throw new Error('Geometry operation failed');}});
        expect([...problems]).toEqual([['parcel-one','envelope-geometry-error'],['second','envelope-geometry-error']]);
    });
    it('keeps failed zoning reads unavailable instead of relabelling them as missing parcel geometry', async () => {
        const source=provider();source.record=async()=>{throw new Error('Source transport unavailable');};
        await expect(loadParcelEnvelopes(query,options([parcel()],source))).rejects.toThrow('Source transport unavailable');
    });
    it('examines zoning over the full parcel, including parts outside the viewport', async () => {
        const source = createAtlasProvider({type:'FeatureCollection',features:[
            {...turf.bboxPolygon([-105.002,39.999,-105.00075,40.001]),properties},
            {...turf.bboxPolygon([-105.00075,39.999,-105,40.001]),properties:{...properties,slice_id:'two'}}
        ]},metadata);
        const result = await loadParcelEnvelopes({...query,bbox:[-105.001,40,-105.0009,40.0001]},options([parcel()],source));
        expect(result.items).toEqual([]);
        expect(result.unavailable[0].reason).toBe('study-multiple-zoning-areas');
    });
    it('refuses incomplete or oversized parcel reads instead of displaying a convenient subset', async () => {
        await expect(loadParcelEnvelopes(query,options([],provider(),false))).rejects.toMatchObject({code:'study-parcel-incomplete'});
        await expect(loadParcelEnvelopes(query,options(Array.from({length:401},(_,i)=>parcel(String(i)))))).rejects.toMatchObject({code:'envelope-area-too-large'});
    });
    it('keeps zoning areas independent of the Permitted display control', () => {
        const sourceArea = {role:'permitted',assessment:{meaning:'zoning-area'}};
        const envelope = {role:'permitted',assessment:{meaning:'partial-envelope'}};
        expect(scene.itemAppearance(sourceArea,{permitted:'solid'})).toBe('off');
        expect(scene.itemAppearance(envelope,{permitted:'solid'})).toBe('solid');
        expect(scene.itemAppearance(sourceArea,{permitted:'off',zoningAreas:'ghost'})).toBe('ghost');
        expect(scene.itemAppearance(envelope,{permitted:'off',zoningAreas:'ghost'})).toBe('off');
    });
    it('validates viewport route inputs before reading providers', async () => {
        const handlers={}, envelopeQuery=vi.fn(async()=>({items:[]}));
        setupPlanningRoutes({get:(path,fn)=>{handlers[path]=fn;}},{},{sources:[],envelopeQuery});
        const res={set:vi.fn(),status:vi.fn().mockReturnThis(),json:vi.fn()};
        await handlers['/planning/envelopes']({query:{...query,bbox:'-105,40,,41'}},res);
        expect(res.status).toHaveBeenCalledWith(400);expect(envelopeQuery).not.toHaveBeenCalled();
        await handlers['/planning/envelopes']({query:{...query,bbox:bbox.join(',')}},res);
        expect(envelopeQuery).toHaveBeenCalledWith(query);
    });
});
