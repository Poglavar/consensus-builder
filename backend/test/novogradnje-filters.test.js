// Headless contract tests for public apartment catalogue filtering and shareable filter URLs.
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import '../../frontend/js/building-floor-plans.js';

const require = createRequire(import.meta.url);
const { filterProjects, matchesApartment, placementTransform, hasEnvelope, encodeFilters, decodeFilters } = require('../../frontend/novogradnje/catalogue.js');

const projects = [
    { id:'a',slug:'aurora',name:'Aurora',address:'Ilica 12',kind:'new_build',apartments:[
        {id:'a1',areaM2:72,rooms:3,orientation:['S','E']},
        {id:'a2',areaM2:null,rooms:null,orientation:[]}
    ]},
    { id:'b',slug:'park',name:'Park',address:'Maksimir',kind:'existing',apartments:[
        {id:'b1',areaM2:85,rooms:4,orientation:['N']}
    ]},
    { id:'c',slug:'unknown',name:'Nepoznat projekt',address:'Trešnjevka',kind:'unknown',apartments:[
        {id:'c1',areaM2:120,rooms:5,orientation:['W']}
    ]},
    { id:'d',slug:'residential-no-listing',name:'Stambena zgrada',kind:'new_build',apartments:[] }
];

// Matches the authored architecture fixture in building-floor-plans.test.js. Keeping a
// representative slab, wall, and opening here guards the viewer's shared unit coordinates.
const planArchitecture = {
    schema:'consensus-builder.floor-architecture.v1', dimensionsM:[10,8], wallHeightM:2.8, slabThicknessM:.2,
    walls:[[[[.1,.1],[.9,.1],[.9,.12],[.1,.12]]]],
    slabs:[[[[0,0],[1,0],[1,1],[0,1]],[[.4,.4],[.6,.4],[.6,.6],[.4,.6]]]], landings:[],
    openings:[{kind:'door',a:[.2,.1],b:[.3,.1],depthM:.2,sillM:0,heightM:2.1,hinge:[.2,.1],openTip:[.2,.225]}],
    stairs:[],railings:[]
};

describe('novogradnje public filters', () => {
    it('defaults to new builds and matches searchable Croatian project text without diacritics', () => {
        expect(filterProjects(projects,{}).map(p=>p.id)).toEqual(['a']);
        expect(filterProjects(projects,{q:'tresnjevka',kind:'all'}).map(p=>p.id)).toEqual(['c']);
        expect(filterProjects([{...projects[0],titles:['Kvart Trešnjevka']}],{q:'tresnjevka'}).map(p=>p.id)).toEqual(['a']);
        expect(filterProjects([{...projects[0],apartments:[{...projects[0].apartments[0],sourceTitle:'Vrtni stan'}]}],{q:'vrtni'}).map(p=>p.id)).toEqual(['a']);
    });
    it('does not offer empty discovery leads or an unsupported building viewer', () => {
        expect(filterProjects([projects[3]],{kind:'all'})).toEqual([]);
        const footprint={type:'Polygon',coordinates:[[[15,45],[16,45],[16,46],[15,45]]]};
        expect(hasEnvelope({envelope:{footprint,storeys:[],heightM:0}})).toBe(false);
        expect(hasEnvelope({envelope:{footprint,storeys:[{heightM:3,elevationM:null}]}})).toBe(false);
        expect(hasEnvelope({envelope:{footprint,storeys:[{heightM:3,elevationM:0}]}})).toBe(true);
    });
    it('never treats unknown area or room counts as zero or as a numeric match', () => {
        expect(matchesApartment(projects[0].apartments[1],{minArea:0,maxArea:null,rooms:null,orientation:''})).toBe(false);
        expect(matchesApartment(projects[0].apartments[1],{minArea:null,maxArea:null,rooms:0,orientation:''})).toBe(false);
        expect(filterProjects(projects,{kind:'all',minArea:0}).flatMap(p=>p.apartments.map(a=>a.id))).toEqual(['a1','b1','c1']);
        expect(filterProjects([projects[3]],{minArea:0})).toEqual([]);
    });
    it('applies area bounds, room count including the 5+ option, and orientation together', () => {
        expect(filterProjects(projects,{kind:'all',minArea:70,maxArea:90,rooms:4,orientation:'N'}).flatMap(p=>p.apartments.map(a=>a.id))).toEqual(['b1']);
        expect(filterProjects(projects,{kind:'all',rooms:5}).flatMap(p=>p.apartments.map(a=>a.id))).toEqual(['c1']);
    });
    it('round-trips shareable filters and drops unsupported values', () => {
        const state={q:'Ilica 12',kind:'all',minArea:45,maxArea:90,rooms:3,orientation:'SE'};
        expect(decodeFilters(`?${encodeFilters(state)}`)).toEqual(state);
        expect(decodeFilters('?kind=wrong&orientation=sideways').kind).toBe('new_build');
        expect(decodeFilters('?kind=wrong&orientation=sideways').orientation).toBe('');
        expect(decodeFilters('?min=invalid').minArea).toBeNull();
    });
    it('aligns shared viewer geometry vertices with the site-fit origin', () => {
        const geometry=globalThis.__buildingFloorPlans.buildLocalUnitParts(planArchitecture);
        const slab=geometry.find(part=>part.kind==='slab');
        expect(slab.rings).toHaveLength(2);
        // Image-space corner [0,0] appears at [0,8] in the shared 3D geometry and
        // [0,0] in site-fit north/east coordinates; the group origin compensates exactly.
        expect(slab.rings[0][0]).toEqual([0,8]);
        const best={scale:1.25,rotationDeg:90,tx:11,ty:-7}, transform=placementTransform(best,planArchitecture.dimensionsM);
        const local=slab.rings[0][0];
        const rotated=[transform.scale*(Math.cos(transform.rotation)*local[0]-Math.sin(transform.rotation)*local[1])+transform.x,
            transform.scale*(Math.sin(transform.rotation)*local[0]+Math.cos(transform.rotation)*local[1])+transform.y];
        const siteFit=[best.scale*(Math.cos(Math.PI/2)*0-Math.sin(Math.PI/2)*0)+best.tx,
            best.scale*(Math.sin(Math.PI/2)*0+Math.cos(Math.PI/2)*0)+best.ty];
        expect(rotated[0]).toBeCloseTo(siteFit[0],10);
        expect(rotated[1]).toBeCloseTo(siteFit[1],10);
        expect(placementTransform({scale:1,rotationDeg:0,tx:0,ty:0},[10,null])).toBeNull();
        expect(placementTransform({scale:0,rotationDeg:0,tx:0,ty:0},[10,8])).toBeNull();
    });
});
