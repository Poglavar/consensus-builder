// Shared interior rendering, walking and lifecycle support.
import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),THREE=require('three');
const api=require('../../packages/interior-viewer');
const bundled=require('../../frontend/vendor/interior-viewer/interior-viewer.js');
const geometryOnly=require('../../frontend/vendor/interior-viewer/interior-geometry.js');
const meshesOnly=require('../../frontend/vendor/interior-viewer/interior-meshes.js');
const architecture=()=>({schema:api.geometry.ARCHITECTURE_SCHEMA,dimensionsM:[8,6],wallHeightM:2.8,slabThicknessM:.2,
    walls:[[[[0,0],[1,0],[1,.02],[0,.02]]]],slabs:[[[[0,0],[1,0],[1,1],[0,1]]]],landings:[],platforms:[],openings:[],stairs:[],railings:[]});
function element(){return {children:[],dataset:{},attributes:new Map(),style:{},listeners:new Map(),clientWidth:640,clientHeight:480,
    append(...children){for(const child of children){this.children.push(child);child.parent=this;}},remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);},
    setAttribute(k,v){this.attributes.set(k,String(v));},getAttribute(k){return this.attributes.get(k)??null;},removeAttribute(k){this.attributes.delete(k);},
    addEventListener(k,v){if(!this.listeners.has(k))this.listeners.set(k,new Set());this.listeners.get(k).add(v);},removeEventListener(k,v){this.listeners.get(k)?.delete(v);},focus(){},
    getBoundingClientRect(){return {left:0,top:0,width:640,height:480};}};}
function environment(){const document=element();document.createElement=element;document.hidden=false;const callbacks=new Map();let id=0;
    return {document,callbacks,requestAnimationFrame:fn=>{callbacks.set(++id,fn);return id;},cancelAnimationFrame:i=>callbacks.delete(i)};}
class Renderer {constructor(){this.domElement=element();this.dispose=vi.fn();this.forceContextLoss=vi.fn();this.render=vi.fn();}setPixelRatio(){}setSize(){}}
class Controls {constructor(){this.target=new THREE.Vector3();this.enabled=true;this.autoRotate=false;this.dispose=vi.fn();this.update=vi.fn();this.events=new Map();}addEventListener(k,v){this.events.set(k,v);}removeEventListener(k){this.events.delete(k);}}

