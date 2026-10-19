// Apartment daylight from the same SunCalc astronomy as the stop-shade viewer.
(function(root,factory){
 const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.__apartmentSun=api;
})(typeof window!=='undefined'?window:null,function(){
 'use strict';
 const castsShadow=object=>object.name!=='UnitPart:glass'&&object.userData?.floorPartKind!=='glass';
 function ceilingParts(architecture,geometry){
  return geometry.buildLocalUnitParts(architecture).filter(part=>part.kind==='slab').map(part=>({
   ...part,baseM:architecture.wallHeightM,heightM:architecture.slabThicknessM
  }));
 }
 function buildCeiling(THREE,architecture,geometry){
  const group=new THREE.Group();group.name='ApartmentShadowCeiling';group.userData.cbFloorPlan=true;
  const material=new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false,side:THREE.DoubleSide});
  const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking});
  for(const part of ceilingParts(architecture,geometry)){
   const shape=new THREE.Shape(part.rings[0].map(p=>new THREE.Vector2(...p)));
   for(const ring of part.rings.slice(1))shape.holes.push(new THREE.Path(ring.map(p=>new THREE.Vector2(...p))));
   const geometry=new THREE.ExtrudeGeometry(shape,{depth:part.heightM,bevelEnabled:false});geometry.translate(0,0,part.baseM);
   const mesh=new THREE.Mesh(geometry,material);mesh.name='ShadowOnlyCeiling';mesh.castShadow=true;mesh.customDepthMaterial=depth;group.add(mesh);
  }
  return {group,dispose(){group.children.forEach(mesh=>mesh.geometry.dispose());material.dispose();depth.dispose();}};
 }
 function mount({THREE,scene,group,renderer,render,host,controlsHost,architecture,placement,location},env=globalThis){
  const state=env.__apartmentSunState,doc=env.document;
  const knownLocation=Number.isFinite(location?.lat)&&Number.isFinite(location?.lng);
  const latitude=knownLocation?location.lat:45.815,longitude=knownLocation?location.lng:15.982;
  const orientation=state.orientationFromPlacement(placement);
  let rotation=orientation.rotationDeg??0,manualNorth=false,day=state.dayBounds(),progress=state.progressAtTime(day,12);
  const media=env.matchMedia?.('(prefers-reduced-motion: reduce)');
  let paused=Boolean(media?.matches),disposed=false,frame=0,lastTime=null;
  const r=host.getBoundingClientRect();let onscreen=r.bottom>0&&r.right>0&&r.top<env.innerHeight&&r.left<env.innerWidth;
  const oldShadow={enabled:renderer.shadowMap.enabled,type:renderer.shadowMap.type};
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  const originalLights=scene.children.filter(child=>child.isLight).map(light=>({light,intensity:light.intensity}));
  const ambient=originalLights.find(({light})=>light.isHemisphereLight)?.light;
  originalLights.forEach(({light})=>{if(!light.isHemisphereLight)light.intensity=0;});
  group.traverse(object=>{if(object.isMesh){object.castShadow=castsShadow(object);object.receiveShadow=castsShadow(object);object.material.needsUpdate=true;}});
  const ceiling=buildCeiling(THREE,architecture,env.__buildingFloorPlans);group.add(ceiling.group);
  const size=Math.hypot(...architecture.dimensionsM,architecture.wallHeightM),radius=size/2+1,distance=size*3;
  const target=new THREE.Object3D();target.position.set(architecture.dimensionsM[0]/2,architecture.dimensionsM[1]/2,architecture.wallHeightM/2);
  const sun=new THREE.DirectionalLight(0xfff2da,3.2);sun.name='ApartmentSun';sun.castShadow=true;sun.target=target;
  sun.shadow.mapSize.set(2048,2048);sun.shadow.normalBias=.008;sun.shadow.bias=-.00005;
  Object.assign(sun.shadow.camera,{left:-radius,right:radius,top:radius,bottom:-radius,near:Math.max(.1,distance-radius*2),far:distance+radius*2});
  sun.shadow.camera.up.set(0,0,1);sun.shadow.camera.updateProjectionMatrix();scene.add(sun,target);
  const ui=doc.createElement('div');ui.className='apartment-sun-controls';ui.setAttribute('aria-label','Sunce i sjene');
  const timeline=doc.createElement('div');timeline.className='sun-timeline';
  const pause=doc.createElement('button');pause.type='button';pause.className='sun-pause';
  const time=doc.createElement('output');time.className='sun-time';
  const slider=doc.createElement('input');slider.type='range';slider.min='0';slider.max='1000';slider.step='1';slider.className='sun-slider';slider.setAttribute('aria-label','Vrijeme dana');
  const phase=doc.createElement('span');phase.className='sun-phase';timeline.append(pause,time,slider,phase);
  const options=doc.createElement('div');options.className='sun-options';
  const dateLabel=doc.createElement('label');dateLabel.textContent='Datum';
  const date=doc.createElement('input');date.type='date';date.value=day.date;dateLabel.append(date);
  const northLabel=doc.createElement('label');northLabel.textContent='Smjer N ↻';
  const north=doc.createElement('input');north.type='number';north.min='0';north.max='359';north.step='1';north.value=String(Math.round(rotation));north.setAttribute('aria-label','Smjer sjevera u stupnjevima udesno od vrha tlocrta');northLabel.append(north);
  options.append(dateLabel,northLabel);
  const note=doc.createElement('p');note.className='sun-note';
  ui.append(timeline,options,note);controlsHost.append(ui);
  function paint(){
   const sample=state.sampleSun({sunCalc:env.SunCalc,day,progress,latitude,longitude,rotationDeg:rotation}),d=sample.direction;
   sun.position.copy(target.position).addScaledVector(new THREE.Vector3(d.x,d.y,d.z),distance);
   const daylight=Math.max(0,Math.min(1,(sample.altitude+.1)/.3));
   sun.intensity=sample.daylight?3.2*Math.min(1,Math.sqrt(Math.max(0,d.z))*2):0;
   sun.color.set(sample.altitude<.18?0xffc180:0xfff2da);
   if(ambient)ambient.intensity=.26+daylight*.3;
   scene.background=new THREE.Color('#1d2937').lerp(new THREE.Color('#eef3f5'),daylight);
   time.textContent=sample.time;phase.textContent=sample.daylight?'Dan':'Noć';slider.value=String(Math.round(progress*1000));slider.setAttribute('aria-valuetext',sample.time);
   pause.textContent=paused?'▶':'Ⅱ';pause.setAttribute('aria-label',paused?'Pokreni izmjenu dana i noći':'Pauziraj izmjenu dana i noći');pause.setAttribute('aria-pressed',String(paused));
   const northText=manualNorth?'Ručno postavljen N':orientation.status==='placed'?'N prema poravnanju':'Smjer N nije potvrđen';
   note.textContent=`${northText} · strop pretpostavljen · ${knownLocation?'bez okolnih zgrada':'približna lokacija u Zagrebu'}`;
   note.title='Sjene prema rekonstruiranim zidovima i prozorima, uz pretpostavljen zatvoren strop. Smjer N je kut udesno od vrha tlocrta; okolne zgrade nisu uključene.';
   host.dataset.sunTime=sample.time;host.dataset.sunDate=day.date;host.dataset.sunAltitude=String(sample.altitude);host.dataset.sunlightState=paused?'paused':'running';
   render();
  }
  const active=()=>!disposed&&!paused&&!doc.hidden&&onscreen;
  function tick(now){frame=0;if(!active())return;if(lastTime===null)lastTime=now;
   if(now-lastTime>=50){progress=state.advanceProgress(progress,(now-lastTime)/1000);lastTime=now;paint();}
   frame=env.requestAnimationFrame(tick);
  }
  function sync(){if(frame)env.cancelAnimationFrame(frame);frame=0;lastTime=null;if(active())frame=env.requestAnimationFrame(tick);}
  pause.addEventListener('click',()=>{paused=!paused;paint();sync();});
  slider.addEventListener('input',()=>{paused=true;progress=Number(slider.value)/1000;paint();sync();});
  date.addEventListener('change',()=>{try{day=state.dayBounds(date.value);progress=state.progressAtTime(day,12);}catch{date.value=day.date;}paint();sync();});
  north.addEventListener('change',()=>{const value=Number(north.value);if(north.value!==''&&Number.isFinite(value)){rotation=((value%360)+360)%360;manualNorth=true;north.value=String(rotation);}else north.value=String(rotation);paint();});
  const motionChanged=()=>{if(media.matches)paused=true;paint();sync();};
  const observer=new env.IntersectionObserver(entries=>{onscreen=entries.some(e=>e.isIntersecting);sync();});observer.observe(host);
  doc.addEventListener('visibilitychange',sync);media?.addEventListener('change',motionChanged);paint();sync();
  return ()=>{disposed=true;sync();observer.disconnect();doc.removeEventListener('visibilitychange',sync);media?.removeEventListener('change',motionChanged);ui.remove();group.remove(ceiling.group);ceiling.dispose();scene.remove(sun,target);sun.shadow.dispose();
   originalLights.forEach(({light,intensity})=>{light.intensity=intensity;});renderer.shadowMap.enabled=oldShadow.enabled;renderer.shadowMap.type=oldShadow.type;
   delete host.dataset.sunTime;delete host.dataset.sunDate;delete host.dataset.sunAltitude;delete host.dataset.sunlightState;
  };
 }
 return {mount,ceilingParts,castsShadow};
});
