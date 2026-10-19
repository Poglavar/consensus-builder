// Verify authored architecture becomes real metric solids without losing source registration.
import { describe, expect, it } from 'vitest';
import { buildFloorPlanGeometry, validateFloorPlans, refreshRegisteredFloorPlans, buildingSourceId, uncoveredFloorBands, SCHEMA } from '../../frontend/js/building-floor-plans.js';

const architecture = () => ({
    schema:'consensus-builder.floor-architecture.v1', dimensionsM:[10,8], wallHeightM:2.8, slabThicknessM:.2,
    walls:[[[[.1,.1],[.9,.1],[.9,.12],[.1,.12]]]],
    slabs:[[[[0,0],[1,0],[1,1],[0,1]],[[.4,.4],[.6,.4],[.6,.6],[.4,.6]]]], landings:[],
    openings:[
        {kind:'door',a:[.2,.1],b:[.3,.1],depthM:.2,sillM:0,heightM:2.1,hinge:[.2,.1],openTip:[.2,.225]},
        {kind:'window',a:[.6,.1],b:[.8,.1],depthM:.2,sillM:.9,heightM:1.2}
    ],
    stairs:[{a:[.2,.3],b:[.8,.3],widthM:1,steps:6,fromM:0,toM:1.2}],railings:[]
});
const data = () => ({
    schema:SCHEMA, registration:{basis:'corners',corners:[[15,45],[15.001,45],[15.001,45.001],[15,45.001]]},
    layouts:[{id:'a',architecture:architecture(),source:{url:'https://example.test/a',page:1,crop:[0,0,10,8],sha256:'abc'}}],
    floors:[{id:'f1',level:1,elevationM:7.5,elevationBasis:'documented',layoutId:'a',apartments:[{id:'apt'}]}]
});
const project = (lng,lat) => [(lng-15)*10000,(lat-45)*8000];
const render = d => buildFloorPlanGeometry({properties:{floorPlans:d}},project);
const bounds = part => part.rings[0].reduce((b,p)=>[Math.min(b[0],p[0]),Math.min(b[1],p[1]),Math.max(b[2],p[0]),Math.max(b[3],p[1])],[Infinity,Infinity,-Infinity,-Infinity]);