describe('shared interior package',()=>{
    it('exports equivalent geometry and mesh buffers through source and browser CommonJS APIs',()=>{
        const a=architecture();expect(api.geometry.validateArchitecture(a)).toEqual([]);
        expect(bundled.geometry.buildLocalUnitParts(a)).toEqual(api.geometry.buildLocalUnitParts(a));
        expect(geometryOnly.buildLocalUnitParts(a)).toEqual(api.geometry.buildLocalUnitParts(a));
        const meshOnly=meshesOnly.createLocalUnitGroup(THREE,a);
        expect(meshOnly.children.map(m=>m.name)).toEqual(['UnitPart:wall','UnitPart:slab']);
        meshesOnly.disposeGroup(meshOnly);
        expect(Object.keys(bundled.meshes).sort()).toEqual(['createBuildingGroup','createLocalUnitGroup','disposeGroup','renderCutaway','setCutaway','summarize']);
        expect(api.geometry.buildLocalUnitParts(a).find(p=>p.kind==='slab')).toMatchObject({baseM:-.2,heightM:.2,rings:[[[0,6],[8,6],[8,0],[0,0]]]});
        const source=api.meshes.createLocalUnitGroup(THREE,a),built=bundled.meshes.createLocalUnitGroup(THREE,a);
        expect(source.children.map(m=>Array.from(m.geometry.attributes.position.array))).toEqual(built.children.map(m=>Array.from(m.geometry.attributes.position.array)));
        api.meshes.disposeGroup(source);bundled.meshes.disposeGroup(built);
    });
    it('normalizes plan envelopes and rejects invalid architecture',()=>{
        const a=architecture();expect(api.normalizeArchitecture({architecture:a})).toBe(a);
        a.walls[0][0][0]=[2,0];expect(()=>api.normalizeArchitecture(a)).toThrow('normalized');expect(()=>api.normalizeArchitecture({dimensionsM:[8,6]})).toThrow('must use');
    });
    it('retains negative stair/platform elevations and deduplicates datum landings',()=>{
        const a=architecture();a.platforms=[{rings:a.slabs[0],kind:'landing',elevationM:0},{rings:a.slabs[0],kind:'landing',elevationM:-1}];
        a.stairs=[{a:[.2,.2],b:[.4,.4],widthM:1,steps:4,fromM:-1,toM:0}];expect(api.geometry.validateArchitecture(a)).toEqual([]);
        const stairs=api.geometry.buildLocalUnitParts(a).filter(p=>p.kind==='stair');expect(stairs).toHaveLength(5);expect(Math.min(...stairs.map(p=>p.baseM))).toBeCloseTo(-1.2);
    });
    it('transforms local metres and leaves host camera, renderer, controls and environment owned by the host',()=>{
        const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(),renderer={dispose:vi.fn(),toneMapping:12},controls={dispose:vi.fn()};
        const texture=new THREE.Texture(),external=new THREE.Object3D();scene.environment=texture;scene.add(external);camera.position.set(3,4,5);
        const mount=api.attach({THREE,scene,camera,renderer,controls,architecture:architecture(),placement:{position:[10,20,30],quaternion:[0,0,Math.SQRT1_2,Math.SQRT1_2],scale:[2,2,3]}});
        scene.updateMatrixWorld(true);expect(mount.root.localToWorld(new THREE.Vector3(1,0,0)).toArray()).toEqual([10,22,30]);mount.dispose();mount.dispose();
        expect(scene.children).toEqual([external]);expect(scene.environment).toBe(texture);expect(camera.position.toArray()).toEqual([3,4,5]);expect(renderer.toneMapping).toBe(12);expect(renderer.dispose).not.toHaveBeenCalled();expect(controls.dispose).not.toHaveBeenCalled();
    });
    it('disposes owned buffers once and retains consumer-added shared resources',()=>{
        const group=api.meshes.createLocalUnitGroup(THREE,architecture(),undefined,{colors:{wall:'#123456'}});expect(group.children.find(m=>m.name==='UnitPart:wall').material.color.getHexString()).toBe('123456');
        const spies=group.children.flatMap(m=>[vi.spyOn(m.geometry,'dispose'),vi.spyOn(m.material,'dispose')]);
        const sharedGeometry=new THREE.BoxGeometry(),sharedMaterial=new THREE.MeshBasicMaterial(),shared=vi.spyOn(sharedMaterial,'dispose');group.add(new THREE.Mesh(sharedGeometry,sharedMaterial));
        api.meshes.disposeGroup(group);api.meshes.disposeGroup(group);expect(spies.every(s=>s.mock.calls.length===1)).toBe(true);expect(shared).not.toHaveBeenCalled();sharedGeometry.dispose();sharedMaterial.dispose();
    });
    it('uses swept-body navigation with wall partitions, boundary clearance and slab holes',()=>{
        const a=architecture(),nav=api.navigation.buildNavigation(a);expect(nav.components[0].length).toBeGreaterThan(10);expect(nav.canWalk([1,1],[6,4])).toBe(true);expect(nav.canWalk([.1,1])).toBe(false);
        a.walls.push([[[.48,0],[.52,0],[.52,1],[.48,1]]]);const divided=api.navigation.buildNavigation(a);expect(divided.canWalk([2,3],[6,3])).toBe(false);expect(divided.components).toHaveLength(2);
        expect(api.navigation.findPath(divided,divided.components[0][0],divided.components[1][0])).toEqual([]);
        a.slabs[0].push([[.2,.2],[.4,.2],[.4,.4],[.2,.4]]);expect(api.navigation.buildNavigation(a).canWalk([2.4,4.2])).toBe(false);
    });
    it('rejects walking without host hooks and non-invertible placement',()=>{
        expect(()=>api.attach({THREE,scene:new THREE.Scene(),architecture:architecture(),walking:true})).toThrow('host animate');
        expect(()=>api.attach({THREE,scene:new THREE.Scene(),architecture:architecture(),placement:{matrix:new Array(16).fill(0)}})).toThrow('invertible');
    });
    it('walking restores the camera and unregisters all hooks and listeners',()=>{
        const env=environment(),host=element(),renderer=new Renderer(),camera=new THREE.PerspectiveCamera(),controls=new Controls(),animators=new Set();camera.position.set(4,8,9);
        const mount=api.attach({THREE,scene:new THREE.Scene(),architecture:architecture(),host,renderer,camera,controls,walking:true,env,animate:a=>{animators.add(a);return ()=>animators.delete(a);},labels:{people:['First','Second']}});
        controls.update.mockImplementation(() => { camera.position.set(99,99,99); camera.quaternion.identity(); controls.target.set(99,99,99); });
        expect(mount.walkers).toHaveLength(2);expect(animators.size).toBe(2);mount.personView.enter(0);expect(controls.enabled).toBe(false);expect(camera.near).toBeCloseTo(.035);mount.personView.exit();expect(controls.enabled).toBe(true);expect(camera.position.toArray()).toEqual([4,8,9]);
        mount.dispose();mount.dispose();expect(animators.size).toBe(0);expect(host.children).toHaveLength(0);expect([...env.document.listeners.values()].every(s=>s.size===0)).toBe(true);expect([...renderer.domElement.listeners.values()].every(s=>s.size===0)).toBe(true);
    });
    it('optional look preserves host presentation and restores owned materials before geometry disposal',()=>{
        const group=api.meshes.createLocalUnitGroup(THREE,architecture()),scene=new THREE.Scene(),texture=new THREE.Texture();scene.environment=texture;scene.environmentIntensity=.7;
        const env=environment();env.getComputedStyle=()=>({getPropertyValue:()=>''});env.document.createElement=()=>({...element(),getContext:()=>({fillRect(){},beginPath(){},moveTo(){},bezierCurveTo(){},stroke(){}})});
        const renderer={toneMapping:123,toneMappingExposure:2,capabilities:{getMaxAnisotropy:()=>4}};
        const before=group.children.map(m=>m.material),originals=before.map(m=>vi.spyOn(m,'dispose'));
        const look=api.look.mount({THREE,scene,group,renderer,render:()=>{}},{host:element()},env);
        const after=group.children.filter(m=>m.name.startsWith('UnitPart:')).map(m=>m.material),replacements=after.map(m=>vi.spyOn(m,'dispose'));
        expect(scene.environment).toBe(texture);expect(scene.environmentIntensity).toBe(.7);expect(renderer.toneMapping).toBe(123);
        look.dispose();look.dispose();expect(group.children.map(m=>m.material)).toEqual(before);expect(replacements.every(s=>s.mock.calls.length===1)).toBe(true);expect(originals.every(s=>s.mock.calls.length===0)).toBe(true);
        api.meshes.disposeGroup(group);expect(originals.every(s=>s.mock.calls.length===1)).toBe(true);
    });
    it('standalone owns one demand loop and releases renderer, canvas and pending work',async()=>{
        const env=environment(),host=element();const mount=await api.mountStandalone(host,architecture(),{THREE:{...THREE,WebGLRenderer:Renderer},OrbitControls:Controls,env});
        expect(env.callbacks.size).toBe(1);mount.render();mount.render();expect(env.callbacks.size).toBe(1);
        const [id,frame]=[...env.callbacks][0];env.callbacks.delete(id);frame(0);expect(mount.renderer.render).toHaveBeenCalledTimes(1);expect(env.callbacks.size).toBe(0);
        mount.render();mount.dispose();mount.dispose();expect(env.callbacks.size).toBe(0);expect(host.children).toHaveLength(0);expect(mount.controls.dispose).toHaveBeenCalledTimes(1);expect(mount.renderer.dispose).toHaveBeenCalledTimes(1);expect(mount.renderer.forceContextLoss).toHaveBeenCalledTimes(1);
    });
});
