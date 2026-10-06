// Characterize mesh batching, hole forwarding, floor transforms and owned resource disposal.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), renderer=require('../../frontend/js/three-floor-plans.js');

class Object3D {
    constructor(){ this.children=[];this.position={z:0};this.scale={z:1};this.userData={};this.visible=true;this.isLight=false; }
    add(child){ this.children.push(child); }
    remove(child){ this.children=this.children.filter(c=>c!==child); }
    traverse(visit){ visit(this);this.children.forEach(c=>c.traverse(visit)); }
}
class Geometry {
    constructor(){ this.attributes={};this.disposeCount=0; }
    setAttribute(name,attribute){ this.attributes[name]=attribute; }
    dispose(){ this.disposeCount++; }
}
class Attribute {
    constructor(array){ this.array=new Float32Array(array);this.count=array.length/3; }
}
class Shape {
    constructor(points){ this.points=points;this.holes=[]; }
}
class Vector2 { constructor(x,y){ this.x=x;this.y=y; } }
class Extrusion extends Geometry {
    static sources=[];
    constructor(shape,options){
        super();this.shape=shape;Extrusion.sources.push(this);
        this.setAttribute('position',new Attribute(shape.points.flatMap(p=>[p.x,p.y,0,p.x,p.y,options.depth])));
        this.setAttribute('normal',new Attribute(shape.points.flatMap(()=>[0,0,-1,0,0,1])));
    }
    translate(x,y,z){
        const p=this.attributes.position.array;
        for(let i=0;i<p.length;i+=3){ p[i]+=x;p[i+1]+=y;p[i+2]+=z; }
    }
}
class Material {
    constructor(options){ Object.assign(this,options);this.disposeCount=0; }
    clone(){ return new Material(this); }
    dispose(){ this.disposeCount++; }
}
class Mesh extends Object3D { constructor(geometry,material){super();this.geometry=geometry;this.material=material;} }
const THREE={Group:Object3D,Shape,Path:Shape,Vector2,ExtrudeGeometry:Extrusion,BufferGeometry:Geometry,Float32BufferAttribute:Attribute,Mesh,MeshPhongMaterial:Material,DoubleSide:2};
const square=[[[0,0],[4,0],[4,4],[0,4]]],hole=[[1,1],[2,1],[2,2],[1,2]];
const feature={properties:{proposalId:'proposal',parcelId:'parcel',name:'House',floorPlans:{registration:{corners:[[0,0],[1,0],[1,1],[0,1]],accuracy:'approximate',maxEdgeResidualM:.1}}}};
const parts=[
    {kind:'wall',rings:square,baseM:0,heightM:2.8},
    {kind:'wall',rings:square,baseM:2.1,heightM:.7},
    {kind:'slab',rings:[...square,hole],baseM:-.2,heightM:.2},
    {kind:'glass',rings:square,baseM:.9,heightM:1.4}
];
const api={buildFloorPlanGeometry:()=>[
    {id:'a',level:0,elevationM:0,elevationBasis:'documented',layoutId:'x',sourceUrl:'a.pdf',apartmentCount:1,parts},
    {id:'b',level:1,elevationM:3,elevationBasis:'estimated',layoutId:'x',sourceUrl:'b.pdf',apartmentCount:2,parts}
]};
const floorApi=api;
const rendererApi=renderer;
const create=()=>renderer.createBuildingGroup(THREE,feature,()=>[0,0],api);

