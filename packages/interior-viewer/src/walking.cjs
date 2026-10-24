// Shared interior rendering, walking and lifecycle support.
 'use strict';
 const WALK_M_PER_S=1.3,TURN_RAD_PER_S=Math.PI*.6,STICK_RADIUS_PX=34;
 const clampPitch=value=>Math.max(-Math.PI*.42,Math.min(Math.PI*.42,value));
 function eyePose(walker,height,yaw=0,pitch=0){
  const angle=walker.heading+yaw,tilt=clampPitch(pitch),horizontal=Math.cos(tilt);
  return {eye:[walker.x,walker.y,height+.01],target:[walker.x+Math.cos(angle)*horizontal,walker.y+Math.sin(angle)*horizontal,height+.01+Math.sin(tilt)]};
 }
 // Held keys as forward/strafe/turn intents in -1..1; unrelated keys return null.
 const KEYS={ArrowUp:['forward',1],KeyW:['forward',1],ArrowDown:['forward',-1],KeyS:['forward',-1],KeyA:['strafe',-1],KeyD:['strafe',1],ArrowLeft:['turn',1],ArrowRight:['turn',-1],KeyQ:['turn',1],KeyE:['turn',-1]};
 function intent(held,stick={forward:0,strafe:0}){
  const sum=axis=>Math.max(-1,Math.min(1,[...held].reduce((value,code)=>value+(KEYS[code]?.[0]===axis?KEYS[code][1]:0),0)+(stick[axis]||0)));
  return {forward:sum('forward'),strafe:sum('strafe'),turn:sum('turn')};
 }
 // World step for a look direction: forward follows the view, strafe is to its right.
 function walkStep(angle,{forward,strafe},distance){
  return [(Math.cos(angle)*forward+Math.sin(angle)*strafe)*distance,(Math.sin(angle)*forward-Math.cos(angle)*strafe)*distance];
 }
 function mount({THREE,group,figures,walkers,camera,controls,renderer,render,animate,host,stopAutoRotate,moveTo,step,coarse,labels={}},env=globalThis){
  const doc=env.document,canvas=renderer.domElement,ray=new THREE.Raycaster(),point=new THREE.Vector2();
  const names=labels.people || ['Person 1','Person 2'],ids=['male','female'];
  const ui=doc.createElement('div');ui.className='person-view-controls';ui.setAttribute('role','group');ui.setAttribute('aria-label',labels.firstPerson || 'First-person view');
  const buttons=figures.map((_,index)=>{const button=doc.createElement('button');button.type='button';button.className='viewer-chip';button.textContent=names[index];button.title=labels.personView?.(names[index]) || `View as ${names[index]}`;button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed','false');button.addEventListener('click',()=>enter(index));ui.append(button);return button;});
  const back=doc.createElement('button');back.type='button';back.className='viewer-chip';back.textContent=labels.back || 'Back';back.setAttribute('aria-label',labels.overview || 'Return to overview');back.hidden=true;back.addEventListener('click',exit);ui.append(back);
  const hint=doc.createElement('p');hint.className='person-view-hint';hint.setAttribute('aria-live','polite');hint.textContent=labels.choosePerson || 'Select a person for first-person view.';
  const stick=doc.createElement('div');stick.className='person-stick';stick.hidden=true;stick.setAttribute('role','application');stick.setAttribute('aria-label',labels.walkStick || 'Walk: drag in the direction of movement');
  const knob=doc.createElement('span');knob.className='person-stick-knob';stick.append(knob);
  host.append(ui,hint,stick);
  const oldTabindex=canvas.getAttribute('tabindex');
  let selected=null,saved=null,yaw=0,pitch=0,pointer=null,disposed=false,oldVisible=true,stickPointer=null,stickVector={forward:0,strafe:0};
  const held=new Set();
  const walkHint=()=>labels.walkHint?.(names[selected],coarse) || `${names[selected]} · Drag to look · ${coarse?'Use the stick':'Arrows or WASD'} to walk · Tap the floor to move · Esc to return`;
  function update(){
   if(selected===null||disposed)return;
   const pose=eyePose(walkers[selected],figures[selected].eyeHeight,yaw,pitch);
   group.updateWorldMatrix(true,false);camera.up.set(0,0,1).transformDirection(group.matrixWorld);
   camera.position.copy(group.localToWorld(new THREE.Vector3(...pose.eye)));camera.lookAt(group.localToWorld(new THREE.Vector3(...pose.target)));
  }
  function enter(index){
   if(disposed||selected===index)return;
   stopAutoRotate?.();
   if(selected===null)saved={position:camera.position.clone(),quaternion:camera.quaternion.clone(),up:camera.up.clone(),target:controls.target.clone(),enabled:controls.enabled,fov:camera.fov,near:camera.near,autoRotate:controls.autoRotate};
   else release(walkers[selected]);
   if(selected!==null)figures[selected].group.visible=oldVisible;
   selected=index;oldVisible=figures[index].group.visible;figures[index].group.visible=false;yaw=0;pitch=0;
   controls.enabled=false;controls.autoRotate=false;camera.fov=75;camera.near=.035;camera.updateProjectionMatrix();
   buttons.forEach((button,i)=>button.setAttribute('aria-pressed',String(i===index)));back.hidden=false;stick.hidden=!coarse;host.dataset.personView=ids[index];
   hint.textContent=walkHint();canvas.tabIndex=0;canvas.focus({preventScroll:true});update();render();
  }
  // Handing a steered person back to the simulation resumes wandering after a short pause.
  function release(walker){if(walker.controlled){walker.controlled=false;walker.path=[];walker.pause=1.5;walker.moving=false;}}
  function exit(){
   if(selected===null)return;
   if(pointer&&canvas.hasPointerCapture?.(pointer.id))canvas.releasePointerCapture(pointer.id);pointer=null;delete host.dataset.personDragging;
   held.clear();resetStick();
   const previous=selected;release(walkers[selected]);figures[selected].group.visible=oldVisible;selected=null;
   camera.position.copy(saved.position);camera.quaternion.copy(saved.quaternion);camera.up.copy(saved.up);camera.fov=saved.fov;camera.near=saved.near;camera.updateProjectionMatrix();
   controls.target.copy(saved.target);controls.enabled=saved.enabled;controls.autoRotate=saved.autoRotate;
   // Synchronize ordinary orbit controls without letting their clamps change a leased camera.
   if(saved.enabled)controls.update();
   camera.position.copy(saved.position);camera.quaternion.copy(saved.quaternion);camera.up.copy(saved.up);controls.target.copy(saved.target);saved=null;
   buttons.forEach(button=>button.setAttribute('aria-pressed','false'));back.hidden=true;stick.hidden=true;host.dataset.personView='overview';hint.textContent=labels.choosePerson || 'Select a person for first-person view.';render();
   if(!disposed)buttons[previous].focus({preventScroll:true});
  }
  const removeWalking=animate({active:()=>selected!==null&&(held.size>0||stickPointer!==null),update(dt){
   const want=intent(held,stickVector);if(!want.forward&&!want.strafe&&!want.turn)return false;
   const walker=walkers[selected];
   yaw+=want.turn*TURN_RAD_PER_S*dt;
   if(want.forward||want.strafe){
    if(!walker.controlled){walker.controlled=true;walker.path=[];}
    const [dx,dy]=walkStep(walker.heading+yaw,want,WALK_M_PER_S*dt*Math.min(1,Math.hypot(want.forward,want.strafe)));
    step(walker,dx,dy);figures[selected].pose(walker);
   }
   update();return true;
  }});
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
  function floorPoint(event){
   const rect=canvas.getBoundingClientRect();point.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(point,camera);group.updateWorldMatrix(true,true);
   const solids=group.children.filter(child=>child.name?.startsWith('UnitPart:')&&child.name!=='UnitPart:glass'),hit=ray.intersectObjects(solids,false)[0];
   if(!hit||hit.object.name!=='UnitPart:slab')return null;const local=group.worldToLocal(hit.point.clone());return [local.x,local.y];
  }
  function down(event){
   if(event.button!==0||pointer)return;pointer={id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,looking:selected!==null};
   if(pointer.looking){canvas.setPointerCapture(event.pointerId);event.preventDefault();host.dataset.personDragging='true';}
  }
  function move(event){
   if(pointer?.id===event.pointerId&&pointer.looking&&selected!==null){yaw-=(event.clientX-pointer.lastX)*.006;pitch=clampPitch(pitch-(event.clientY-pointer.lastY)*.006);pointer.lastX=event.clientX;pointer.lastY=event.clientY;update();render();event.preventDefault();}
  }
  function up(event){
   if(pointer?.id!==event.pointerId)return;const press=pointer;pointer=null;
   if(canvas.hasPointerCapture?.(event.pointerId))canvas.releasePointerCapture(event.pointerId);
   if(press.looking){delete host.dataset.personDragging;if(event.type==='pointerup'&&Math.hypot(event.clientX-press.x,event.clientY-press.y)<=6){const point=floorPoint(event);if(point&&!moveTo(walkers[selected],point))hint.textContent=labels.noRoute || 'No confirmed walkable route to that point.';}return;}
   if(event.type==='pointerup'&&Math.hypot(event.clientX-press.x,event.clientY-press.y)<=6){const index=pick(event);if(index!==null)enter(index);}
  }
  function resetStick(){stickPointer=null;stickVector={forward:0,strafe:0};knob.style.transform='';}
  function stickAt(event){
   const box=stick.getBoundingClientRect(),x=event.clientX-box.left-box.width/2,y=event.clientY-box.top-box.height/2,length=Math.hypot(x,y),scale=length>STICK_RADIUS_PX?STICK_RADIUS_PX/length:1;
   knob.style.transform=`translate(${x*scale}px,${y*scale}px)`;stickVector={forward:-y*scale/STICK_RADIUS_PX,strafe:x*scale/STICK_RADIUS_PX};
  }
  function stickDown(event){if(stickPointer!==null||selected===null)return;event.preventDefault();stickPointer=event.pointerId;stick.setPointerCapture?.(event.pointerId);stickAt(event);render();}
  function stickMove(event){if(event.pointerId===stickPointer){event.preventDefault();stickAt(event);}}
  function stickUp(event){if(event.pointerId!==stickPointer)return;if(stick.hasPointerCapture?.(event.pointerId))stick.releasePointerCapture(event.pointerId);resetStick();}
  function key(event){
   if(selected===null)return;
   if(event.key==='Escape'){event.preventDefault();exit();return;}
   if(event.target!==canvas||event.altKey||event.ctrlKey||event.metaKey||!KEYS[event.code])return;
   event.preventDefault();held.add(event.code);render();
  }
  function keyUp(event){held.delete(event.code);}
  const blur=()=>held.clear();
  for(const [type,handler]of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up]])canvas.addEventListener(type,handler);
  for(const [type,handler]of [['pointerdown',stickDown],['pointermove',stickMove],['pointerup',stickUp],['pointercancel',stickUp]])stick.addEventListener(type,handler);
  doc.addEventListener('keydown',key);doc.addEventListener('keyup',keyUp);canvas.addEventListener('blur',blur);host.dataset.personView='overview';
  return {update,enter,exit,active:()=>selected!==null,dispose(){if(disposed)return;disposed=true;exit();removeWalking();if(pointer&&canvas.hasPointerCapture?.(pointer.id))canvas.releasePointerCapture(pointer.id);pointer=null;
   for(const [type,handler]of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',up]])canvas.removeEventListener(type,handler);
   doc.removeEventListener('keydown',key);doc.removeEventListener('keyup',keyUp);canvas.removeEventListener('blur',blur);ui.remove();hint.remove();stick.remove();
   if(oldTabindex===null)canvas.removeAttribute('tabindex');else canvas.setAttribute('tabindex',oldTabindex);delete host.dataset.personView;delete host.dataset.personDragging;
  }};
 }
 module.exports = {mount,eyePose,clampPitch,intent,walkStep};
