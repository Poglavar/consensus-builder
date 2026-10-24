// Shared interior rendering, walking and lifecycle support.
 'use strict';
 const PLANK_TILE_M=1.44,SKY_RADIUS_M=240;
 const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
 const hex=value=>[(value>>16&255)/255,(value>>8&255)/255,(value&255)/255];
 const clamp01=value=>Math.max(0,Math.min(1,value));
 // Sky stops (sRGB) for a sun altitude in radians: night, twilight glow and clear day.
 function skyPalette(altitude){
  const day=clamp01((altitude+.05)/.35),dusk=clamp01(1-Math.abs(altitude-.03)/.16);
  const night={zenith:hex(0x0d1626),horizon:hex(0x22324a),ground:hex(0x15191d)};
  const noon={zenith:hex(0x5e95d4),horizon:hex(0xd6e6f2),ground:hex(0x8f9a8c)};
  const glow=hex(0xffb36b);
  return {zenith:mix(night.zenith,noon.zenith,day),horizon:mix(mix(night.horizon,noon.horizon,day),glow,dusk*.55),
   ground:mix(night.ground,noon.ground,day),sun:mix(hex(0xff9a4d),hex(0xfff6e0),day),sunStrength:altitude>-.04?.35+.65*day:0};
 }
 // Colour of the dome at a view elevation (z of the unit direction) and closeness to the sun (dot product).
 function skyColor(palette,elevation,sunDot){
  const base=elevation>=0?mix(palette.horizon,palette.zenith,Math.sqrt(clamp01(elevation))):mix(palette.horizon,palette.ground,clamp01(-elevation*7));
  const halo=palette.sunStrength*(Math.pow(clamp01(sunDot),48)*.9+Math.pow(clamp01(sunDot),6)*.18);
  return base.map((v,i)=>clamp01(v+(palette.sun[i]-v)*clamp01(halo)));
 }
 // Seeded oak planks across one repeating texture tile: rows of 18 cm boards with staggered joints and varied
 // tone. Each row is periodic (its joints repeat every tile), so neighbouring tiles meet without seams.
 function plankLayout(seed=7,rows=8){
  let state=seed>>>0;const random=()=>{state=(state*1664525+1013904223)>>>0;return state/4294967296;};
  const planks=[];
  for(let row=0;row<rows;row++){
   const offset=random();let x=offset;
   while(x<offset+1-1e-9){
    let width=.5+random()*.5;if(x+width>offset+1-.25)width=offset+1-x;
    planks.push({x,y:row/rows,width,height:1/rows,tone:random()*2-1,grain:random()});x+=width;
   }
  }
  return planks;
 }
 function woodTexture(THREE,doc,base,anisotropy){
  const size=512,canvas=doc.createElement('canvas');canvas.width=canvas.height=size;
  const ctx=canvas.getContext('2d'),colour=new THREE.Color(base),hsl={};colour.getHSL(hsl,THREE.SRGBColorSpace);
  const shade=(tone,light=0)=>`hsl(${Math.round(hsl.h*360)} ${Math.round(hsl.s*100)}% ${Math.round(clamp01(hsl.l+tone*.045+light)*100)}%)`;
  for(const plank of plankLayout()){
   for(const dx of [0,-1]){
    const x=(plank.x+dx)*size,y=plank.y*size,w=plank.width*size,h=plank.height*size;
    ctx.fillStyle=shade(plank.tone);ctx.fillRect(x,y,w,h);
    ctx.strokeStyle=shade(plank.tone,-.05);ctx.globalAlpha=.35;ctx.lineWidth=1;
    for(let line=0;line<5;line++){const gy=y+h*(.15+.17*line+plank.grain*.08);ctx.beginPath();ctx.moveTo(x,gy);ctx.bezierCurveTo(x+w*.3,gy+2,x+w*.6,gy-2,x+w,gy+1);ctx.stroke();}
    ctx.globalAlpha=1;ctx.fillStyle=shade(0,-.18);ctx.fillRect(x,y,w,1.5);ctx.fillRect(x+w-1.5,y,1.5,h);
   }
  }
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=anisotropy;
  return texture;
 }
 // Planar floor coordinates in metres per tile, so boards keep their real size in every apartment.
 function planarUv(THREE,geometry,tile){
  const position=geometry.attributes.position,uv=new Float32Array(position.count*2);
  for(let i=0;i<position.count;i++){uv[i*2]=position.getX(i)/tile;uv[i*2+1]=position.getY(i)/tile;}
  geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));
 }
 function buildSky(THREE){
  const geometry=new THREE.SphereGeometry(SKY_RADIUS_M,48,24).rotateX(Math.PI/2);
  const count=geometry.attributes.position.count,colors=new Float32Array(count*3),directions=new Float32Array(count*3);
  for(let i=0;i<count;i++){const v=new THREE.Vector3().fromBufferAttribute(geometry.attributes.position,i).normalize();directions.set([v.x,v.y,v.z],i*3);}
  geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
  const material=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.BackSide,depthWrite:false,fog:false});
  const mesh=new THREE.Mesh(geometry,material);mesh.name='ApartmentSky';mesh.renderOrder=-1;mesh.frustumCulled=false;mesh.visible=false;
  const linear=new THREE.Color();
  function paint(direction,altitude){
   const palette=skyPalette(altitude);
   for(let i=0;i<count;i++){
    const [x,y,z]=[directions[i*3],directions[i*3+1],directions[i*3+2]];
    const [r,g,b]=skyColor(palette,z,x*direction.x+y*direction.y+z*direction.z);
    linear.setRGB(r,g,b,THREE.SRGBColorSpace);colors.set([linear.r,linear.g,linear.b],i*3);
   }
   geometry.attributes.color.needsUpdate=true;
  }
  return {mesh,paint,dispose(){geometry.dispose();material.dispose();}};
 }
 function mount({THREE,scene,group,renderer,render,updateShadows},{host,RoomEnvironment,ownScene=false},env=globalThis){
  const old={toneMapping:renderer.toneMapping,exposure:renderer.toneMappingExposure,environment:scene.environment,intensity:scene.environmentIntensity};
  let environment=null;
  if(ownScene){renderer.toneMapping=THREE.NeutralToneMapping;renderer.toneMappingExposure=1.2;}
  if(ownScene && RoomEnvironment){const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();environment=pmrem.fromScene(room,.04);
  room.dispose?.();pmrem.dispose();scene.environment=environment.texture;scene.environmentIntensity=.9;}
  const css=env.getComputedStyle(host),read=name=>css.getPropertyValue(name).trim();
  const wood=woodTexture(THREE,env.document,read('--model-floor')||'#c9a47c',Math.min(8,renderer.capabilities.getMaxAnisotropy()));
  const parts=[],replaced=[];
  group.traverse(mesh=>{if(mesh.isMesh&&mesh.name?.startsWith('UnitPart:'))parts.push(mesh);});
  for(const mesh of parts){
   const kind=mesh.name.slice('UnitPart:'.length),old=mesh.material,metal=kind==='frame'||kind==='railing';
   const material=new THREE.MeshStandardMaterial({color:old.color.clone(),roughness:kind==='glass'?.05:metal?.45:kind==='door'?.6:.9,metalness:metal?.3:0,
    transparent:old.transparent,opacity:kind==='glass'?.28:old.opacity,depthWrite:old.depthWrite,side:old.side,envMapIntensity:kind==='glass'?1.4:1});
   if(kind==='slab'){planarUv(THREE,mesh.geometry,PLANK_TILE_M);material.map=wood;material.color.set(0xffffff);}
   mesh.material=material;replaced.push({mesh,old,material});
  }
  const sky=buildSky(THREE);group.add(sky.mesh);let disposed=false;
  updateShadows?.();render();
  return {
   setSun({direction,altitude,daylight}){sky.paint(direction,altitude);if(ownScene)scene.environmentIntensity=.15+.75*daylight;},
   setPersonView(active){sky.mesh.visible=active;},
   dispose(){if(disposed)return;disposed=true;group.remove(sky.mesh);sky.dispose();wood.dispose();for(const {mesh,old,material} of replaced){if(mesh.material===material)mesh.material=old;material.dispose();}if(ownScene){scene.environment=old.environment;scene.environmentIntensity=old.intensity;environment?.dispose();renderer.toneMapping=old.toneMapping;renderer.toneMappingExposure=old.exposure;}}
  };
 }
 module.exports = {mount,skyPalette,skyColor,plankLayout,PLANK_TILE_M};
