// Viewport massing derives from full source parcels: one outer bound plus the configurations
// (housing types) each parcel may be built as, independently of a design study.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { loadParcelEnvelopes, parcelOverlapProblems, parcelConfigurations, outerBound } from '../planning/parcel-envelopes.js';
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
    family1_maxheightft:35,family1_maxheightft_method:'direct_number',
    // A second usable type with tighter setbacks and a taller cap: the bound must take the
    // joined footprint and the tallest height, never one type's values.
    family2_treatment:'allowed',
    family2_sidesetbackft:10,family2_sidesetbackft_method:'direct_number',
    family2_rearsetbackft:20,family2_rearsetbackft_method:'direct_number',
    family2_maxheightft:45,family2_maxheightft_method:'direct_number',
    family3_treatment:'prohibited', family4_treatment:'allowed' };
const provider = (changes={}) => createAtlasProvider({type:'FeatureCollection',features:[{
    ...turf.bboxPolygon([-105.002,39.999,-105,40.001]),properties:{...properties,...changes}
}]},metadata);
const query = {city:'colorado',source:metadata.id,bbox};
const options = (features=[parcel()],source=provider(),complete=true) => ({sources:[source],
    parcelProvider:() => ({queryBounds:vi.fn(async () => ({features,complete}))})});

