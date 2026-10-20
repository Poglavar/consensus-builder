import {floorPreview} from './building-model.mjs';
import {registeredPoint} from './registration.mjs';
function orientUnit(THREE,architecture,candidate,elevationM=0){
 const floor=window.__threeFloorPlans.createLocalUnitGroup(THREE,architecture);
 if(candidate){
  const [a,b,c,d,tx,ty]=candidate.matrix;
  floor.applyMatrix4(new THREE.Matrix4().set(a,c,0,tx,b,d,0,ty,0,0,1,elevationM,0,0,0,1));
 }else floor.position.z=elevationM;
 return floor;
}
function northArrow(THREE,group){
 const box=new THREE.Box3().setFromObject(group),size=box.getSize(new THREE.Vector3()),length=Math.max(size.x,size.y)*.15;
 const origin=new THREE.Vector3(box.min.x-length*.7,box.min.y,box.min.z);
 group.add(new THREE.ArrowHelper(new THREE.Vector3(0,1,0),origin,length,0x117c98,length*.2,length*.1));
}
export function registeredUnitGroup(THREE,architecture,candidate){
 const group=new THREE.Group();group.userData.cbFloorPlan=true;
 group.add(orientUnit(THREE,architecture,candidate));if(candidate)northArrow(THREE,group);return group;
}
// Rendering only; source counts, levels and placement evidence are pure data.
export function buildingGroup(THREE,building,architecture,level,candidate){
 const group=new THREE.Group();group.userData.cbFloorPlan=true;
 const preview=floorPreview(building,level);
 const batches=new Map();
 const line=(points,colour,opacity=1)=>{
  const key=colour+':'+opacity;
  if(!batches.has(key))batches.set(key,{colour,opacity,positions:[]});
  const batch=batches.get(key);
  for(let i=1;i<points.length;i++)batch.positions.push(...points[i-1],...points[i]);
 };
 for(const floor of preview.storeys){
  const selected=floor.level===level,colour=selected?0xcc840d:floor.level<0?0x96734b:0x456577;
  for(const outline of floor.outlines){
   const ring=candidate?outline.map(p=>registeredPoint(p,candidate.matrix)):outline;
   const closed=[...ring,ring[0]];
   line(closed.map(p=>[...p,floor.elevationM]),colour);
   if(floor===preview.storeys.at(-1))line(closed.map(p=>[...p,floor.elevationM+floor.heightM]),colour,.8);
   for(let i=0;i<ring.length;i++){
    const p=ring[i],a=ring[(i+ring.length-1)%ring.length],b=ring[(i+1)%ring.length];
    const ux=p[0]-a[0],uy=p[1]-a[1],vx=b[0]-p[0],vy=b[1]-p[1],length=Math.hypot(ux,uy)*Math.hypot(vx,vy);
    // Curved CAD outlines contain many samples; only visible corners need vertical edges.
    if(length&&Math.acos(Math.min(1,Math.max(-1,(ux*vx+uy*vy)/length)))>.15)line([[...p,floor.elevationM],[...p,floor.elevationM+floor.heightM]],colour,.45);
   }
  }
 }
 if(candidate)for(const target of building.registration.targets){
  line([...target.ring,target.ring[0]].map(p=>[...p,.025]),0xa33469);
 }
 for(const {colour,opacity,positions} of batches.values()){
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  group.add(new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:colour,transparent:opacity<1,opacity})));
 }
 if(preview.placement){
  const floor=orientUnit(THREE,architecture,candidate,preview.placement.elevationM);
  floor.name='representative-floor';group.add(floor);
 }
 if(candidate)northArrow(THREE,group);
 return group;
}
