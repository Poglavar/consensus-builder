import {floorPreview} from './building-model.mjs';
// Rendering only; source counts, levels and placement evidence are pure data.
export function buildingGroup(THREE,building,architecture,level){
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
  for(const ring of floor.outlines){
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
 for(const {colour,opacity,positions} of batches.values()){
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  group.add(new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:colour,transparent:opacity<1,opacity})));
 }
 if(preview.placement){
  const floor=window.__threeFloorPlans.createLocalUnitGroup(THREE,architecture);
  floor.name='representative-floor';floor.position.z=preview.placement.elevationM;group.add(floor);
 }
 return group;
}