describe('building floor architecture', () => {
    it('projects XY once per shared layout, preserves slab holes, and keeps metre heights separate', () => {
        const d=data();d.floors.push({...d.floors[0],id:'f2',level:2,elevationM:10.5,source:{url:'https://example.test/floor2'}});
        const floors=render(d),wall=floors[0].parts[0],slab=floors[0].parts.find(p=>p.kind==='slab');
        expect(validateFloorPlans(d)).toEqual([]);
        expect(wall).toMatchObject({kind:'wall',baseM:0,heightM:2.8});
        expect(bounds(wall)[0]).toBeCloseTo(1);
        expect(bounds(wall)[2]).toBeCloseTo(9);
        expect(slab).toMatchObject({baseM:-.2,heightM:.2});
        expect(slab.rings).toHaveLength(2);
        expect(slab.rings[1][0][0]).toBeCloseTo(4);
        expect(floors.map(f=>f.elevationM)).toEqual([7.5,10.5]);
        expect(floors[0].parts).toBe(floors[1].parts);
        expect(floors[1].sourceUrl).toBe('https://example.test/floor2');
    });
    it('leaves door openings below lintels and constructs a swung leaf plus framed window glass', () => {
        const parts=render(data())[0].parts;
        const leaf=parts.find(p=>p.kind==='door'),glass=parts.find(p=>p.kind==='glass');
        const [x0,y0,x1,y1]=bounds(leaf);
        expect(x1-x0).toBeCloseTo(.04);
        expect(y1-y0).toBeCloseTo(1);
        expect(leaf.baseM).toBe(.015);expect(leaf.heightM).toBeCloseTo(2.03);
        const lintels=parts.filter(p=>p.kind==='wall' && p.baseM>2);
        expect(lintels).toHaveLength(2);
        lintels.forEach(p=>expect(p.baseM+p.heightM).toBeCloseTo(2.8));
        const sills=parts.filter(p=>p.kind==='wall' && p.baseM===0 && p.heightM<1);
        expect(sills).toHaveLength(1);expect(sills[0].heightM).toBe(.9);
        expect(glass.baseM).toBeCloseTo(.955);expect(glass.baseM+glass.heightM).toBeCloseTo(2.045);
        expect(parts.filter(p=>p.kind==='frame')).toHaveLength(8);
    });
    it('makes individually ascending stair treads and solid railing posts', () => {
        const d=data();d.layouts[0].architecture.railings=[{a:[0,0],b:[.3,0],heightM:1.05}];
        const parts=render(d)[0].parts,stairs=parts.filter(p=>p.kind==='stair');
        expect(stairs).toHaveLength(6);
        stairs.forEach((step,i)=>{
            expect(step.baseM+step.heightM).toBeCloseTo((i+1)*.2);
            expect(bounds(step)[2]-bounds(step)[0]).toBeCloseTo(1);
        });
        expect(parts.filter(p=>p.kind==='railing')).toHaveLength(6);
    });
    it.each([
        d=>{ delete d.layouts[0].architecture; },
        d=>{ d.layouts[0].architecture.wallHeightM=NaN; },
        d=>{ d.layouts[0].architecture.openings[0].heightM=99; },
        d=>{ d.layouts[0].architecture.stairs[0].steps=Infinity; },
        d=>{ d.layouts[0].architecture.slabs[0][1][0]=[NaN,.2]; },
        d=>{ d.registration.corners[2]=d.registration.corners[1]; },
        d=>{ d.floors[0].elevationM=null; }
    ])('rejects invalid geometry before allocating render parts', mutate => {
        const d=data();mutate(d);expect(validateFloorPlans(d).length).toBeGreaterThan(0);
        expect(()=>render(d)).toThrow(/Invalid floorPlans/);
    });
    it('refreshes only floor models on identical source footprints without changing cached records', () => {
        const remote={type:'Feature',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]},properties:{sourceFeatureId:'permit-1',floorPlans:data()}};
        const local=structuredClone(remote);delete local.properties.floorPlans;local.properties.proposalId='local-owner';
        const moved=structuredClone(local);moved.geometry.coordinates[0][0][0]=.5;
        const refreshed=refreshRegisteredFloorPlans([local,moved],[remote]);
        expect(refreshed.changed).toBe(1);expect(local.properties.floorPlans).toBeUndefined();
        expect(refreshed.buildings[0].properties.proposalId).toBe('local-owner');
        expect(refreshed.buildings[0].geometry).toBe(local.geometry);
        expect(refreshed.buildings[1]).toBe(moved);
        expect(refreshRegisteredFloorPlans(refreshed.buildings,[remote]).changed).toBe(0);
        expect(refreshRegisteredFloorPlans([local],[remote,remote]).changed).toBe(0);
    });

    it('refreshes DGU and ISPU models without lifecycle or footprint changes', () => {
        const source = { type:'Feature', geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}, properties:{dguBuildingId:123,floorPlans:data()} };
        const local = { type:'Feature', geometry:structuredClone(source.geometry), properties:{dguBuildingId:123, proposalId:'keep-me'} };
        const refreshed = refreshRegisteredFloorPlans([local], [source]);
        expect(refreshed.changed).toBe(1);
        expect(refreshed.buildings[0].properties.proposalId).toBe('keep-me');
        expect(refreshed.buildings[0].properties.floorPlans).toEqual(data());
        const ispu = {...source, properties:{sourceLayerId:123,floorPlans:data()}};
        expect(refreshRegisteredFloorPlans([local], [ispu]).changed).toBe(0);
        expect(buildingSourceId(source)).not.toBe(buildingSourceId(ispu));
    });

    it('refuses ambiguous provider identities and refuses changed footprints', () => {
        const a = {type:'Feature',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]},properties:{dguBuildingId:123,floorPlans:data()}};
        const duplicate = structuredClone(a);
        duplicate.geometry.coordinates[0][0][0] = 0.2;
        const local = {type:'Feature',geometry:structuredClone(a.geometry),properties:{dguBuildingId:123}};
        expect(refreshRegisteredFloorPlans([local], [a, duplicate]).changed).toBe(0);
        const moved = structuredClone(local); moved.geometry.coordinates[0][0][0] = 0.3;
        expect(refreshRegisteredFloorPlans([moved], [a]).changed).toBe(0);
    });

    it('returns uncovered proxy bands for partial, overlapping, clipped, and underground models', () => {
        const feature = { properties: { floorPlans: data() } };
        feature.properties.floorPlans.floors = [
            { id:'f1', level:1, elevationM:0, elevationBasis:'documented', layoutId:'a', apartments:[] },
            { id:'f7', level:7, elevationM:6, elevationBasis:'documented', layoutId:'a', apartments:[] },
            { id:'f8', level:8, elevationM:7, elevationBasis:'documented', layoutId:'a', apartments:[] }
        ];
        expect(uncoveredFloorBands(feature, 10)).toEqual([{ baseM: 3, heightM: 3 }]);
        feature.properties.floorPlans.floors.push({ id:'below', level:-1, elevationM:-3, elevationBasis:'documented', layoutId:'a', apartments:[] });
        expect(uncoveredFloorBands(feature, 10)).toEqual([{ baseM: 3, heightM: 3 }]);
    });

    it('returns the full proxy band for basement-only or unusable evidence, and no band without plans', () => {
        const basement = { properties: { floorPlans: data() } };
        basement.properties.floorPlans.floors = [{ id:'b', level:-1, elevationM:-3, elevationBasis:'documented', layoutId:'a', apartments:[] }];
        expect(uncoveredFloorBands(basement, 8)).toEqual([{ baseM:0, heightM:8 }]);
        expect(uncoveredFloorBands({ properties:{} }, 8)).toEqual([]);
        expect(uncoveredFloorBands(basement, Infinity)).toEqual([]);
        basement.properties.floorPlans.floors[0].elevationM = 0;
        basement.properties.floorPlans.layouts[0].architecture.wallHeightM = 0;
        basement.properties.floorPlans.layouts[0].architecture.slabThicknessM = 0;
        expect(uncoveredFloorBands(basement, 8)).toEqual([{ baseM:0, heightM:8 }]);
        for (const [field, value] of [['elevationM', null], ['wallHeightM', null], ['slabThicknessM', ''], ['wallHeightM', '2.8']]) {
            const invalid = structuredClone(basement);
            invalid.properties.floorPlans.floors[0].elevationM = 0;
            invalid.properties.floorPlans.layouts[0].architecture.wallHeightM = 0;
            invalid.properties.floorPlans.layouts[0].architecture.slabThicknessM = 0;
            if (field === 'elevationM') invalid.properties.floorPlans.floors[0][field] = value;
            else invalid.properties.floorPlans.layouts[0].architecture[field] = value;
            expect(uncoveredFloorBands(invalid, 8)).toEqual([{ baseM:0, heightM:8 }]);
        }
    });

    it('renders sliding doors as two opaque leaves and platforms at their elevations', () => {
        const d = data();
        d.layouts[0].architecture.openings = [{ kind:'slidingDoor', a:[.1,.2], b:[.9,.2], depthM:.2, sillM:0, heightM:2.1 }];
        d.layouts[0].architecture.platforms = [{ rings:[[[.1,.1],[.4,.1],[.4,.3],[.1,.3]]], elevationM:4.5 }];
        expect(validateFloorPlans(d)).toEqual([]);
        const parts = render(d)[0].parts;
        expect(parts.filter(p=>p.kind==='door')).toHaveLength(2);
        expect(parts.filter(p=>p.kind==='glass')).toHaveLength(0);
        expect(parts.filter(p=>p.kind==='stair').some(p=>p.baseM === 4.3 && p.heightM === .2)).toBe(true);
    });

    it('rejects invalid platform geometry and elevations', () => {
        for (const mutate of [
            d => { d.layouts[0].architecture.platforms = [{ rings:[[[0,0],[.2,0],[.4,0]]], elevationM:4.5 }]; },
            d => { d.layouts[0].architecture.platforms = [{ rings:[[[0,0],[.2,0],[.2,.2]]], elevationM:null }]; },
            d => { d.layouts[0].architecture.platforms = [{ rings:[[[0,0],[.2,0],[.2,.2]]], elevationM:13 }]; }
        ]) {
            const d = data(); mutate(d); expect(validateFloorPlans(d).length).toBeGreaterThan(0);
        }
    });
});
