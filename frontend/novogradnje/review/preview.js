'use strict';
(async()=>{
 const data=await fetch('drafts.json',{cache:'no-store'}).then(response=>{if(!response.ok)throw new Error('Draft data unavailable');return response.json();});
 const byId=new Map(data.map(d=>[d.unitId,d]));
 const requested=new URLSearchParams(location.search).get('stan'),draft=byId.get(requested)||data[0];
 for(const item of data){const link=document.createElement('a');link.href='?stan='+encodeURIComponent(item.unitId);link.textContent=item.unitId;link.setAttribute('aria-current',String(item.unitId===draft.unitId));document.getElementById('units').append(link);}
 document.title='Draft '+draft.unitId+' · Novogradnje';
 document.getElementById('unit-title').textContent='Apartment '+draft.unitId;
 document.getElementById('unit-info').textContent=(draft.floor===0?'Ground floor':'Floor '+draft.floor)+' · '+draft.architecture.walls.length+' reconstructed wall segments';
 document.getElementById('full-source').href=draft.image;
 document.getElementById('listing').href=draft.listingUrl;
 const note=(id,values)=>{for(const value of values){const li=document.createElement('li');li.textContent=value;document.getElementById(id).append(li);}};
 note('issues',draft.summary);note('all-issues',draft.issues);
 window.NovogradnjeViewer.mountPlan(document.getElementById('plan-view'),draft);
 const [x,y,w,h]=draft.source.framePx,[imageWidth,imageHeight]=draft.source.imagePx;
 const toSourcePoint=point=>[(x+point[0]*w)/imageWidth,(y+point[1]*h)/imageHeight];
 const geometryOverlay={slabs:draft.architecture.slabs.map(poly=>poly.map(ring=>ring.map(toSourcePoint))),walls:draft.architecture.walls.map(poly=>poly.map(ring=>ring.map(toSourcePoint)))};
 const annotationEditor=window.NovogradnjeAnnotationEditor.mount(document.getElementById('annotation-editor'),draft.image,{unitId:draft.unitId,
  sourceSha256:draft.sourceSha256||draft.source.sha256,page:draft.page||draft.source.page||1,draftId:draft.draftId},{geometryOverlay});
 document.getElementById('overlay-toggle').addEventListener('click',event=>{const visible=event.currentTarget.getAttribute('aria-pressed')!=='true';event.currentTarget.setAttribute('aria-pressed',String(visible));annotationEditor.setGeometryVisible(visible);});
 let disposed=false;const dispose=await window.__floorPlanReviewRenderer.preview(document.getElementById('three-view'),THREE=>window.__threeFloorPlans.createLocalUnitGroup(THREE,draft.architecture,window.__buildingFloorPlans),()=>!disposed);
 window.addEventListener('pagehide',()=>{disposed=true;dispose?.();annotationEditor.destroy();},{once:true});
 document.documentElement.dataset.previewReady='true';
})().catch(error=>{const box=document.getElementById('three-view');box.textContent='The preview could not load: '+error.message;console.error(error);});