describe('viewport parcel envelopes', () => {
    it('produces an outer bound plus every recorded configuration without creating a study or proposal', async () => {
        const second = parcel('parcel-two',[-105.0005,40,-105,40.0004]);
        const features = [parcel(),second], before = JSON.stringify(features);
        const result = await loadParcelEnvelopes(query,options(features));
        expect(result.items).toHaveLength(2);
        const item = result.items[0];
        expect(item).toMatchObject({role:'permitted',proposalId:null,parcelEnvelope:true,areas:[],constraints:[],
            volumes:[{baseM:0,topM:45*0.3048}],assessment:{meaning:'outer-bound',status:'unresolved'},
            source:{scenario:null,parcel:'parcel-one'},
            sourceEvidence:{frontEdge:null,parcelReference:{parcelId:'parcel-one'},excludedConfigurations:{family3:'prohibited',
                accessory:'unrecorded',plannedresidential:'unrecorded'}}});
        expect(item.configurations.map(c => [c.id,c.treatment,c.unavailableReason,c.volumes.length])).toEqual([
            ['family1','hearing',null,1],['family2','allowed',null,1],['family4','allowed','missing-direct-height',0]]);
        expect(item.configurations[0].volumes[0].topM).toBeCloseTo(10.668,6);
        expect(item.configurations[1].volumes[0].topM).toBeCloseTo(13.716,6);
        expect(item.configurations[0].constraints.every(c => c.scenario === 'family1')).toBe(true);
        expect(item.derivation).toEqual({ parcel: parcel().geometry, covered: expect.objectContaining({ type: 'Polygon' }), frontEdges: [0,1,2,3] });
        expect(item.configurations[0]).not.toHaveProperty('frontEdges');
        expect(item.configurations[0].sourceReference.scenario).toBe('family1');
        // Every configuration sits inside the bound; the bound is the join of the drawable ones.
        for (const configuration of item.configurations.filter(c => c.volumes.length)) {
            const outside = turf.difference(turf.feature(configuration.volumes[0].geometry),turf.feature(item.volumes[0].geometry));
            expect(outside ? turf.area(outside) : 0).toBeLessThan(0.01);
        }
        expect(item.metrics.footprintM2).toBeCloseTo(turf.area(turf.feature(item.configurations[0].volumes[0].geometry)),3);
        expect(result.items[1].id).not.toBe(item.id);
        expect(JSON.stringify(features)).toBe(before);
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
    it('lists a configuration whose height is estimated as unavailable rather than dropping or drawing it', async () => {
        const result = await loadParcelEnvelopes(query,options([parcel()],provider({family1_maxheightft_method:'estimation'})));
        expect(result.items[0].configurations.find(c => c.id === 'family1')).toMatchObject({unavailableReason:'missing-direct-height',volumes:[]});
        expect(result.items[0].volumes[0].topM).toBeCloseTo(13.716,6);
    });
    it.each([
        [{family1_maxheightft_method:'estimation',family2_maxheightft:null,family4_treatment:'nomention'},'missing-direct-height'],
        [{family1_treatment:'prohibited',family2_treatment:'prohibited',family4_treatment:'prohibited'},'use-prohibited'],
        [{family1_treatment:'overlay',family2_treatment:'nomention',family3_treatment:'nomention',family4_treatment:null},'use-not-recorded']
    ])('withholds a parcel with no drawable configuration and names the reason %#', async (changes,reason) => {
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
    it('falls back to the requesting city\'s default parcel source when the Atlas entry pins none', async () => {
        const source = createAtlasProvider({type:'FeatureCollection',features:[{...turf.bboxPolygon([-105.002,39.999,-105,40.001]),properties}]},
            {...metadata,city:undefined,bbox:[-106,39,-104,41],parcelSourceId:undefined});
        const parcelProvider = vi.fn(() => ({queryBounds:async () => ({features:[parcel()],complete:true})}));
        const result = await loadParcelEnvelopes(query,{sources:[source],parcelProvider});
        expect(parcelProvider.mock.calls[0][0].id).toBe('us-co-oit-public-parcels-denver');
        expect(result.items[0].sourceEvidence.parcelReference.sourceId).toBe('us-co-oit-public-parcels-denver');
        await expect(loadParcelEnvelopes({...query,city:'nowhere'},{sources:[source],parcelProvider})).rejects.toMatchObject({code:'study-parcel-source-unavailable'});
    });
    it('reports an empty bound when no configuration draws', () => {
        expect(outerBound([{volumes:[]}])).toBeNull();
        expect(parcelConfigurations({source:{source:{recordId:'x'}}},['family1'],{family1:[]}).configurations).toEqual([]);
    });
    it('validates viewport route inputs before reading providers', async () => {
        const handlers={}, envelopeQuery=vi.fn(async()=>({items:[]}));
        setupPlanningRoutes({get:(path,fn)=>{handlers[path]=fn;}},{},{sources:[],envelopeQuery});
        const res={set:vi.fn(),status:vi.fn().mockReturnThis(),json:vi.fn()};
        await handlers['/planning/envelopes']({query:{...query,bbox:'-105,40,,41'}},res);
        expect(res.status).toHaveBeenCalledWith(400);expect(envelopeQuery).not.toHaveBeenCalled();
        await handlers['/planning/envelopes']({query:{...query,bbox:bbox.join(',')}},res);
        expect(envelopeQuery).toHaveBeenCalledWith({...query,scenario:undefined});
    });
});

describe('configuration display logic', () => {
    const item = (id='envelope:test:p1') => ({ id, role:'permitted', parcelEnvelope:true,
        spatialReference:{horizontal:'OGC:CRS84',vertical:'relative-ground',unit:'m'},
        volumes:[{id:'bound',geometry:turf.bboxPolygon(bbox).geometry,baseM:0,topM:13.716}],
        configurations:[
            {id:'family1',treatment:'hearing',unavailableReason:null,volumes:[{id:'a',geometry:turf.bboxPolygon([-105.001,40,-105.0007,40.0004]).geometry,baseM:0,topM:10.668}]},
            {id:'family2',treatment:'allowed',unavailableReason:null,volumes:[{id:'b',geometry:turf.bboxPolygon([-105.0009,40,-105.0005,40.0004]).geometry,baseM:0,topM:13.716}]},
            {id:'family4',treatment:'allowed',unavailableReason:'missing-direct-height',volumes:[]}],
        assessment:{meaning:'outer-bound'} });
    it('rolls deterministically over drawable configurations and changes with the dice', () => {
        const first = scene.configurationFor(item(), { variation: '' });
        expect(first).toEqual(scene.configurationFor(item(), { variation: '' }));
        expect(['family1','family2']).toContain(first.id);
        expect(scene.configurationFor(item(), { variation: '1' }).id).not.toBe(first.id);
        expect(scene.configurationFor(item(), { variation: '2' }).id).toBe(first.id);
        // Different parcels do not all land on the same configuration.
        const picks = new Set(Array.from({length:12},(_,i) => scene.configurationFor(item(`envelope:test:p${i}`), {}).id));
        expect(picks.size).toBe(2);
    });
    it('lets a housing-type pin and a per-parcel pin override the roll, including a type that cannot draw', () => {
        expect(scene.configurationFor(item(), { scenario:'family2' }).id).toBe('family2');
        expect(scene.configurationFor(item(), { scenario:'family4' })).toMatchObject({ id:'family4', volumes:[] });
        expect(scene.configurationFor(item(), { scenario:'family2', pins:{ 'envelope:test:p1':'family1' } }).id).toBe('family1');
        expect(scene.configurationFor({ ...item(), configurations: [] }, {})).toBeNull();
    });
    it('draws the bound as a hull around the shown configuration, and alone when asked', () => {
        const both = scene.permittedFeatures(item(), { permittedForm:'both' }, { scenario:'family1' });
        expect(both.bound.map(f => f.properties.geometryRole)).toEqual(['bound']);
        expect(both.body.map(f => [f.properties.geometryRole, f.properties.configurationId, f.properties.topM])).toEqual([['body','family1',10.668]]);
        expect(scene.permittedFeatures(item(), { permittedForm:'bound' }, { scenario:'family1' }).body).toEqual([]);
        const only = scene.permittedFeatures(item(), { permittedForm:'configuration' }, { scenario:'family1' });
        expect(only.bound).toEqual([]); expect(only.body).toHaveLength(1);
        // A pinned type without a drawable volume falls back to showing the bound rather than nothing.
        expect(scene.permittedFeatures(item(), { permittedForm:'configuration' }, { scenario:'family4' }).bound).toHaveLength(1);
        // One-option sources (no configurations) keep drawing their volumes as the body.
        const zagreb = { ...item(), configurations: undefined };
        expect(scene.permittedFeatures(zagreb, {}, {})).toMatchObject({ bound: [], configuration: null });
        expect(scene.permittedFeatures(zagreb, {}, {}).body).toHaveLength(1);
        const map = scene.mapFeatures(item(), 'footprint', turf, { permittedForm:'both' }, { scenario:'family2' });
        expect(map.map(f => f.properties.geometryRole)).toEqual(['bound','body']);
        expect(map[1].properties.topM).toBeCloseTo(13.716, 6);
    });
    it('rolls the assumed street side with the configuration and derives that side\'s body inside the parcel', () => {
        const parcelGeometry = turf.bboxPolygon(bbox).geometry;
        const constraints = [{quantity:'sideSetback',value:5,unit:'ft',evidence:'direct'},{quantity:'rearSetback',value:10,unit:'ft',evidence:'direct'},
            {quantity:'height',value:35,unit:'ft',evidence:'direct'}];
        const derived = { ...item(), derivation: { parcel: parcelGeometry, covered: parcelGeometry, frontEdges: [0,1,2,3] },
            configurations: [{ id:'family1', treatment:'allowed', unavailableReason:null, constraints, volumes:[{id:'u',geometry:parcelGeometry,baseM:0,topM:10.668}] }] };
        const deps = { geometry: turf, assessment: core };
        const first = scene.permittedFeatures(derived, { permittedForm:'both' }, { variation:'' }, deps);
        expect(first.body).toHaveLength(1);
        expect([0,1,2,3]).toContain(first.frontEdge);
        expect(first.body[0].properties).toMatchObject({ geometryRole:'body', configurationId:'family1', frontEdge:first.frontEdge, topM:expect.closeTo(10.668, 6) });
        const footprint = turf.area(first.body[0]);
        expect(footprint).toBeLessThan(turf.area(turf.feature(parcelGeometry)));
        expect(turf.difference(first.body[0], turf.feature(parcelGeometry))).toBeNull();
        const second = scene.permittedFeatures(derived, { permittedForm:'both' }, { variation:'1' }, deps);
        expect(second.frontEdge).not.toBe(first.frontEdge);
        expect(JSON.stringify(second.body[0].geometry)).not.toBe(JSON.stringify(first.body[0].geometry));
        // Without the evaluator the configuration's own all-sides volume is drawn and no side is claimed.
        const plain = scene.permittedFeatures(derived, { permittedForm:'both' }, { variation:'' });
        expect(plain.frontEdge).toBeNull(); expect(plain.body[0].geometry).toEqual(parcelGeometry);
        expect(scene.mapFeatures(derived, 'footprint', { union: turf.union, ...deps }, { permittedForm:'both' }, { variation:'' })
            .map(f => [f.properties.geometryRole, f.properties.frontEdge])).toEqual([['bound', undefined], ['body', first.frontEdge]]);
        expect([0,1,2,3].map(edge => scene.edgeSide(parcelGeometry, edge))).toEqual(['s','e','n','w']);
        expect(scene.frontEdgeFor({ id:'x' }, {})).toBeNull();
    });
    it('rolling switches a bound-only layer to Both so the roll is visible, and re-seeds every roll', () => {
        const store = scene.createStore({ permittedForm:'bound', proposedForm:'massing' });
        store.reroll();
        expect(store.get()).toMatchObject({ variation:'1', permittedForm:'both', proposedForm:'both' });
        store.configure('permittedForm','configuration'); store.reroll();
        expect(store.get()).toMatchObject({ variation:'2', permittedForm:'configuration' });
    });
    it('keeps zoning areas independent of the Permitted display control', () => {
        const sourceArea = {role:'permitted',assessment:{meaning:'zoning-area'}};
        const envelope = {role:'permitted',assessment:{meaning:'outer-bound'}};
        expect(scene.itemAppearance(sourceArea,{permitted:'solid'})).toBe('off');
        expect(scene.itemAppearance(envelope,{permitted:'solid'})).toBe('solid');
        expect(scene.itemAppearance(sourceArea,{permitted:'off',zoningAreas:'ghost'})).toBe('ghost');
        expect(scene.itemAppearance(envelope,{permitted:'off',zoningAreas:'ghost'})).toBe('off');
    });
});
