// Follow a simulated person's eye position; pointer gestures change only the viewing direction.
(function(root,factory){
 const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.__apartmentPersonView=api;
})(typeof window!=='undefined'?window:null,function(){
 'use strict';
 const clampPitch=value=>Math.max(-Math.PI*.42,Math.min(Math.PI*.42,value));
 function eyePose(walker,height,yaw=0,pitch=0){
  const angle=walker.heading+yaw,tilt=clampPitch(pitch),horizontal=Math.cos(tilt);
  return {eye:[walker.x,walker.y,height+.01],target:[walker.x+Math.cos(angle)*horizontal,walker.y+Math.sin(angle)*horizontal,height+.01+Math.sin(tilt)]};
 }
 function mount({THREE,group,figures,walkers,camera,controls,renderer,render,host,stopAutoRotate},env=globalThis){
  const doc=env.document,canvas=renderer.domElement,ray=new THREE.Raycaster(),point=new THREE.Vector2();
  const names=['Muškarac','Žena'],ids=['male','female'];
  const ui=doc.createElement('div');ui.className='person-view-controls';ui.setAttribute('role','group');ui.setAttribute('aria-label','Pogled iz prve osobe');
  const buttons=figures.map((_,index)=>{const button=doc.createElement('button');button.type='button';button.textContent=names[index];button.title=`Pogled ${index?'žene':'muškarca'}`;button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed','false');button.addEventListener('click',()=>enter(index));ui.append(button);return button;});
  const back=doc.createElement('button');back.type='button';back.textContent='← Natrag';back.setAttribute('aria-label','Vrati pregled stana');back.hidden=true;back.addEventListener('click',exit);ui.append(back);
  const hint=doc.createElement('p');hint.className='person-view-hint';hint.setAttribute('aria-live','polite');hint.textContent='Klikni osobu za pogled iz prve osobe.';host.append(ui,hint);
  const oldCursor=canvas.style.cursor,oldTabindex=canvas.getAttribute('tabindex');
  let selected=null,saved=null,yaw=0,pitch=0,pointer=null,disposed=false,oldVisible=true;
  function update(){
   if(selected===null||disposed)return;
   const pose=eyePose(walkers[selected],figures[selected].eyeHeight,yaw,pitch);
   group.updateWorldMatrix(true,false);camera.up.set(0,0,1).transformDirection(group.matrixWorld);
   camera.position.copy(group.localToWorld(new THREE.Vector3(...pose.eye)));camera.lookAt(group.localToWorld(new THREE.Vector3(...pose.target)));
  }
  function enter(index){
   if(disposed||selected===index)return;
   stopAutoRotate?.();
   if(selected===null)saved={position:camera.position.clone(),quaternion:camera.quaternion.clone(),up:camera.up.clone(),target:controls.target.clone(),enabled:controls.enabled,fov:camera.fov,near:camera.near};
   else figures[selected].group.visible=oldVisible;
   selected=index;oldVisible=figures[index].group.visible;figures[index].group.visible=false;yaw=0;pitch=0;
   controls.enabled=false;controls.autoRotate=false;camera.fov=75;camera.near=.035;camera.updateProjectionMatrix();
   buttons.forEach((button,i)=>button.setAttribute('aria-pressed',String(i===index)));back.hidden=false;host.dataset.personView=ids[index];
   hint.textContent=`${names[index]} · povuci za pogled oko sebe · Esc za povratak`;canvas.style.cursor='grab';canvas.tabIndex=0;canvas.focus({preventScroll:true});update();render();
  }
  function exit(){
   if(selected===null)return;
   if(pointer&&canvas.hasPointerCapture?.(pointer.id))canvas.releasePointerCapture(pointer.id);pointer=null;
   const previous=selected;figures[selected].group.visible=oldVisible;selected=null;
   camera.position.copy(saved.position);camera.quaternion.copy(saved.quaternion);camera.up.copy(saved.up);camera.fov=saved.fov;camera.near=saved.near;camera.updateProjectionMatrix();
   controls.target.copy(saved.target);controls.enabled=saved.enabled;controls.update();saved=null;
   buttons.forEach(button=>button.setAttribute('aria-pressed','false'));back.hidden=true;host.dataset.personView='overview';hint.textContent='Klikni osobu za pogled iz prve osobe.';canvas.style.cursor=oldCursor;render();
   if(!disposed)buttons[previous].focus({preventScroll:true});
  }
  function pick(event){
   const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return null;
   point.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(point,camera);
   group.updateWorldMatrix(true,true);
   const hit=ray.intersectObjects(figures.map(f=>f.group),true)[0];if(!hit)return null;
   // Opaque apartment walls and slabs occlude the figures; transparent glazing does not.
   const blockers=group.children.filter(child=>child.name?.startsWith('UnitPart:')&&child.name!=='UnitPart:glass');
   const obstruction=ray.intersectObjects(blockers,true)[0];if(obstruction&&obstruction.distance<hit.distance-.01)return null;
   let object=hit.object;while(object){const index=figures.findIndex(f=>f.group===object);if(index!==-1)return index;object=object.parent;}return null;
  }
  function down(event){
   if(event.button!==0||pointer)return;pointer={id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,looking:selected!==null};
   if(pointer.looking){canvas.setPointerCapture(event.pointerId);event.preventDefault();canvas.style.cursor='grabbing';}
  }
  function move(event){
   if(pointer?.id===event.pointerId&&pointer.looking&&selected!==null){yaw-=(event.clientX-pointer.lastX)*.006;pitch=clampPitch(pitch-(event.clientY-pointer.lastY)*.006);pointer.lastX=event.clientX;pointer.lastY=event.clientY;update();render();event.preventDefault();}
   else if(!pointer&&selected===null)canvas.style.cursor=pick(event)!==null?'pointer':oldCursor;
  }
  function up(event){
   if(pointer?.id!==event.pointerId)return;const press=pointer;pointer=null;
   if(canvas.hasPointerCapture?.(event.pointerId))canvas.releasePointerCapture(event.pointerId);
   if(press.looking){canvas.style.cursor='grab';return;}
   if(event.type==='pointerup'&&Math.hypot(event.clientX-press.x,event.clientY-press.y)<=6){const index=pick(event);if(index!==null)enter(index);}
  }
  function key(event){if(event.key==='Escape'&&selected!==null){event.preventDefault();exit();}}
  for(const [type,handler]of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up]])canvas.addEventListener(type,handler);
  doc.addEventListener('keydown',key);host.dataset.personView='overview';
  return {update,dispose(){if(disposed)return;disposed=true;exit();if(pointer&&canvas.hasPointerCapture?.(pointer.id))canvas.releasePointerCapture(pointer.id);pointer=null;
   for(const [type,handler]of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up]])canvas.removeEventListener(type,handler);
   doc.removeEventListener('keydown',key);ui.remove();hint.remove();canvas.style.cursor=oldCursor;if(oldTabindex===null)canvas.removeAttribute('tabindex');else canvas.setAttribute('tabindex',oldTabindex);delete host.dataset.personView;
  }};
 }
 return {mount,eyePose,clampPitch};
});
