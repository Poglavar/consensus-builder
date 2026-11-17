// Exercise actual Three.js picking, visibility, apartment geometry and pointer lifecycle.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const THREE = require('three');
const { attach, apartmentAtHit } = require('../../frontend/js/three-apartment-hover.js');
const polygon = (x0,x1) => [[[x0,-2],[x1,-2],[x1,2],[x0,2]]];
function setup() {
    const listeners = new Map();
    const canvas = { addEventListener:(t,f)=>listeners.set(t,f), removeEventListener:t=>listeners.delete(t),
        getBoundingClientRect:()=>({left:0,top:0,width:100,height:100}) };
    const camera = new THREE.OrthographicCamera(-5,5,5,-5,.1,100);
    camera.position.z = 10; camera.lookAt(0,0,0); camera.updateMatrixWorld();
    const root = new THREE.Group(), floor = new THREE.Group();
    floor.userData = { cbFloorPlanFloor:true, id:'floor-1', apartmentRegions:[
        {id:'west',polygons:[polygon(-4,-1)]}, {id:'east',polygons:[polygon(1,4)]}
    ] };
    floor.add(new THREE.Mesh(new THREE.PlaneGeometry(10,10),new THREE.MeshBasicMaterial()));
    root.add(floor);
    const blockers = new THREE.Group();
    let wakeups = 0;
    const hover = attach(THREE,{ canvas,camera,floorPlanGroup:root,occluders:()=>[blockers],onPointerChange:()=>wakeups++ });
    const event = (type,x=25,extra={}) => listeners.get(type)({clientX:x,clientY:50,buttons:0,pointerType:'mouse',...extra});
    const highlight = () => floor.children.find(c=>c.userData.cbApartmentHover);
    return {root,floor,hover,event,highlight,listeners,blockers,camera,wakeups:()=>wakeups};
}
describe('apartment hover',()=>{
    it('highlights exactly one unit, reuses it within that unit, and clears in common space',()=>{
        const s=setup();s.event('pointermove');s.hover.update(true);
        const west=s.highlight();expect(west.userData).toMatchObject({apartmentId:'west',floorId:'floor-1'});
        s.event('pointermove',26);s.hover.update(true);expect(s.highlight()).toBe(west);
        let disposed=false;west.geometry.addEventListener('dispose',()=>disposed=true);
        s.event('pointermove',75);s.hover.update(true);expect(s.highlight().userData.apartmentId).toBe('east');expect(disposed).toBe(true);
        expect(s.floor.children.filter(c=>c.userData.cbApartmentHover)).toHaveLength(1);
        s.event('pointermove',50);s.hover.update(true);expect(s.highlight()).toBeUndefined();s.hover.dispose();
    });
    it('ignores hidden ancestors and hidden upper floors, then picks the exposed floor',()=>{
        const s=setup();s.event('pointermove');s.hover.update(true);expect(s.highlight()).toBeDefined();
        s.root.visible=false;s.hover.invalidate();s.hover.update(true);expect(s.highlight()).toBeUndefined();
        s.root.visible=true;s.floor.visible=false;s.hover.invalidate();s.hover.update(true);expect(s.highlight()).toBeUndefined();
        s.floor.visible=true;s.hover.invalidate();s.hover.update(true);expect(s.highlight()).toBeDefined();s.hover.dispose();
    });
    it('does not pick through an opaque building in front of the apartment',()=>{
        const s=setup();const block=new THREE.Mesh(new THREE.PlaneGeometry(10,10),new THREE.MeshBasicMaterial());
        block.position.z=5;s.blockers.add(block);s.blockers.updateMatrixWorld(true);
        s.event('pointermove');s.hover.update(true);expect(s.highlight()).toBeUndefined();
        block.visible=false;s.hover.invalidate();s.hover.update(true);expect(s.highlight()).toBeDefined();s.hover.dispose();
    });
    it('clears on drag, exit, disabled x-ray and disposal without installing click handlers',()=>{
        const s=setup();expect(s.listeners.has('click')).toBe(false);
        s.event('pointermove');expect(s.wakeups()).toBe(1);s.event('pointerleave');expect(s.wakeups()).toBe(2);
        for(const [type,extra] of [['pointerdown',{}],['pointermove',{buttons:1}],['pointerleave',{}],['pointercancel',{}],['pointermove',{pointerType:'touch'}]]){
            s.event('pointermove');s.hover.update(true);expect(s.highlight()).toBeDefined();
            s.event(type,25,extra);s.hover.update(true);expect(s.highlight()).toBeUndefined();
        }
        s.event('pointermove');s.hover.update(true);s.hover.update(false);expect(s.highlight()).toBeUndefined();
        s.hover.update(true);expect(s.highlight()).toBeDefined();s.hover.dispose();expect(s.highlight()).toBeUndefined();expect(s.listeners.size).toBe(0);
    });
    it('repicks when the camera moves with a stationary pointer',()=>{
        const s=setup();s.event('pointermove');s.hover.update(true);expect(s.highlight().userData.apartmentId).toBe('west');
        s.camera.position.x=5;s.hover.update(true);expect(s.highlight().userData.apartmentId).toBe('east');s.hover.dispose();
    });
    it('respects region holes and floor world transforms',()=>{
        const s=setup();s.floor.position.set(20,10,3);s.floor.updateMatrixWorld(true);
        s.floor.userData.apartmentRegions[0].polygons[0].push([[-3,-1],[-2,-1],[-2,1],[-3,1]]);
        const hit = (x,y) => ({object:s.floor.children[0],point:new THREE.Vector3(x+20,y+10,3)});
        expect(apartmentAtHit(hit(-2.5,0))).toBeNull();expect(apartmentAtHit(hit(-3.5,0)).region.id).toBe('west');
        expect(apartmentAtHit(hit(0,0))).toBeNull();s.hover.dispose();
    });
});
