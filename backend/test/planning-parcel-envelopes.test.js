// Viewport massing derives from full source parcels: one outer bound plus the configurations
// (housing types) each parcel may be built as, independently of a design study.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { loadParcelEnvelopes, parcelOverlapProblems, parcelConfigurations, outerBound, lotAreaTest } from '../planning/parcel-envelopes.js';
import { createAtlasProvider } from '../planning/providers/atlas.js';
import { assembleParcelStudy } from '../planning/parcel-study.js';
import { setupPlanningRoutes } from '../routes/planning.js';
const require = createRequire(import.meta.url);
const core = require('../../frontend/js/planning/parcel-assessment.js');
const scene = require('../../frontend/js/planning/scene.js');
const envelopes = require('../../frontend/js/planning/envelopes.js');
const metadata = { id:'atlas-envelope-test',city:'colorado',label:'Synthetic Atlas source',edition:'test',
    url:'https://example.test/source',parcelSourceId:'us-co-oit-statewide-parcels' };
const bbox = [-105.001,40,-105.0005,40.0004];
const parcel = (id='parcel-one', box=bbox) => ({ ...turf.bboxPolygon(box), id, properties:{parcelNumber:id} });
const properties = { slice_id:'one',jurisdiction:'Synthetic',family1_treatment:'hearing',
    family1_frontsetbackft:20,family1_frontsetbackft_method:'estimation',
    family1_sidesetbackft:5,family1_sidesetbackft_method:'direct_number',
    family1_rearsetbackft:10,family1_rearsetbackft_method:'direct_number',
    family1_maxheightft:35,family1_maxheightft_method:'direct_number',
    family1_minlotacres:0.25,family1_minlotacres_method:'direct_number',
    // A second usable type with tighter setbacks and a taller cap: the bound must take the
    // joined footprint and the tallest height, never one type's values.
    family2_treatment:'allowed',
    family2_sidesetbackft:10,family2_sidesetbackft_method:'direct_number',
    family2_rearsetbackft:20,family2_rearsetbackft_method:'direct_number',
    family2_maxheightft:45,family2_maxheightft_method:'direct_number',
    family2_minlotacres:1,family2_minlotacres_method:'direct_number',
    family3_treatment:'prohibited', family4_treatment:'allowed' };
const provider = (changes={}) => createAtlasProvider({type:'FeatureCollection',features:[{
    ...turf.bboxPolygon([-105.002,39.999,-105,40.001]),properties:{...properties,...changes}
}]},metadata);
const query = {city:'colorado',source:metadata.id,bbox};
const options = (features=[parcel()],source=provider(),complete=true) => ({sources:[source],
    parcelProvider:() => ({queryBounds:vi.fn(async () => ({features,complete}))})});
