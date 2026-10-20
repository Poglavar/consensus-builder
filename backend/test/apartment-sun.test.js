import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {mount,ceilingParts,castsShadow}=require('../../frontend/js/apartment-sun.js');
const geometry=require('../../frontend/js/building-floor-plans.js');
const rooms=require('../../frontend/js/apartment-light-rooms.js');
const state=require('../../frontend/js/apartment-sun-state.js');
const SunCalc=require('../../frontend/vendor/suncalc.min.js');
const architecture={schema:'consensus-builder.floor-architecture.v1',dimensionsM:[6,5],wallHeightM:2.7,slabThicknessM:.2,
    slabs:[[[[0,0],[1,0],[1,1],[0,1]],[[.4,.4],[.4,.6],[.6,.6],[.6,.4]]]],
    walls:[[[[0,0],[1,0],[1,.04],[0,.04]]]],landings:[],stairs:[],railings:[],openings:[]};

function fixture({reduced=false}={}){
    const resources=[],observers=[],frames=new Map();let frameId=0;
    class Vector{
        set(x,y,z){Object.assign(this,{x,y,z});return this;}
        copy(p){return this.set(p.x,p.y,p.z);}
        addScaledVector(p,s){this.x+=p.x*s;this.y+=p.y*s;this.z+=p.z*s;return this;}
    }
    class Group{
        constructor(){this.children=[];this.userData={};this.position=new Vector();}
        add(...objects){this.children.push(...objects);}
        remove(...objects){this.children=this.children.filter(object=>!objects.includes(object));}
        traverse(fn){fn(this);this.children.forEach(object=>object.traverse(fn));}
    }
    class Resource{
        constructor(options){Object.assign(this,options);this.dispose=vi.fn();resources.push(this);}
        translate(){return this;}
        rotateX(){return this;}
    }
    class Mesh extends Group{constructor(geometry,material){super();this.isMesh=true;this.geometry=geometry;this.material=material;}}
    class Shape{constructor(points){this.points=points;this.holes=[];}}
    class Color{set(value){this.value=value;return this;}lerp(){return this;}}
    class Light extends Group{
        constructor(){super();this.color=new Color();this.shadow={mapSize:new Vector(),camera:{up:new Vector(),updateProjectionMatrix:vi.fn()},dispose:vi.fn()};}
    }
    class Element extends EventTarget{
        constructor(tag){super();this.tag=tag;this.children=[];this.dataset={};this.value='';this.style={};}
        append(...elements){elements.forEach(element=>{element.parentElement=this;this.children.push(element);});}
        setAttribute(key,value){this[key]=value;}
        remove(){this.parentElement.children=this.parentElement.children.filter(child=>child!==this);}
        getBoundingClientRect(){return {top:0,bottom:58,left:0,right:58,width:58,height:58};}
        setPointerCapture(){}
        focus(){}
    }
    const doc=new EventTarget();doc.hidden=false;doc.createElement=tag=>new Element(tag);
    const media=new EventTarget();media.matches=reduced;
    const env={document:doc,innerWidth:1000,innerHeight:900,SunCalc,
        __apartmentSunState:{...state,dayBounds:date=>state.dayBounds(date||'2026-06-21')},__buildingFloorPlans:geometry,__apartmentLightRooms:rooms,
        matchMedia:()=>media,requestAnimationFrame:fn=>{frames.set(++frameId,fn);return frameId;},cancelAnimationFrame:id=>frames.delete(id),
        IntersectionObserver:class{constructor(callback){this.callback=callback;this.disconnect=vi.fn();observers.push(this);}observe(){}}
    };
    const THREE={Group,Vector2:Vector,Vector3:class extends Vector{constructor(x,y,z){super();this.set(x,y,z);}},Object3D:Group,
        Mesh,Shape,Path:Shape,ExtrudeGeometry:Resource,CylinderGeometry:Resource,MeshBasicMaterial:Resource,MeshDepthMaterial:Resource,Color,
        DirectionalLight:Light,SpotLight:Light,DoubleSide:2,RGBADepthPacking:3201,PCFShadowMap:1};
    const group=new Group(),glass=new Mesh(new Resource(),new Resource()),wall=new Mesh(new Resource(),new Resource());
    glass.name='UnitPart:glass';wall.name='UnitPart:wall';group.add(glass,wall);
    const scene=new Group(),ambient={isLight:true,isHemisphereLight:true,intensity:2.4},oldLight={isLight:true,intensity:2};scene.add(ambient,oldLight);
    const host=new Element('host'),controlsHost=new Element('controls'),renderer={shadowMap:{enabled:false,type:0}},render=vi.fn();
    const dispose=mount({THREE,scene,group,renderer,render,host,controlsHost,architecture,location:{lat:45.815,lng:15.982}},env);
    const ui=controlsHost.children[0],dials=ui.children[0];
    const sun=scene.children.find(child=>child.name==='ApartmentSun');
    const nightLights=group.children.find(child=>child.name==='ApartmentNightLights');
    const lamps=nightLights?.children.filter(child=>child.name==='ApartmentNightLamp');
    const fixtures=nightLights?.children.filter(child=>child.name==='CeilingLamp');
    const step=now=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn(now));};
    return {group,glass,wall,sun,nightLights,lamps,fixtures,renderer,render,host,controlsHost,frames,step,dispose,doc,media,observers,ambient,oldLight,resources,
        clock:dials.children[0].children[0],compass:dials.children[2].children[0],date:dials.children[1].children[0]};
}

