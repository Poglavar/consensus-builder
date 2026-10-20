// Swept human clearance, authored door connectivity and deterministic apartment wandering.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require=createRequire(import.meta.url);
const {buildNavigation,findPath,createWalkers,advanceWalkers,MIN_SEPARATION_M}=require('../../frontend/js/apartment-people-navigation.js');
const {buildLocalUnitParts}=require('../../frontend/js/building-floor-plans.js');
const rectangle=(x0,y0,x1,y1)=>[[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]];
const architecture=()=>({dimensionsM:[8,6],slabs:[rectangle(0,0,1,1)],walls:[],openings:[],stairs:[],railings:[],landings:[]});
const nearest=(nav,p)=>nav.points.reduce((best,q,i)=>Math.hypot(q[0]-p[0],q[1]-p[1])<Math.hypot(nav.points[best][0]-p[0],nav.points[best][1]-p[1])?i:best,0);
function partition(kind='door',gap=1.2) {
    const a=architecture(),lo=.5-gap/12,hi=.5+gap/12;
    a.walls=[rectangle(.49,0,.51,lo),rectangle(.49,hi,.51,1)];
    a.openings=[{kind,a:[.5,lo],b:[.5,hi],depthM:.16,sillM:0,heightM:2.1,hinge:[.5,lo],openTip:[.5+gap/8,lo]}];
    return a;
}
describe('apartment people ground navigation',()=>{
    it.each([undefined,{}, {dimensionsM:[null,6]}, {dimensionsM:[0,6]}, {dimensionsM:[Infinity,6]}])('omits unsupported architecture %j',input=>{
        expect(buildNavigation(input)).toBeNull();expect(createWalkers(buildNavigation(input))).toEqual([]);
    });
    it('measures clearance in metres on a nonsquare plan and keeps the full body on its slab',()=>{
        const nav=buildNavigation(architecture());
        expect(nav.canWalk([.37,.37])).toBe(true);expect(nav.canWalk([.35,2])).toBe(false);
        expect(nav.canWalk([4,5.67])).toBe(false);expect(nav.canWalk([8.1,3])).toBe(false);
        expect(nav.points.every(p=>p[0]>=nav.radius&&p[0]<=8-nav.radius&&p[1]>=nav.radius&&p[1]<=6-nav.radius)).toBe(true);
    });
    it('cannot skip a very thin wall or cut a corner between safe endpoints',()=>{
        const a=architecture();a.walls=[rectangle(.499,0,.501,1)];
        const nav=buildNavigation(a);
        expect(nav.canWalk([3,3],[5,3])).toBe(false);
        expect(findPath(nav,nearest(nav,[2,3]),nearest(nav,[6,3]))).toEqual([]);
        expect(nav.components).toHaveLength(2);
    });
    it('connects rooms only through a ground-level open door with clearance for frames and its leaf',()=>{
        const nav=buildNavigation(partition()),path=findPath(nav,nearest(nav,[2,3]),nearest(nav,[6,3]));
        expect(path.length).toBeGreaterThan(0);
        expect(path.some(id=>Math.abs(nav.points[id][0]-4)<.25)).toBe(true);
        path.slice(1).forEach((id,i)=>expect(nav.canWalk(nav.points[path[i]],nav.points[id])).toBe(true));
        expect(nav.canWalk([4.7,3.6])).toBe(false); // The swung leaf is a real solid.
    });
    it.each(['window','slidingDoor','glazedDoor'])('does not walk through the rendered closed %s',kind=>{
        const nav=buildNavigation(partition(kind));
        expect(findPath(nav,nearest(nav,[2,3]),nearest(nav,[6,3]))).toEqual([]);
    });
    it('rejects door gaps too narrow for a person and raised/low apertures',()=>{
        const narrow=partition('door',.6),raised=partition(),low=partition();raised.openings[0].sillM=.3;low.openings[0].heightM=1.7;
        for(const a of [narrow,raised,low]){const nav=buildNavigation(a);expect(findPath(nav,nearest(nav,[2,3]),nearest(nav,[6,3]))).toEqual([]);}
    });
    it('keeps slab holes, disconnected slabs and gaps outside the path graph',()=>{
        const a=architecture();a.slabs[0].push(rectangle(.4,.3,.6,.7)[0]);
        const nav=buildNavigation(a);
        expect(nav.canWalk([4,3])).toBe(false);expect(nav.canWalk([3,3],[5,3])).toBe(false);
        const path=findPath(nav,nearest(nav,[2,3]),nearest(nav,[6,3]));expect(path.length).toBeGreaterThan(0);
        path.slice(1).forEach((id,i)=>expect(nav.canWalk(nav.points[path[i]],nav.points[id])).toBe(true));
        a.slabs=[rectangle(0,0,.4,1),rectangle(.6,0,1,1)];const split=buildNavigation(a);
        expect(findPath(split,nearest(split,[2,3]),nearest(split,[6,3]))).toEqual([]);
    });
    it('excludes stair runs, elevated landings/platforms and railings even when a slab continues below',()=>{
        const a=architecture();a.stairs=[{a:[.2,.2],b:[.2,.7],widthM:1,fromM:0,toM:1.5}];
        a.landings=[rectangle(.4,.3,.55,.6)];a.platforms=[{rings:rectangle(.7,.3,.8,.6),elevationM:1.2}];a.railings=[{a:[0,.9],b:[1,.9]}];
        const nav=buildNavigation(a);
        for(const p of [[1.6,2.5],[3.8,2.5],[6,2.5],[4,.6]])expect(nav.canWalk(p)).toBe(false);
        expect(nav.canWalk([4,5.2])).toBe(true);
    });
    it('omits the pair in a cramped plan and starts separated figures in the largest reachable region',()=>{
        const small=architecture();small.dimensionsM=[1.3,1.3];expect(createWalkers(buildNavigation(small))).toEqual([]);
        const a=architecture();a.walls=[rectangle(.7,0,.72,1)];const nav=buildNavigation(a),walkers=createWalkers(nav,()=>.5);
        expect(walkers).toHaveLength(2);expect(walkers.every(w=>w.x<5.6)).toBe(true);
        expect(Math.hypot(walkers[0].x-walkers[1].x,walkers[0].y-walkers[1].y)).toBeGreaterThanOrEqual(1.2);
    });
    it('walks bounded paths with standing pauses, no wall crossings and no overlapping figures',()=>{
        const nav=buildNavigation(partition()),walkers=createWalkers(nav,()=>.4);let moving=false,pausedAfterWalking=false;
        let seed=123;const random=()=>((seed=(seed*16807)%2147483647)-1)/2147483646;
        for(let i=0;i<1600;i++){
            const previous=walkers.map(w=>[w.x,w.y]);advanceWalkers(nav,walkers,.1,random);
            walkers.forEach((w,j)=>{expect(nav.canWalk(previous[j],[w.x,w.y])).toBe(true);expect(Math.hypot(w.x-previous[j][0],w.y-previous[j][1])).toBeLessThanOrEqual(.065001);});
            expect(Math.hypot(walkers[0].x-walkers[1].x,walkers[0].y-walkers[1].y)).toBeGreaterThanOrEqual(MIN_SEPARATION_M-1e-8);
            if(walkers.some(w=>w.moving))moving=true;
            if(moving&&walkers.some(w=>w.pause>2))pausedAfterWalking=true;
        }
        expect(moving).toBe(true);expect(pausedAfterWalking).toBe(true);
    });
    it('omits malformed physical obstacles rather than silently walking through them',()=>{
        const a=architecture();a.walls=[[[[NaN,0],[1,0],[1,1]]]];expect(buildNavigation(a)).toBeNull();
        const door=partition();delete door.openings[0].hinge;expect(buildNavigation(door)).toBeNull();
    });
    it('uses the renderer y-up metre frame for asymmetric source walls, slabs and door leaves',()=>{
        const a={...architecture(),schema:'consensus-builder.floor-architecture.v1',wallHeightM:2.8,slabThicknessM:.2};
        a.walls=[rectangle(.2,.05,.3,.2)];a.slabs=[rectangle(0,0,1,.65)];
        const nav=buildNavigation(a),wall=buildLocalUnitParts(a).find(p=>p.kind==='wall');
        const centre=wall.rings[0].reduce((p,q)=>[p[0]+q[0]/4,p[1]+q[1]/4],[0,0]);
        expect(centre).toEqual([2,5.25]);expect(nav.canWalk(centre)).toBe(false);
        expect(nav.canWalk([2,3])).toBe(true);expect(nav.canWalk([2,1])).toBe(false);
    });
    it('uses the five source-backed Avenue V apartments without placing anyone in walls or slab holes',()=>{
        const fixture=JSON.parse(fs.readFileSync(new URL('../../rekonstrukcije/avenue-v/unit-models.json',import.meta.url),'utf8'));
        for(const unit of fixture.units){const nav=buildNavigation(unit.architecture),walkers=createWalkers(nav,()=>.5);
            expect(walkers).toHaveLength(2);walkers.forEach(w=>expect(nav.canWalk([w.x,w.y])).toBe(true));}
    });
});