const streetData = (latitude=39.9999) => ({ type:'FeatureCollection', source:'overpass', partial:false, truncated:false,
    features:[turf.lineString([[-105.002,latitude],[-105,latitude]],{osm_id:'street-one',name:'Example Street',highway:'residential'})] });

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
        // The parcel (about 0.47 acres) reaches one-family's minimum lot, not two-family's; the
        // below-minimum type is still drawn, flagged, and a type without a minimum is unknown.
        expect(item.configurations.map(c => c.lotArea.status)).toEqual(['pass','fail','unknown']);
        expect(item.configurations[1].lotArea).toMatchObject({ minimumM2: 4046.8564224, parcelM2: expect.closeTo(turf.area(parcel()), 3) });
        expect(lotAreaTest(100, [{ quantity:'lotArea', value:0.02, unit:'acres', evidence:'estimated' }]).status).toBe('unknown');
        expect(lotAreaTest(100, [{ quantity:'lotArea', value:100, unit:'m2', evidence:'direct' }]).status).toBe('pass');
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
    it('orients every configuration from nearby streets and measures setbacks from the original lot lines', async () => {
        const features = [parcel()], before = JSON.stringify(features);
        const streetProvider = { near:vi.fn(async () => streetData()) };
        const opts = { ...options(features,provider({family1_frontsetbackft_method:'direct_number'})),streetProvider };
        const result = await loadParcelEnvelopes({...query,bbox:[-105.0009,40.0001,-105.0008,40.0002]},opts);
        const item = result.items[0], config = item.configurations.find(c => c.id === 'family1');
        expect(item.sourceEvidence).toMatchObject({frontEdge:0,envelopeMeaning:'outer-bound-across-configurations',
            frontage:{basis:'street',source:'overpass',street:{name:'Example Street',id:'street-one'}}});
        expect(item.derivation.frontEdges).toEqual([0]);
        expect(item.configurations.every(c => c.edgeInterpretations === 1)).toBe(true);
        const [w,s,e,n] = turf.bbox(turf.feature(config.volumes[0].geometry));
        const distanceM = (a,b) => turf.distance(turf.point(a),turf.point(b),{units:'meters'});
        expect(distanceM([w,bbox[1]],[w,s])).toBeCloseTo(20*0.3048,2);
        expect(distanceM([e,n],[e,bbox[3]])).toBeCloseTo(10*0.3048,2);
        // The lookup covers the complete source parcel and nearby roads, not only the viewport.
        expect(streetProvider.near).toHaveBeenCalledTimes(1);
        const lookup = streetProvider.near.mock.calls[0][0];
        expect(lookup[0]).toBeLessThan(bbox[0]); expect(lookup[1]).toBeLessThan(bbox[1]);
        expect(lookup[2]).toBeGreaterThan(bbox[2]); expect(lookup[3]).toBeGreaterThan(bbox[3]);
        // Moving the road to the other side changes the front and both server-derived forms.
        streetProvider.near.mockResolvedValue(streetData(40.0005));
        const opposite = (await loadParcelEnvelopes(query,opts)).items[0];
        expect(opposite.sourceEvidence.frontEdge).toBe(2);
        expect(opposite.configurations[0].volumes[0].geometry).not.toEqual(config.volumes[0].geometry);
        expect(opposite.volumes[0].geometry).not.toEqual(item.volumes[0].geometry);
        expect(JSON.stringify(features)).toBe(before);
    });
    it.each(['partial','truncated','failure','no-street'])('retains an unoriented bound when streets are %s', async state => {
        const streetProvider = {near:vi.fn(async () => {
            if (state === 'failure') throw new Error('Street source unavailable');
            return {...streetData(),features:state === 'no-street' ? [] : streetData().features,
                partial:state === 'partial',truncated:state === 'truncated'};
        })};
        const item = (await loadParcelEnvelopes(query,{...options(),streetProvider})).items[0];
        expect(item.sourceEvidence).toMatchObject({frontEdge:null,frontage:{basis:'unknown',
            reason:state === 'no-street' ? 'no-facing-street' : 'street-data-unavailable'}});
        expect(item.derivation.frontEdges).toEqual([0,1,2,3]);
        expect(envelopes.frontEdgeFor(item,{variation:'2'})).toBeNull();
        expect(item.volumes).toHaveLength(1);
    });
    it('skips street lookup when the parcel source returns no parcels', async () => {
        const streetProvider = {near:vi.fn()};
        expect((await loadParcelEnvelopes(query,{...options([]),streetProvider})).items).toEqual([]);
        expect(streetProvider.near).not.toHaveBeenCalled();
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
    it('requires an explicitly pinned parcel source instead of inferring one from the requesting city', async () => {
        const source = createAtlasProvider({type:'FeatureCollection',features:[{...turf.bboxPolygon([-105.002,39.999,-105,40.001]),properties}]},
            {...metadata,city:undefined,bbox:[-106,39,-104,41],parcelSourceId:undefined});
        const parcelProvider = vi.fn();
        await expect(loadParcelEnvelopes(query,{sources:[source],parcelProvider})).rejects.toMatchObject({code:'study-parcel-source-unavailable'});
        expect(parcelProvider).not.toHaveBeenCalled();
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
        const first = envelopes.configurationFor(item(), { variation: '' });
        expect(first).toEqual(envelopes.configurationFor(item(), { variation: '' }));
        expect(['family1','family2']).toContain(first.id);
        expect(envelopes.configurationFor(item(), { variation: '1' }).id).not.toBe(first.id);
        expect(envelopes.configurationFor(item(), { variation: '2' }).id).toBe(first.id);
        // Different parcels do not all land on the same configuration.
        const picks = new Set(Array.from({length:12},(_,i) => envelopes.configurationFor(item(`envelope:test:p${i}`), {}).id));
        expect(picks.size).toBe(2);
    });
    it('prefers the housing types the parcel qualifies for by lot size, and rolls over all when none does', () => {
        const flagged = (statuses) => { const entry = item(); entry.configurations.forEach((c, i) => { c.lotArea = { status: statuses[i] }; }); return entry; };
        const rolls = (entry) => new Set(['', '1', '2', '3'].map(variation => envelopes.configurationFor(entry, { variation }).id));
        expect(rolls(flagged(['fail','pass','unknown']))).toEqual(new Set(['family2']));
        expect(rolls(flagged(['unknown','fail','pass']))).toEqual(new Set(['family1']));
        expect(rolls(flagged(['fail','fail','fail']))).toEqual(new Set(['family1','family2']));
        // An explicit pin still shows a below-minimum type.
        expect(envelopes.configurationFor(flagged(['fail','pass','pass']), { scenario:'family1' }).id).toBe('family1');
    });
    it('lets a housing-type pin and a per-parcel pin override the roll, including a type that cannot draw', () => {
        expect(envelopes.configurationFor(item(), { scenario:'family2' }).id).toBe('family2');
        expect(envelopes.configurationFor(item(), { scenario:'family4' })).toMatchObject({ id:'family4', volumes:[] });
        expect(envelopes.configurationFor(item(), { scenario:'family2', pins:{ 'envelope:test:p1':'family1' } }).id).toBe('family1');
        expect(envelopes.configurationFor({ ...item(), configurations: [] }, {})).toBeNull();
    });
    it('draws the bound as a hull around the shown configuration, and alone when asked', () => {
        const both = envelopes.realize(item(), { form:'both', selection:{ scenario:'family1' } });
        expect(both.bound.map(f => f.properties.geometryRole)).toEqual(['bound']);
        expect(both.body.map(f => [f.properties.geometryRole, f.properties.configurationId, f.properties.topM])).toEqual([['body','family1',10.668]]);
        expect(envelopes.realize(item(), { form:'bound', selection:{ scenario:'family1' } }).body).toEqual([]);
        const only = envelopes.realize(item(), { form:'configuration', selection:{ scenario:'family1' } });
        expect(only.bound).toEqual([]); expect(only.body).toHaveLength(1);
        // A pinned type without a drawable volume falls back to showing the bound rather than nothing.
        expect(envelopes.realize(item(), { form:'configuration', selection:{ scenario:'family4' } }).bound).toHaveLength(1);
        // One-option sources (no configurations) keep drawing their volumes as the body.
        const zagreb = { ...item(), configurations: undefined };
        expect(envelopes.realize(zagreb)).toMatchObject({ bound: [], configuration: null });
        expect(envelopes.realize(zagreb).body).toHaveLength(1);
        const map = envelopes.mapFeatures(item(), { detail:'footprint', form:'both', selection:{ scenario:'family2' }, deps:{ geometry: turf } });
        expect(map.map(f => f.properties.geometryRole)).toEqual(['bound','body']);
        expect(map[1].properties.topM).toBeCloseTo(13.716, 6);
    });
    it('keeps the street-facing edge and server geometry when configurations are shuffled or pinned', async () => {
        const derived = (await loadParcelEnvelopes(query,{...options(),streetProvider:{near:async () => streetData()}})).items[0];
        const parcelGeometry = derived.derivation.parcel;
        const deps = { geometry: turf, assessment: core };
        const first = envelopes.realize(derived, { form:'both', selection:{ variation:'' }, deps });
        expect(first.body).toHaveLength(1);
        expect(first.frontEdge).toBe(0);
        expect(first.body[0].properties).toMatchObject({ geometryRole:'body', configurationId:'family1', frontEdge:first.frontEdge, topM:expect.closeTo(10.668, 6) });
        const footprint = turf.area(first.body[0]);
        expect(footprint).toBeLessThan(turf.area(turf.feature(parcelGeometry)));
        expect(turf.difference(first.body[0], turf.feature(parcelGeometry))).toBeNull();
        for (const selection of [{variation:'1'},{variation:'2'},{scenario:'family2'},{pins:{[derived.id]:'family1'}}]) {
            const result = envelopes.realize(derived,{form:'both',selection,deps});
            expect(result.frontEdge).toBe(0);
            expect(result.body[0].geometry).toEqual(result.configuration.volumes[0].geometry);
        }
        // The API and browser use the same oriented volume, without another client-side solve.
        const plain = envelopes.realize(derived, { form:'both', selection:{ variation:'' } });
        expect(plain.frontEdge).toBe(0); expect(plain.body[0].geometry).toEqual(first.body[0].geometry);
        expect(envelopes.mapFeatures(derived, { detail:'footprint', form:'both', selection:{ variation:'' }, deps })
            .map(f => [f.properties.geometryRole, f.properties.frontEdge])).toEqual([['bound', undefined], ['body', first.frontEdge]]);
        expect([0,1,2,3].map(edge => envelopes.edgeSide(parcelGeometry, edge))).toEqual(['s','e','n','w']);
        expect(envelopes.frontEdgeFor({ id:'x' }, {})).toBeNull();
        expect(envelopes.frontEdgeFor({...derived,sourceEvidence:{frontEdge:3}})).toBeNull();
    });
    it('rerolls permitted and proposed variations independently and preserves settings and selection', () => {
        const store = scene.createStore({ permittedForm:'bound', proposedForm:'massing' });
        store.select('parcel-a');
        const settingsBefore = scene.settings(store.get());
        store.reroll('permitted');
        expect(store.get()).toMatchObject({ permittedVariation:'1', proposedVariation:'', permittedForm:'both', proposedForm:'massing', selectedId:'parcel-a' });
        expect(scene.settings(store.get())).toEqual({ ...settingsBefore, permittedForm:'both' });
        store.configure('permittedForm','configuration');
        const permittedForm = store.get().permittedForm;
        store.reroll('proposed');
        expect(store.get()).toMatchObject({ permittedVariation:'1', proposedVariation:'1', permittedForm, proposedForm:'both', selectedId:'parcel-a' });
        expect(scene.settings(store.get())).toEqual({ ...settingsBefore, permittedForm, proposedForm:'both' });
        const beforeInvalid = store.get();
        expect(store.reroll('existing')).toBe(beforeInvalid);
        expect(store.get()).toBe(beforeInvalid);
        expect(store.reroll()).toBe(beforeInvalid);
        expect(store.get()).toBe(beforeInvalid);
    });
    it('labels a street edge by its outward direction despite uneven source digitization or reversed winding', () => {
        const [w,s,e,n] = bbox;
        const bottom = Array.from({length:21},(_,i) => [w+(e-w)*i/20,s]);
        const ring = [...bottom,[e,n],[w,n],[w,s]];
        expect(envelopes.edgeSide({type:'Polygon',coordinates:[ring]},22)).toBe('w');
        expect(envelopes.edgeSide({type:'Polygon',coordinates:[ring.slice().reverse()]},0)).toBe('w');
    });
    it('shows a fixed Illustration control for a source with one calculated option', () => {
        const source = { id: 'cached-option', capabilities: { volumes: true } };
        expect(scene.permittedRepresentationControl(source, 'both')).toEqual({
            values: ['configuration'], value: 'configuration', disabled: true
        });
        expect(scene.permittedRepresentationControl(null)).toMatchObject({ disabled: true });
    });
    it('restores the chosen representation when switching back to a source with alternatives', () => {
        const source = { parcelStudy: 'direct-dimensions.v1', capabilities: { areas: true, volumes: false } };
        const store = scene.createStore({ permittedForm: 'bound' });
        scene.permittedRepresentationControl({ capabilities: { volumes: true } }, store.get().permittedForm);
        expect(scene.permittedRepresentationControl(source, store.get().permittedForm)).toEqual({
            values: ['bound', 'configuration', 'both'], value: 'bound', disabled: false
        });
        expect(store.get().permittedForm).toBe('bound');
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
