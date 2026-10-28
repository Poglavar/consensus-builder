// Check typed MCP construction against the shared app geometry and retained constraints.
import { describe, expect, it } from 'vitest';
import { buildTypedDesign, validateTrackDesign } from '../agents/mcp-constructors.js';
import { appTurf as turf, constructorRuntime, intentDesign, intentEditing, corridorRuntime } from '../agents/mcp-geometry.js';
import { cidOfObject } from '../cid.js';
const site = { type: 'Polygon', coordinates: [[[15,45],[15.002,45],[15.002,45.002],[15,45.002],[15,45]]] };
const parcel = { type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site };
const common = { kind: 'building', site, city: 'london', floors: 4, authoredAt: '2026-01-01T00:00:00.000Z' };
const options = { parcels: [parcel] };
const rowParcels = [
    { ...parcel, geometry: { type:'Polygon', coordinates:[[[15,45],[15.001,45],[15.001,45.002],[15,45.002],[15,45]]] } },
    { ...parcel, id:'B', properties:{parcelId:'B'}, geometry: { type:'Polygon', coordinates:[[[15.001,45],[15.002,45],[15.002,45.002],[15.001,45.002],[15.001,45]]] } }
];
const rowOptions = { parcels: rowParcels };
const track = () => buildTypedDesign({ kind: 'track', points: [[15,45],[15.002,45]], gauge: 1000, speed: 80, authoredAt: common.authoredAt });
describe('MCP shared construction generators', () => {
    it.each([['freeform','single'],['block','buildings'],['row','row'],['detached','parcelBased']])('creates %s as its actual canonical typology', (typology, goal) => {
        const selected = typology === 'row' ? rowOptions : options;
        const design = buildTypedDesign({ ...common, typology }, selected);
        expect(design.goal).toBe(goal);
        expect(design.schema).toBe('design/v1');
        expect(design.geometry.buildings.length).toBeGreaterThan(0);
        expect(buildTypedDesign({ ...common, typology }, selected)).toEqual(design);
        for (const building of design.geometry.buildings) expect(turf.booleanWithin(building, parcel)).toBe(true);
    });
    it('derives freeform floors from an explicit height when floors are omitted', () => {
        const design = buildTypedDesign({ kind: 'building', typology: 'freeform', site, height: 21 }, options);
        expect(design.geometry.buildings[0].properties).toMatchObject({ floors: 7, height: 21 });
    });
    it('uses app editor defaults for Block, Row and Freeform starting geometry', () => {
        const block = buildTypedDesign({ kind: 'building', typology: 'block', site }, options);
        expect(block.buildingProposal.parameters).toMatchObject({ height: 17.5, width: 15, setback: 2, rule: { kind: 'exact', minPlotAreaM2: 50 } });
        const row = buildTypedDesign({ kind: 'building', typology: 'row', site }, rowOptions);
        const dimensions = constructorRuntime.buildingRules.createRowPlacement().calculate({ site: parcel, parcels: rowParcels.map(feature => ({feature})) });
        expect(row.buildingProposal.parameters).toMatchObject({ length: dimensions.maxLength, width: dimensions.maxLength/2, height: 12, rule: { kind: 'exact', minPlotAreaM2: 50 } });
        const freeform = buildTypedDesign({ kind: 'building', typology: 'freeform', site }, options);
        const [lng, lat] = turf.pointOnFeature(parcel).geometry.coordinates;
        expect(freeform.geometry.buildings[0].geometry.coordinates[0]).toEqual(constructorRuntime.singleBuilding.buildRectangleRing({lng,lat},{widthM:20,lengthM:20}));
        expect(freeform.geometry.buildings[0].properties.height).toBe(10);
    });
    it('uses the shared Block ring and Row chamfer generators without alternate massing', () => {
        const block = buildTypedDesign({ ...common, typology: 'block', setbackM: 4, depthM: 9 }, options);
        const ring = constructorRuntime.buildingRules.blockRingOutline(parcel, parcel, { setback: 4, width: 9, simplifyM: 0 });
        expect(block.geometry.blockMassing.geometry.coordinates[0]).toEqual(ring.outer.geometry.coordinates[0]);
        expect(block.geometry.blockMassing.geometry.coordinates).toHaveLength(2);
        const row = buildTypedDesign({ ...common, typology: 'row', lengthM: 45, depthM: 14, chamferM: 2, rotationDegrees: 12 }, rowOptions);
        const generated = constructorRuntime.buildingRules.rowFootprint({ site: parcel, parcels: rowParcels.map(feature => ({feature})) }, { lengthM:45,depthM:14,chamferM:2,rotationRadians:12*Math.PI/180,height:12 });
        expect(row.geometry.blockMassing.geometry).toEqual(generated.feature.geometry);
        expect(row.geometry.blockMassing.geometry.coordinates[0]).toHaveLength(9);
    });
    it('auto-fits Rows inside irregular and small sites using the editor search while preserving explicit dimensions', () => {
        const origin = [15,45], mx = 1/(111320*Math.cos(Math.PI/4)), my = 1/110540;
        const make = points => ({type:'Polygon',coordinates:[points.map(([x,y])=>[origin[0]+x*mx,origin[1]+y*my])]});
        for (const geometry of [make([[0,0],[60,0],[60,12],[12,12],[12,60],[0,60],[0,0]]), make([[0,0],[12,0],[12,12],[0,12],[0,0]])]) {
            const source = { ...parcel, geometry }, params = {kind:'building',typology:'row',site:geometry,minPlotAreaM2:0};
            const plots = constructorRuntime.sitePlots.cutPlots(geometry, {plotWidthM:7,turf});
            const generated = buildTypedDesign(params);
            expect(constructorRuntime.singleBuilding.footprintWithinBoundary(generated.geometry.blockMassing || generated.geometry.buildings[0],source,turf)).toBe(true);
            expect(generated.buildingProposal.parameters.length).toBeGreaterThan(4);
            const runtime = constructorRuntime.buildingRules.createRowPlacement();
            const dimensions = runtime.calculate({site:source,parcels:plots.map(feature => ({feature}))});
            expect(generated.buildingProposal.parameters.length).toBeCloseTo(dimensions.maxLength);
            const exact = buildTypedDesign({...params,lengthM:8,depthM:4});
            expect(exact.buildingProposal.parameters).toMatchObject({length:8,width:4});
            expect(() => buildTypedDesign({...params,lengthM:400,depthM:100})).toThrow(/does not fit/);
        }
    });
    it('requires two distinct selected parcels for Row and allows an outline cut into plots', () => {
        const intent = { ...common, typology:'row' };
        expect(() => buildTypedDesign(intent, options)).toThrow(/at least two selected parcels/);
        expect(() => buildTypedDesign(intent, { parcels:[parcel, parcel] })).toThrow(/at least two selected parcels/);
        expect(buildTypedDesign(intent, rowOptions).goal).toBe('row');
        expect(buildTypedDesign(intent).goal).toBe('row');
    });
    it('applies typed Block gaps, wings and chamfer through the shared editor shaping path', () => {
        const args={kind:'building',typology:'block',site};
        const baseline=buildTypedDesign(args,options);
        const gap=buildTypedDesign({...args,gapPositions:[0.15],gapWidthM:7},options);
        const wing=buildTypedDesign({...args,wingPositions:[0.15],wingLengthM:20},options);
        const combined=buildTypedDesign({...args,gapPositions:[0.15],gapWidthM:7,wingPositions:[0.65],wingLengthM:20,chamferM:1},options);
        expect(turf.area(gap.geometry.blockMassing)).toBeLessThan(turf.area(baseline.geometry.blockMassing));
        expect(turf.area(wing.geometry.blockMassing)).toBeGreaterThan(turf.area(baseline.geometry.blockMassing));
        expect(combined.buildingProposal.parameters).toMatchObject({gaps:[0.15],gapWidth:7,wings:[0.65],wingLength:20,chamfer:1});
        const ring=constructorRuntime.buildingRules.blockRingOutline(parcel,parcel,{setback:2,width:15,simplifyM:0});
        const shared=constructorRuntime.buildingRules.blockMassingFromRing(ring,parcel,{width:ring.widthAchieved,setback:2,height:17.5,gapPositions:[0.15],gapWidthM:7,wingPositions:[0.65],wingLengthM:20,chamferM:1});
        expect(combined.geometry.blockMassing.geometry).toEqual(shared.geometry);
        expect(() => buildTypedDesign({...args,gapPositions:[1.5]},options)).toThrow(/fractions/);
    });
    it('uses exact source identities and keeps detached exclusions visible in errors', () => {
        expect(() => buildTypedDesign({ ...common, typology: 'detached' })).toThrow(/source parcels/);
        expect(() => buildTypedDesign({ ...common, typology: 'detached', minPlotAreaM2: 100000 }, options)).toThrow(/No source parcel/);
        const design = buildTypedDesign({ ...common, typology:'detached', setbackM:5, ruleKind:'range', minFloors:2 },options);
        const rule = design.buildingProposal.parameters.rule;
        expect(design.geometry.buildings[0].geometry).toEqual(constructorRuntime.rules.evaluateParcel(parcel,rule,{turf,largestPolygon:constructorRuntime.footprints.toSingleLargestPolygon}).envelope.geometry);
        expect(design.geometry.buildings[0].properties.parcelId).toBe('A');
    });
    it('creates metre-gauge tracks and retains speed/radius/cross-section through modifications', () => {
        const original = track();
        const revised = intentDesign.modify(original, [{ type:'shift',metres:4,toward:'north' }],{turf});
        expect(revised.roadProposal.definition.metadata).toMatchObject({trackSpeed:80,trackMinRadius:500,isTrack:true});
        expect(corridorRuntime.osm.toView(revised.roadProposal.definition).profile.strips[0]).toMatchObject({type:'rail',gauge:1000,width:2.75});
        expect(() => validateTrackDesign(revised, original)).not.toThrow();
        const missing = structuredClone(revised); delete missing.roadProposal.definition.metadata;
        expect(() => validateTrackDesign(missing, original)).toThrow(/Retain/);
        expect(() => buildTypedDesign({kind:'track',points:[[15,45],[15.0001,45],[15.0001,45.0001]],speed:80})).toThrow(/bends violate/);
    });
    it.each(['bus','tram','underground','elevated'])('places %s only on compatible resolved alignments', stationType => {
        const corridor = stationType === 'bus' ? intentDesign.build({kind:'road',points:[[15,45],[15.002,45]],authoredAt:common.authoredAt},{turf}) : track();
        const design = buildTypedDesign({kind:'station',stationType,point:[15.001,45],platformHeightM:12,corridors:[{cid:cidOfObject(corridor),content:corridor}]});
        expect(design.goal).toBe('station');
        expect(design.structureProposal.stationType).toBe(stationType);
        expect(design.structureProposal.attachment.sourceId).toBe(cidOfObject(corridor));
        expect(design.structureProposal.geometry).toEqual(constructorRuntime.stations.createStationFootprint(design.structureProposal.center,design.structureProposal.bearing,stationType,turf));
        if(stationType==='elevated') expect(design.structureProposal.platformHeightM).toBe(12);
        expect(() => buildTypedDesign({kind:'station',stationType,point:[15.001,45.01],corridors:[{cid:cidOfObject(corridor),content:corridor}]})).toThrow(/compatible corridor/);
    });
    it('refuses incompatible station transport rather than silently authoring an unattached station', () => {
        expect(() => buildTypedDesign({kind:'station',stationType:'bus',point:[15.001,45],corridors:[{cid:'track',content:track()}]})).toThrow(/compatible corridor/);
    });
});

