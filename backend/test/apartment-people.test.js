// Runtime ownership: reduced motion, visibility suspension, throttling and complete disposal.
import {describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),navigation=require('../../frontend/js/apartment-people-navigation.js');
const {mount}=require('../../frontend/js/apartment-people.js');
function harness({reduced=false,hidden=false,offscreen=false,small=false}={}) {
    const resources=[],observers=[];
    class Vector {set(x,y,z){Object.assign(this,{x,y,z});return this;}copy(v){return this.set(v.x,v.y,v.z);}}
    class Group {
        constructor(){this.children=[];this.position=new Vector();this.rotation={};this.scale=new Vector();}
        add(object){this.children.push(object);}remove(object){this.children=this.children.filter(x=>x!==object);}
        traverse(fn){fn(this);this.children.forEach(child=>child.traverse(fn));}
    }
    class Mesh extends Group {constructor(geometry,material){super();this.geometry=geometry;this.material=material;}}
    class Resource {constructor(){this.dispose=vi.fn();resources.push(this);}rotateX(){return this;}translate(){return this;}}
    const THREE={Group,Mesh,MeshPhongMaterial:Resource,CylinderGeometry:Resource,SphereGeometry:Resource};
    const media=new EventTarget();media.matches=reduced;
    const doc=new EventTarget();doc.hidden=hidden;
    let rafId=0;const frames=new Map();
    const env={document:doc,innerWidth:1000,innerHeight:800,matchMedia:()=>media,
        __apartmentPeopleNavigation:{...navigation,createWalkers(nav){const walkers=navigation.createWalkers(nav,()=>.5);walkers.forEach(w=>w.pause=0);return walkers;},advanceWalkers:vi.fn(navigation.advanceWalkers)},
        requestAnimationFrame:fn=>{frames.set(++rafId,fn);return rafId;},cancelAnimationFrame:id=>frames.delete(id),
        IntersectionObserver:class {constructor(fn){this.callback=fn;this.disconnect=vi.fn();observers.push(this);}observe(){}}
    };
    const group=new Group(),render=vi.fn(),host={getBoundingClientRect:()=>({top:offscreen?900:0,left:0,bottom:offscreen?1100:400,right:700})};
    const architecture={dimensionsM:small?[1,1]:[6,5],slabs:[[[[0,0],[1,0],[1,1],[0,1]]]],walls:[],landings:[],stairs:[],railings:[],openings:[]};
    const dispose=mount({THREE,group,render,host,architecture},env);
    const step=time=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn(time));};
    const visible=value=>{observers[0].callback([{isIntersecting:value}]);};
    const motion=value=>{media.matches=value;media.dispatchEvent(new Event('change'));};
    const hide=value=>{doc.hidden=value;doc.dispatchEvent(new Event('visibilitychange'));};
    return {group,render,dispose,frames,step,visible,motion,hide,resources,observers,advance:env.__apartmentPeopleNavigation.advanceWalkers};
}
describe('apartment people preview runtime',()=>{
    it('mounts one male and one female at real metre proportions, and moves them below 24 updates/second',()=>{
        const h=harness(),people=h.group.children[0];
        expect(people.children.map(x=>x.name)).toEqual(['ApartmentPerson:male','ApartmentPerson:female']);
        const before=people.children.map(x=>({...x.position}));
        h.step(0);h.step(20);h.step(40);expect(h.advance).not.toHaveBeenCalled();
        h.step(60);expect(h.advance).toHaveBeenCalledTimes(1);
        expect(people.children.some((p,i)=>p.position.x!==before[i].x||p.position.y!==before[i].y)).toBe(true);
        expect(people.children[0].children[1].position.z).toBeCloseTo(1.62*1.78/1.75);
        h.dispose();
    });
    it('keeps standing figures and schedules no animation for reduced motion, including preference changes',()=>{
        const h=harness({reduced:true});expect(h.frames.size).toBe(0);expect(h.group.children[0].children).toHaveLength(2);
        h.motion(false);expect(h.frames.size).toBe(1);h.step(0);h.step(60);expect(h.advance).toHaveBeenCalledTimes(1);
        h.motion(true);expect(h.frames.size).toBe(0);
        for(const figure of h.group.children[0].children)for(const limb of figure.children.filter(c=>c.rotation.y!==undefined))expect(limb.rotation.y).toBeCloseTo(0);
        h.dispose();
    });
    it('stops frames while the document is hidden or the host is offscreen and resumes without catch-up movement',()=>{
        const h=harness();h.step(0);h.step(60);h.hide(true);expect(h.frames.size).toBe(0);
        h.hide(false);h.step(60000);expect(h.advance).toHaveBeenCalledTimes(1);
        h.step(60060);expect(h.advance).toHaveBeenCalledTimes(2);
        h.visible(false);expect(h.frames.size).toBe(0);h.visible(true);expect(h.frames.size).toBe(1);h.dispose();
    });
    it('starts without animation if already hidden or offscreen',()=>{
        for(const options of [{hidden:true},{offscreen:true}]){const h=harness(options);expect(h.frames.size).toBe(0);h.dispose();}
    });
    it('disposes each owned resource once and removes animation, observers and listeners',()=>{
        const h=harness();h.dispose();h.dispose();
        expect(h.group.children).toEqual([]);expect(h.frames.size).toBe(0);expect(h.observers[0].disconnect).toHaveBeenCalledTimes(1);
        expect(h.resources.length).toBeGreaterThan(0);h.resources.forEach(r=>expect(r.dispose).toHaveBeenCalledTimes(1));
        const renders=h.render.mock.calls.length;h.hide(true);h.hide(false);h.motion(true);h.motion(false);
        expect(h.render).toHaveBeenCalledTimes(renders);expect(h.frames.size).toBe(0);
    });
    it('omits figures and allocates no resources when there is too little supported floor',()=>{
        const h=harness({small:true});expect(h.group.children).toEqual([]);expect(h.resources).toEqual([]);expect(h.observers).toEqual([]);expect(h.frames.size).toBe(0);h.dispose();
    });
});
