// On-demand Google Photorealistic 3D Tiles for a bounded, local-metre context preview.
// The browser token is public and asset/origin scoped, as in the main map's photo viewer.
(function(root){
'use strict';
const ION_TOKEN='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjByd19iYkpMaW1yWU1aVWciLCJqdGkiOiJiNGU3YWZiMy02YjQ4LTQ3MjQtOWY2YS0yZmM2YTMyZjI5YjEiLCJpZCI6NDI0MDY3LCJzdWIiOiJwb2dsYXZhciIsImlzcyI6Imh0dHBzOi8vYXBpLmNlc2l1bS5jb20iLCJhdWQiOiJ6YWdyZWItbG9sIHBob3RvcmVhbCByZXN0cmljdGVkIDIwMjYtMTAiLCJpYXQiOjE3OTIwNjE2ODF9.ZTMHuX13FJ-HojChWk1Ip7V9gDBkRGHcACC8J_Hwopc';
const ASSET_ID=2275207;
let library;
function loadLibrary(){
 if(!library)library=Promise.all([import('3d-tiles-renderer/three'),import('3d-tiles-renderer/three/plugins'),import('three/addons/loaders/DRACOLoader.js')]).catch(error=>{library=null;throw error;});
 return library;
}
function targetGroup(THREE,model){
 const frame=root.__siteModelGeometry.localFrame(model),group=new THREE.Group();group.userData.cbFloorPlan=true;
 const footprint=model.envelope.footprint,polygons=footprint.type==='MultiPolygon'?footprint.coordinates:[footprint.coordinates];
 const levels=model.envelope.storeys||[];
 const top=Math.max(3,...levels.map(s=>Number.isFinite(s.elevationM)&&Number.isFinite(s.heightM)?s.elevationM+s.heightM:0));
 for(const coordinates of polygons){
  const ring=coordinates[0].map(frame.toLocal),shape=new THREE.Shape(ring.map(([x,y])=>new THREE.Vector2(x,y)));
  for(const hole of coordinates.slice(1))shape.holes.push(new THREE.Path(hole.map(frame.toLocal).map(([x,y])=>new THREE.Vector2(x,y))));
  const solid=new THREE.ExtrudeGeometry(shape,{depth:top,bevelEnabled:false}),edges=new THREE.EdgesGeometry(solid);
  const surface=new THREE.Mesh(solid,new THREE.MeshPhongMaterial({color:0xe2a434,transparent:true,opacity:.22,depthWrite:false,depthTest:false,side:THREE.DoubleSide,shininess:12}));surface.renderOrder=9;group.add(surface);
  const marker=new THREE.LineSegments(edges,new THREE.LineBasicMaterial({color:0xe2a434,transparent:true,opacity:.85,depthTest:false}));marker.renderOrder=10;group.add(marker);
 }
 return group;
}
async function mount(host,project,isCurrent){
 const modules=await loadLibrary();if(!isCurrent())return null;
 return root.__floorPlanReviewRenderer.preview(host,THREE=>targetGroup(THREE,project.model),isCurrent,{
  enablePan:false,enableZoom:true,minPolarAngle:.15,maxPolarAngle:Math.PI*.48,minDistance:25,maxDistance:260,
  setup:internals=>attach(host,project,isCurrent,modules,internals)
 });
}
function attach(host,project,isCurrent,modules,{THREE,scene,camera,renderer,controls,render}){
 const [{TilesRenderer},{CesiumIonAuthPlugin,ReorientationPlugin,GLTFExtensionsPlugin,TileCompressionPlugin},{DRACOLoader}]=modules;
 const origin=root.__siteModelGeometry.localFrame(project.model).origin;
 const tiles=new TilesRenderer(),decoder=new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/draco/gltf/');
 tiles.registerPlugin(new CesiumIonAuthPlugin({apiToken:ION_TOKEN,assetId:ASSET_ID}));
 tiles.registerPlugin(new ReorientationPlugin({lat:origin[1]*Math.PI/180,lon:origin[0]*Math.PI/180,height:0}));
 tiles.registerPlugin(new GLTFExtensionsPlugin({dracoLoader:decoder}));tiles.registerPlugin(new TileCompressionPlugin());
 tiles.errorTarget=16;tiles.lruCache.minSize=64;tiles.lruCache.maxSize=160;tiles.parseQueue.maxJobs=2;tiles.downloadQueue.maxJobs=4;
 const frame=new THREE.Group(),seat=new THREE.Group(),e=root.__photorealFrame.TILES_FRAME_EULER;
 frame.rotation.set(e.x,e.y,e.z,e.order);frame.add(tiles.group);seat.add(frame);scene.add(seat);tiles.group.visible=false;
 scene.background=new THREE.Color('#dcebf0');
 const direction=camera.position.clone().sub(controls.target).normalize();camera.position.copy(controls.target).addScaledVector(direction,170);camera.near=.5;camera.far=420;camera.updateProjectionMatrix();controls.update();
 tiles.setCamera(camera);tiles.setResolutionFromRenderer(camera,renderer);
 const status=document.createElement('p');status.className='context-google-status';status.textContent='Učitavanje Google 3D prikaza…';status.setAttribute('role','status');
 const credit=document.createElement('div');credit.className='context-google-credit';
 const logo=document.createElement('img');logo.src='https://maps.gstatic.com/mapfiles/api-3/images/google_white5_hdpi.png';logo.alt='Google';logo.width=66;logo.height=26;
 const copyrights=document.createElement('span');credit.append(logo,copyrights);host.append(status,credit);
 const cached=new Map();let revision=0,probed=-1,frameId=0,disposed=false,failed=false,onScreen=true,grounded=false,locked=false,lastLoad=performance.now(),lastProbe=0,lastCredit=0,lastTick=0,lastFrame=null,loadingMs=0;
 const onLoad=event=>{if(event.scene)cached.set(event.scene,event.tile?.internal?.depth||0);revision++;lastLoad=performance.now();};
 const onUnload=event=>{cached.delete(event.scene);revision++;};
 tiles.addEventListener('load-model',onLoad);tiles.addEventListener('dispose-model',onUnload);
 function seatGround(now){
  if(locked||revision===probed||now-lastProbe<650||!cached.size)return;
  lastProbe=now;probed=revision;seat.updateMatrixWorld(true);
  const inverse=tiles.group.matrixWorld.clone().invert();
  // Detached cached models remain in ECEF, attached models are in the preview scene.
  // Use the same cached-top-surface/p25 estimator as the main photo viewer, never a roof-centre ray.
  const probes=[[0,0],[45,0],[-45,0],[0,45],[0,-45],[45,45],[-45,-45]].map(([x,y])=>{
   const worldRay=new THREE.Raycaster(new THREE.Vector3(x,y,10000),new THREE.Vector3(0,0,-1),0,12000);
   const sourceRay=new THREE.Raycaster();sourceRay.ray.copy(worldRay.ray).applyMatrix4(inverse);sourceRay.near=0;sourceRay.far=12000;
   const hits=[];
   for(const [model,depth]of cached){
    model.updateMatrixWorld(true);const hit=(model.parent?worldRay:sourceRay).intersectObject(model,true)[0];
    if(hit){const point=hit.point.clone();if(!model.parent)point.applyMatrix4(tiles.group.matrixWorld);hits.push({height:point.z,depth});}
   }
   return hits;
  });
  const height=root.__photorealGround.selectBootstrapHeight(probes,seat.position.z);
  if(height===null)return;
  seat.position.z-=height;seat.updateMatrixWorld(true);grounded=true;tiles.group.visible=true;status.hidden=true;
  host.dataset.googleState='ready';
  if(root.__photorealGround.canFinalizeSeating(tiles.loadProgress,now-lastLoad))locked=true;
 }
 function updateCredit(){copyrights.textContent=root.PhotorealAttribution.attributionText(tiles.getAttributions());}
 function tick(now){
  frameId=0;if(disposed||failed||!isCurrent()||document.hidden||!onScreen)return;
  if(!grounded)loadingMs+=lastFrame===null?0:Math.min(now-lastFrame,1000);lastFrame=now;
  if(!grounded&&loadingMs>=45000){failed=true;host.dataset.googleState='error';status.hidden=false;status.textContent='Google 3D nije učitan. Odaberi Model pa pokušaj ponovno.';return;}
  if(now-lastTick>=33){
   lastTick=now;camera.updateMatrixWorld();tiles.setResolutionFromRenderer(camera,renderer);tiles.update();seatGround(now);
   if(now-lastCredit>1000){lastCredit=now;updateCredit();}render();
  }
  frameId=requestAnimationFrame(tick);
 }
 function resume(){if(disposed||failed)return;if(document.hidden||!onScreen){cancelAnimationFrame(frameId);frameId=0;lastFrame=null;}else if(!frameId)frameId=requestAnimationFrame(tick);}
 const observer=new IntersectionObserver(entries=>{onScreen=entries[0]?.isIntersecting??true;resume();});observer.observe(host);
 document.addEventListener('visibilitychange',resume);
 host.dataset.googleState='loading';resume();
 return ()=>{disposed=true;cancelAnimationFrame(frameId);observer.disconnect();document.removeEventListener('visibilitychange',resume);tiles.removeEventListener('load-model',onLoad);tiles.removeEventListener('dispose-model',onUnload);tiles.dispose();decoder.dispose();cached.clear();scene.remove(seat);status.remove();credit.remove();delete host.dataset.googleState;};
}
root.NovogradnjeGoogleContext={mount};
})(window);
