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
 function buildNightLights(THREE,architecture,rooms){
  const group=new THREE.Group();group.name='ApartmentNightLights';
  const geometry=new THREE.CylinderGeometry(.17,.17,.045,16).rotateX(Math.PI/2);
  const material=new THREE.MeshBasicMaterial({color:0xffe4b0}),lights=[];
  for(const [index,[x,y]] of rooms.lampPositions(architecture).entries()){
   const fixture=new THREE.Mesh(geometry,material);fixture.name='CeilingLamp';fixture.position.set(x,y,architecture.wallHeightM-.07);
   const light=new THREE.SpotLight(0xffdfaa,0,architecture.wallHeightM*3,Math.PI*.43,.55,2);
   light.name='ApartmentNightLamp';light.position.set(x,y,architecture.wallHeightM-.13);light.target=new THREE.Object3D();light.target.position.set(x,y,0);
   light.castShadow=index<8;light.shadow.mapSize.set(512,512);light.shadow.normalBias=.015;light.shadow.bias=-.0001;
   light.shadow.camera.near=.05;light.shadow.camera.far=architecture.wallHeightM*3;
   group.add(fixture,light,light.target);lights.push(light);
  }
  group.visible=false;
  return {group,setNight(night){group.visible=night;lights.forEach(light=>{light.intensity=night?35:0;});},
   dispose(){geometry.dispose();material.dispose();lights.forEach(light=>light.shadow.dispose());}};
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
  const nightLights=buildNightLights(THREE,architecture,env.__apartmentLightRooms);group.add(nightLights.group);
  const size=Math.hypot(...architecture.dimensionsM,architecture.wallHeightM),radius=size/2+1,distance=size*3;
  const target=new THREE.Object3D();target.position.set(architecture.dimensionsM[0]/2,architecture.dimensionsM[1]/2,architecture.wallHeightM/2);
  const sun=new THREE.DirectionalLight(0xfff2da,3.2);sun.name='ApartmentSun';sun.castShadow=true;sun.target=target;
  sun.shadow.mapSize.set(2048,2048);sun.shadow.normalBias=.008;sun.shadow.bias=-.00005;
  Object.assign(sun.shadow.camera,{left:-radius,right:radius,top:radius,bottom:-radius,near:Math.max(.1,distance-radius*2),far:distance+radius*2});
  sun.shadow.camera.up.set(0,0,1);sun.shadow.camera.updateProjectionMatrix();scene.add(sun,target);
  const ui=doc.createElement('div');ui.className='apartment-sun-controls';ui.setAttribute('aria-label','Sunce i sjene');
  const dials=doc.createElement('div');dials.className='sun-dials';
  const clockWrap=doc.createElement('div');clockWrap.className='sun-clock-wrap';
  const clock=doc.createElement('button');clock.type='button';clock.className='sun-clock';
  for(const [label,position] of [['12','top'],['3','right'],['6','bottom'],['9','left']]){
   const number=doc.createElement('span');number.className=`dial-mark dial-${position}`;number.textContent=label;clock.append(number);
  }
  const hourHand=doc.createElement('span');hourHand.className='clock-hand clock-hour';
  const minuteHand=doc.createElement('span');minuteHand.className='clock-hand clock-minute';
  const pivot=doc.createElement('span');pivot.className='dial-pivot';clock.append(hourHand,minuteHand,pivot);
  const time=doc.createElement('output');time.className='sun-time';
  const phase=doc.createElement('span');phase.className='sun-phase';clockWrap.append(clock,time,phase);
  const dateLabel=doc.createElement('label');dateLabel.className='sun-date';dateLabel.textContent='Datum';
  const date=doc.createElement('input');date.type='date';date.value=day.date;dateLabel.append(date);
  const compassWrap=doc.createElement('div');compassWrap.className='sun-compass-wrap';
  const compass=doc.createElement('div');compass.className='sun-compass';compass.tabIndex=0;
  compass.setAttribute('role','slider');compass.setAttribute('aria-label','Zakreni sjever');compass.setAttribute('aria-valuemin','0');compass.setAttribute('aria-valuemax','359');
  compass.title='Povuci za smjer sjevera; tipke sa strelicama zakreću za 5°.';
  const needle=doc.createElement('span');needle.className='compass-needle';
  const northMark=doc.createElement('span');northMark.className='compass-north';northMark.textContent='N';needle.append(northMark);
  const compassPivot=doc.createElement('span');compassPivot.className='dial-pivot';compass.append(needle,compassPivot);
  const bearing=doc.createElement('output');bearing.className='sun-bearing';
  const compassHint=doc.createElement('span');compassHint.className='sun-phase';compassHint.textContent='Povuci N';compassWrap.append(compass,bearing,compassHint);
  dials.append(clockWrap,dateLabel,compassWrap);
  const note=doc.createElement('p');note.className='sun-note';
  ui.append(dials,note);controlsHost.append(ui);
  function paint(){
   const sample=state.sampleSun({sunCalc:env.SunCalc,day,progress,latitude,longitude,rotationDeg:rotation}),d=sample.direction;
   sun.position.copy(target.position).addScaledVector(new THREE.Vector3(d.x,d.y,d.z),distance);
   const daylight=Math.max(0,Math.min(1,(sample.altitude+.1)/.3));
   sun.intensity=sample.daylight?3.2*Math.min(1,Math.sqrt(Math.max(0,d.z))*2):0;
   sun.color.set(sample.altitude<.18?0xffc180:0xfff2da);
   nightLights.setNight(!sample.daylight);
   if(ambient)ambient.intensity=.26+daylight*.3;
   scene.background=new THREE.Color('#1d2937').lerp(new THREE.Color('#eef3f5'),daylight);
   const hands=state.clockHands(sample.time);
   hourHand.style.transform=`rotate(${hands.hourDeg}deg)`;minuteHand.style.transform=`rotate(${hands.minuteDeg}deg)`;
   time.textContent=sample.time;phase.textContent=`${sample.daylight?'Dan':'Noć'}${paused?' · pauza':''}`;
   clock.setAttribute('aria-label',`${sample.time} · ${paused?'Pokreni':'Pauziraj'} izmjenu dana i noći`);clock.setAttribute('aria-pressed',String(paused));
   clock.title=paused?'Klikni za pokretanje':'Klikni za pauzu';clock.dataset.paused=String(paused);
   needle.style.transform=`rotate(${rotation}deg)`;bearing.textContent=`N ${Math.round(rotation)%360}°`;
   compass.setAttribute('aria-valuenow',String(Math.round(rotation)%360));compass.setAttribute('aria-valuetext',`${Math.round(rotation)%360} stupnjeva udesno od vrha tlocrta`);
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
  clock.addEventListener('click',()=>{paused=!paused;paint();sync();});
  clock.addEventListener('keydown',event=>{
   const delta={ArrowRight:1,ArrowUp:1,ArrowLeft:-1,ArrowDown:-1}[event.key];if(!delta)return;
   event.preventDefault();paused=true;progress=(progress+delta*3600000/day.durationMs+1)%1;paint();sync();
  });
  date.addEventListener('change',()=>{try{day=state.dayBounds(date.value);progress=state.progressAtTime(day,12);}catch{date.value=day.date;}paint();sync();});
  function setNorth(value){rotation=((value%360)+360)%360;manualNorth=true;paint();}
  function pointNorth(event){const box=compass.getBoundingClientRect(),value=state.compassBearing(event.clientX-box.left-box.width/2,event.clientY-box.top-box.height/2);if(value!==null)setNorth(value);}
  let dragPointer=null;
  compass.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();dragPointer=event.pointerId;compass.setPointerCapture(event.pointerId);compass.focus();pointNorth(event);});
  compass.addEventListener('pointermove',event=>{if(event.pointerId===dragPointer)pointNorth(event);});
  function finishDrag(event){if(event.pointerId===dragPointer)dragPointer=null;}
  compass.addEventListener('pointerup',finishDrag);compass.addEventListener('pointercancel',finishDrag);compass.addEventListener('lostpointercapture',finishDrag);
  compass.addEventListener('keydown',event=>{
   const delta={ArrowRight:1,ArrowUp:1,ArrowLeft:-1,ArrowDown:-1}[event.key];if(!delta&&event.key!=='Home')return;
   event.preventDefault();setNorth(event.key==='Home'?0:rotation+delta*(event.shiftKey?1:5));
  });
  const motionChanged=()=>{if(media.matches)paused=true;paint();sync();};
  const observer=new env.IntersectionObserver(entries=>{onscreen=entries.some(e=>e.isIntersecting);sync();});observer.observe(host);
  doc.addEventListener('visibilitychange',sync);media?.addEventListener('change',motionChanged);paint();sync();
  return ()=>{disposed=true;sync();observer.disconnect();doc.removeEventListener('visibilitychange',sync);media?.removeEventListener('change',motionChanged);ui.remove();group.remove(ceiling.group,nightLights.group);ceiling.dispose();nightLights.dispose();scene.remove(sun,target);sun.shadow.dispose();
   originalLights.forEach(({light,intensity})=>{light.intensity=intensity;});renderer.shadowMap.enabled=oldShadow.enabled;renderer.shadowMap.type=oldShadow.type;
   delete host.dataset.sunTime;delete host.dataset.sunDate;delete host.dataset.sunAltitude;delete host.dataset.sunlightState;
  };
 }
 return {mount,ceilingParts,castsShadow};
});