// The browser's Block editor saves the same shape as the constructor: per-parcel pieces beside the
// complete authored massing. MCP parity for its height slider is a height intent on all pieces, which
// re-stamps the massing; a single piece cannot be parted from the ring, nor can its footprint move.
describe('Block pieces and their coupled massing', () => {
    const twoParcels = [
        { ...parcel, geometry: { type: 'Polygon', coordinates: [[[15,45],[15.001,45],[15.001,45.002],[15,45.002],[15,45]]] } },
        { ...parcel, id: 'B', properties: { parcelId: 'B' }, geometry: { type: 'Polygon', coordinates: [[[15.001,45],[15.002,45],[15.002,45.002],[15.001,45.002],[15.001,45]]] } }
    ];
    const block = () => buildTypedDesign({ ...common, typology: 'block', ruleKind: 'max' }, { parcels: twoParcels });

    it('builds one building per parcel, each with its own seed, inside one massing', () => {
        const design = block();
        expect(design.geometry.buildings.map(b => b.properties.parcelId)).toEqual(['A', 'B']);
        expect(new Set(design.geometry.buildings.map(b => b.properties.variationSeed)).size).toBe(2);
        expect(design.geometry.blockMassing.properties).toMatchObject({ massing: true, height: design.geometry.buildings[0].properties.height });
    });

    it('a height set on all buildings re-stamps the massing to the same rule maximum', () => {
        const design = block();
        const next = intentDesign.modify(design, [{ type: 'set_height', value: 10.5 }], { turf });
        for (const building of next.geometry.buildings) {
            expect(building.properties).toMatchObject({ height: 10.5, floors: 3 });
            expect(building.properties.urbanRule.maxHeightM).toBe(10.5);
        }
        expect(next.geometry.blockMassing.properties).toMatchObject({ height: 10.5, floors: 3, massing: true });
        expect(next.geometry.blockMassing.properties.urbanRule).toEqual(next.geometry.buildings[0].properties.urbanRule);
        expect(next.geometry.blockMassing.geometry).toEqual(design.geometry.blockMassing.geometry);
        expect(next.buildingProposal.parameters.rule).toEqual(next.geometry.buildings[0].properties.urbanRule);
    });

    it('refuses a single-piece or footprint edit that would part a piece from its massing', () => {
        const design = block();
        expect(() => intentDesign.modify(design, [{ type: 'set_height', value: 10.5, buildingIndex: 0 }], { turf })).toThrow(/massing/);
        expect(() => intentDesign.modify(design, [{ type: 'move', eastM: 5, northM: 0 }], { turf })).toThrow(/massing/);
        expect(() => intentDesign.modify(design, [{ type: 'remove_building', buildingIndex: 0 }], { turf })).toThrow(/massing/);
        expect(intentEditing).toBeTruthy();
    });
});