describe('three-floor-plans volumetric adapter',()=>{
    it('batches by material, forwards holes, retains prism heights, and shares repeated layouts',()=>{
        Extrusion.sources=[];
        const group=create(),first=group.children[0],second=group.children[1];
        expect(group.userData).toMatchObject({floorCount:2,registrationAccuracy:'approximate',maxEdgeResidualM:.1});
        expect(first.children).toHaveLength(3);expect(second.children).toHaveLength(3);
        expect(Extrusion.sources).toHaveLength(4); // Four authored parts, constructed once.
        expect(Extrusion.sources.every(source=>source.disposeCount===1)).toBe(true);
        expect(Extrusion.sources[2].shape.holes[0].points).toEqual(hole.map(p=>new Vector2(...p)));
        const wall=first.children[0].geometry,slab=first.children[1].geometry;
        expect(wall.attributes.position.count).toBe(16); // Both wall parts merged.
        const z=Array.from(slab.attributes.position.array).filter((_,i)=>i%3===2);
        expect(Math.min(...z)).toBeCloseTo(-.2);expect(Math.max(...z)).toBeCloseTo(0);
        expect(first.children.every((mesh,i)=>mesh.geometry===second.children[i].geometry)).toBe(true);
        expect([first.position.z,second.position.z]).toEqual([0,3]);
        expect(second.userData.sourceUrl).toBe('b.pdf');
    });
    it('uses ordinary depth occlusion for solids and transparent, non-writing glass',()=>{
        const meshes=create().children[0].children;
        expect(meshes[0].material).toMatchObject({depthTest:true,depthWrite:true,transparent:false,opacity:1});
        expect(meshes[2].material).toMatchObject({depthTest:true,depthWrite:false,transparent:true,opacity:.4});
    });
    it('cutaway changes visible levels and summaries, then restores all floors',()=>{
        const group=create();renderer.setCutaway(group,0);
        expect(group.children.map(f=>f.visible)).toEqual([true,false]);
        expect(renderer.summarize(group)).toEqual({floors:1,buildings:1,estimatedFloors:0,apartments:1});
        renderer.setCutaway(group,null);expect(renderer.summarize(group)).toEqual({floors:2,buildings:1,estimatedFloors:1,apartments:3});
        group.visible=false;expect(renderer.summarize(group).floors).toBe(0);
    });
    it('disposes shared geometry and materials exactly once',()=>{
        const group=create(),geometries=new Set(),materials=new Set();
        group.traverse(object=>{ if(object.geometry)geometries.add(object.geometry);if(object.material)materials.add(object.material); });
        expect(geometries.size).toBe(3);expect(materials.size).toBe(3);
        renderer.disposeGroup(group);renderer.disposeGroup(group);
        expect(group.children).toHaveLength(0);
        expect([...geometries,...materials].every(resource=>resource.disposeCount===1)).toBe(true);
    });
    it('renders below-ground cutaway without changing prior visibility and restores after errors',()=>{
        const floorGroup=create(), visible=new Object3D(), alreadyHidden=new Object3D(), light=new Object3D();
        alreadyHidden.visible=false; light.isLight=true; const scene={children:[floorGroup,visible,alreadyHidden,light]};
        const calls=[]; const renderer={render:()=>calls.push([visible.visible,alreadyHidden.visible,light.visible])};
        renderer.render(scene,{}); expect(calls[0]).toEqual([true,false,true]);
        renderer.render=()=>{ throw new Error('render failed'); };
        expect(()=>rendererApi.renderCutaway(renderer,scene,{},floorGroup,true)).toThrow('render failed');
        expect(visible.visible).toBe(true); expect(alreadyHidden.visible).toBe(false); expect(light.visible).toBe(true);
        renderer.render=()=>calls.push([visible.visible,alreadyHidden.visible,light.visible]);
        rendererApi.renderCutaway(renderer,scene,{},floorGroup,false);
        expect(calls.at(-1)).toEqual([true,false,true]);
    });
    it('creates only uncovered proxy bands and owns its cloned material',()=>{
        const proxyMaterial=new Material({color:1});
        const feature={geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]},properties:{floorPlans:{registration:{corners:[[0,0],[1,0],[1,1],[0,1]]}}}};
        const api={...floorApi, uncoveredFloorBands:()=>[{baseM:3,heightM:2}]};
        const group=rendererApi.createBuildingGroup(THREE,feature,()=>[0,0],api,{proxyHeightM:5,proxyMaterial});
        const proxies=group.children.filter(c=>c.userData.cbFloorPlanProxy);
        expect(proxies).toHaveLength(1); expect(proxies[0].position.z).toBe(3); expect(proxies[0].userData.heightM).toBe(2);
        expect(proxies[0].material).not.toBe(proxyMaterial);
        rendererApi.setCutaway(group,0); expect(proxies[0].visible).toBe(false); expect(proxies[0].scale.z).toBe(0);
        rendererApi.disposeGroup(group); expect(proxies[0].material.disposeCount).toBe(1);
    });
});
