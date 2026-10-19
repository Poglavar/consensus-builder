// Demand-rendered Three.js previews; each host owns and disposes its WebGL resources.
(function(global){
'use strict';
async function preview(host,build,isCurrent){
 const [THREE,{OrbitControls}]=await Promise.all([import('three'),import('three/addons/controls/OrbitControls.js')]);
 if(!isCurrent())return null;
 const group=build(THREE);if(!group)throw new Error('No building geometry available');
 const scene=new THREE.Scene();scene.background=new THREE.Color('#f1f5f6');scene.add(group);
 const box=new THREE.Box3().setFromObject(group);if(box.isEmpty())throw new Error('Empty geometry');
 const centre=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),extent=Math.max(size.x,size.y,size.z,1);
 const camera=new THREE.PerspectiveCamera(40,1,.05,extent*30);camera.up.set(0,0,1);camera.position.copy(centre).add(new THREE.Vector3(extent*.85,-extent*1.3,extent*1.05));
 const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(global.devicePixelRatio,2));
 host.replaceChildren(renderer.domElement);
 scene.add(new THREE.HemisphereLight(0xffffff,0x75838b,2.4));const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(-extent,-extent,extent*2);scene.add(light);
 const aspect=host.clientWidth/Math.max(host.clientHeight,1),back=new THREE.Vector3(.85,-1.3,1.05).normalize();
 const right=new THREE.Vector3().crossVectors(camera.up,back).normalize(),up=new THREE.Vector3().crossVectors(back,right),tan=Math.tan(camera.fov*Math.PI/360);
 let distance=0;
 for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
  const point=new THREE.Vector3(x,y,z).sub(centre),depth=point.dot(back);
  distance=Math.max(distance,Math.abs(point.dot(right))/(tan*aspect)+depth,Math.abs(point.dot(up))/tan+depth);
 }
 camera.position.copy(centre).addScaledVector(back,distance*1.12);
 const controls=new OrbitControls(camera,renderer.domElement);controls.target.copy(centre);controls.enableDamping=false;controls.update();
 const render=()=>renderer.render(scene,camera);controls.addEventListener('change',render);
 const resize=()=>{const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();render();};
 const observer=new ResizeObserver(resize);observer.observe(host);resize();
 return ()=>{observer.disconnect();controls.dispose();global.__threeFloorPlans.disposeGroup(group);renderer.dispose();renderer.forceContextLoss();};
}
function landmark(THREE,data,location){
 const group=new THREE.Group();group.userData.cbFloorPlan=true;
 const project=global.__floorPlanReviewGeometry.projectAt(location);
 for(const part of data.parts){
  const positions=global.__floorPlanReviewGeometry.trianglePositions(part.geometry,project,data.groundZ);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();
  const glass=part.materialKind==='glass';
  const material=new THREE.MeshPhongMaterial({color:/^[a-f0-9]{6}$/i.test(part.color)?`#${part.color}`:part.color||'#d2c6b4',side:THREE.DoubleSide,transparent:glass,opacity:glass?.5:1,depthWrite:!glass,shininess:glass?70:10});
  group.add(new THREE.Mesh(geometry,material));
 }
 return group;
}
global.__floorPlanReviewRenderer={preview,landmark};
})(window);