describe('apartment sunlight and shadow ownership',()=>{
    it('puts the hidden ceiling above the walls and preserves floor holes and image-axis conversion',()=>{
        const [roof]=ceilingParts(architecture,geometry);
        expect(roof.baseM).toBe(2.7);expect(roof.heightM).toBe(.2);
        expect(roof.rings).toHaveLength(2);
        expect(roof.rings[0]).toContainEqual([0,5]);
        expect(roof.rings[1][0][0]).toBeCloseTo(2.4);expect(roof.rings[1][0][1]).toBeCloseTo(3);
    });
    it('lets sunlight through glass while walls, frames, doors and people cast shadows',()=>{
        expect(castsShadow({name:'UnitPart:glass'})).toBe(false);
        expect(castsShadow({userData:{floorPartKind:'glass'}})).toBe(false);
        for(const name of ['UnitPart:wall','UnitPart:frame','UnitPart:door','ApartmentPerson:male'])expect(castsShadow({name})).toBe(true);
        const f=fixture();expect(f.glass.castShadow).toBe(false);expect(f.wall.castShadow).toBe(true);
        const roof=f.group.children.find(child=>child.name==='ApartmentShadowCeiling').children[0];
        expect(roof.castShadow).toBe(true);expect(roof.material.colorWrite).toBe(false);expect(roof.material.depthWrite).toBe(false);
        expect(roof.customDepthMaterial).toBeDefined();f.dispose();
    });
    it('cycles noon to midnight after 10 seconds and back to noon after 20 seconds, with no direct sun at night',()=>{
        const f=fixture();const noon=f.host.dataset.sunTime;expect(f.sun.intensity).toBeGreaterThan(0);
        f.step(0);f.step(10000);expect(f.sun.intensity).toBe(0);expect(f.host.dataset.sunTime).toBe('00:00');
        f.step(20000);expect(f.host.dataset.sunTime).toBe(noon);expect(f.sun.intensity).toBeGreaterThan(0);f.dispose();
    });
    it('turns ceiling lamps on at midnight and off again at noon',()=>{
        const f=fixture();
        expect(f.nightLights.visible).toBe(false);expect(f.lamps.length).toBeGreaterThan(0);
        expect(f.fixtures).toHaveLength(f.lamps.length);
        for(const lamp of f.lamps){expect(lamp.intensity).toBe(0);expect(f.nightLights.children).toContain(lamp.target);}
        f.step(0);f.step(10000);
        expect(f.host.dataset.sunTime).toBe('00:00');expect(f.nightLights.visible).toBe(true);
        for(const lamp of f.lamps)expect(lamp.intensity).toBe(35);
        f.step(20000);expect(f.nightLights.visible).toBe(false);
        for(const lamp of f.lamps)expect(lamp.intensity).toBe(0);
        f.dispose();
    });
    it('pauses and resumes by clicking the analogue clock and advances its hands with time',()=>{
        const f=fixture(),hour=f.clock.children[4],minute=f.clock.children[5];
        expect(hour.style.transform).toBe('rotate(0deg)');expect(minute.style.transform).toBe('rotate(0deg)');
        f.clock.dispatchEvent(new Event('click'));expect(f.frames.size).toBe(0);expect(f.clock['aria-pressed']).toBe('true');
        const key=new Event('keydown',{cancelable:true});key.key='ArrowRight';f.clock.dispatchEvent(key);
        expect(f.host.dataset.sunTime).toBe('13:00');expect(hour.style.transform).toBe('rotate(30deg)');
        f.clock.dispatchEvent(new Event('click'));expect(f.frames.size).toBe(1);f.dispose();
    });
    it('rotates north with compass dragging and keyboard controls without changing the clock',()=>{
        const f=fixture();f.clock.dispatchEvent(new Event('click'));
        function pointer(type,x,y){const event=new Event(type,{cancelable:true});Object.assign(event,{button:0,pointerId:1,clientX:x,clientY:y});f.compass.dispatchEvent(event);}
        pointer('pointerdown',58,29);expect(f.compass['aria-valuenow']).toBe('90');
        pointer('pointermove',29,58);expect(f.compass['aria-valuenow']).toBe('180');
        pointer('pointerup',29,58);pointer('pointermove',0,29);expect(f.compass['aria-valuenow']).toBe('180');
        const key=new Event('keydown',{cancelable:true});key.key='Home';f.compass.dispatchEvent(key);expect(f.compass['aria-valuenow']).toBe('0');
        expect(f.controlsHost.children[0].children[1].textContent).toContain('Ručno postavljen N');expect(f.host.dataset.sunTime).toBe('12:00');f.dispose();
    });
    it('suspends offscreen and hidden animations and starts paused for reduced motion',()=>{
        const f=fixture();f.observers[0].callback([{isIntersecting:false}]);expect(f.frames.size).toBe(0);
        f.observers[0].callback([{isIntersecting:true}]);expect(f.frames.size).toBe(1);
        f.doc.hidden=true;f.doc.dispatchEvent(new Event('visibilitychange'));expect(f.frames.size).toBe(0);f.dispose();
        const reduced=fixture({reduced:true});expect(reduced.frames.size).toBe(0);expect(reduced.host.dataset.sunlightState).toBe('paused');reduced.dispose();
    });
    it('disposes shadow resources and restores preview lighting on teardown',()=>{
        const f=fixture(),roof=f.group.children.find(child=>child.name==='ApartmentShadowCeiling').children[0];
        f.dispose();expect(f.sun.shadow.dispose).toHaveBeenCalledOnce();expect(roof.geometry.dispose).toHaveBeenCalledOnce();
        expect(roof.material.dispose).toHaveBeenCalledOnce();expect(roof.customDepthMaterial.dispose).toHaveBeenCalledOnce();
        expect(f.fixtures.length).toBeGreaterThan(0);
        for(const resource of new Set(f.fixtures.flatMap(fixture=>[fixture.geometry,fixture.material])))expect(resource.dispose).toHaveBeenCalledOnce();
        for(const lamp of f.lamps)expect(lamp.shadow.dispose).toHaveBeenCalledOnce();
        expect(f.group.children).not.toContain(f.nightLights);
        expect(f.controlsHost.children).toEqual([]);expect(f.frames.size).toBe(0);expect(f.observers[0].disconnect).toHaveBeenCalledOnce();
        expect(f.ambient.intensity).toBe(2.4);expect(f.oldLight.intensity).toBe(2);expect(f.renderer.shadowMap.enabled).toBe(false);
    });
});
