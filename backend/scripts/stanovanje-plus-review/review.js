/* Private review wiring; architecture geometry is owned by the shared floor-plan modules. */
(async function(){
'use strict';
const $=id=>document.getElementById(id),D=await fetch('/review-data.json').then(r=>{if(!r.ok)throw Error('Review data unavailable');return r.json();});
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ringpath=r=>'M'+r.map(p=>p.join(',')).join('L')+'Z',polypath=p=>p.map(ringpath).join(' ');
const query=new URLSearchParams(location.search);
let current,dispose=null,version=0,mode=query.get('view')==='2d'?'2d':'3d',planBox=null,drag=null;
D.items.forEach((v,i)=>$('choose').add(new Option(v.source.code+' · '+v.source.title,i)));
const initial=D.items.findIndex(item=>item.source.code===query.get('building'));
if(initial>=0)$('choose').value=String(initial);
$('manifest').textContent=JSON.stringify(D.manifest,null,2);
function updateLink(){const url=new URL(location.href);url.searchParams.set('building',current.source.code);if(mode==='2d')url.searchParams.set('view','2d');else url.searchParams.delete('view');history.replaceState(null,'',url);}
function overlay(){ $('source').querySelector('svg')?.toggleAttribute('hidden',!$('overlay').checked); }
function zoomSource(){ $('source').style.width=String(+$('source-zoom').value*100)+'%'; }
async function render3d(){
 const ticket=++version;dispose?.();dispose=null;$('model-3d').replaceChildren();
 if(mode!=='3d'||!current?.model||current.validation.length)return;
 $('render-status').textContent='Loading interactive 3D…';
 try{
  const result=await window.__floorPlanReviewRenderer.preview($('model-3d'),THREE=>window.__threeFloorPlans.createLocalUnitGroup(THREE,current.model.architecture),()=>ticket===version,{enablePan:true,enableZoom:true});
  if(ticket!==version){result?.();return;}dispose=result;
  $('render-status').textContent='Interactive 3D · '+current.revision+' revision · illustrative vertical dimensions';
 }catch(error){if(ticket===version)$('render-status').textContent='3D unavailable: '+error.message+'. The 2D plan remains available.';}
}
function setPlanBox(){if(planBox)$('model-2d').querySelector('svg')?.setAttribute('viewBox',planBox.join(' '));}
function resetPlan(){if(!current?.model)return;const [w,h]=current.model.architecture.dimensionsM;planBox=[-.03*w,-.03*h,w*1.06,h*1.06];setPlanBox();}
function plan(){
 const A=current.model.architecture,[w,h]=A.dimensionsM,metric=p=>[p[0]*w,p[1]*h];
 const parts=A.slabs.map(p=>`<path d="${polypath(p.map(r=>r.map(metric)))}" fill="#e0e8eb" stroke="#d78416" stroke-width=".05" fill-rule="evenodd"/>`).join('')+A.walls.map(p=>`<path d="${polypath(p.map(r=>r.map(metric)))}" fill="#344d61" fill-rule="evenodd"/>`).join('')+A.openings.map(o=>`<path d="M${metric(o.a)}L${metric(o.b)}" stroke="#1589bd" stroke-width=".07"/>`+(o.kind==='door'?`<path d="M${metric(o.hinge)}L${metric(o.openTip)}" stroke="#93603d" stroke-width=".045"/>`:'')).join('');
 const stairs=A.stairs.map(stair=>{
  const a=metric(stair.a),b=metric(stair.b),dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
  if(length<.001)return '';
  const nx=-dy/length*stair.widthM/2,ny=dx/length*stair.widthM/2;
  const edge=(t,side)=>[a[0]+dx*t+nx*side,a[1]+dy*t+ny*side];
  const footprint=[edge(0,1),edge(1,1),edge(1,-1),edge(0,-1)];
  const treads=Array.from({length:stair.steps+1},(_,i)=>`<path d="M${edge(i/stair.steps,1)}L${edge(i/stair.steps,-1)}"/>`).join('');
  return `<g stroke="#77746e" stroke-width=".035"><path d="${ringpath(footprint)}" fill="#c8c3ba"/>${treads}</g>`;
 }).join('');
 $('model-2d').innerHTML=`<svg xmlns="http://www.w3.org/2000/svg" aria-label="Metric 2D floor plan">${parts}${stairs}</svg>`;resetPlan();
 const svg=$('model-2d').firstElementChild;
 svg.addEventListener('wheel',event=>{event.preventDefault();const factor=event.deltaY>0?1.12:1/1.12,cx=planBox[0]+planBox[2]/2,cy=planBox[1]+planBox[3]/2;planBox=[cx-planBox[2]*factor/2,cy-planBox[3]*factor/2,planBox[2]*factor,planBox[3]*factor];setPlanBox();},{passive:false});
 svg.addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY,box:[...planBox]};svg.setPointerCapture(event.pointerId);});
 svg.addEventListener('pointermove',event=>{if(!drag)return;const scale=Math.max(drag.box[2]/svg.clientWidth,drag.box[3]/svg.clientHeight);planBox=[drag.box[0]-(event.clientX-drag.x)*scale,drag.box[1]-(event.clientY-drag.y)*scale,drag.box[2],drag.box[3]];setPlanBox();});
 svg.addEventListener('pointerup',()=>{drag=null;});svg.addEventListener('pointercancel',()=>{drag=null;});
}
function setMode(next){mode=next;updateLink();$('model-3d').hidden=next!=='3d';$('model-2d').hidden=next!=='2d';$('mode-3d').setAttribute('aria-pressed',String(next==='3d'));$('mode-2d').setAttribute('aria-pressed',String(next==='2d'));if(next==='2d')$('render-status').textContent='Metric 2D plan · '+current.revision+' revision';render3d();}
function show(){
 current=D.items[+$('choose').value];updateLink();const {source,model,frame}=current;
 $('metadata').innerHTML=`<h2>${escape(source.title)}</h2><p>${escape(source.author)} · ${escape(source.city)} · <a target="_blank" rel="noreferrer" href="${escape(source.sourceUrl)}">Archive source</a> · ${escape(current.revision)} model</p>`;
 $('download').href=current.download;$('download').hidden=!model;
 $('source').innerHTML=`<img alt="Original archive floor plan" src="${escape(current.image)}">`;
 $('source-zoom').value=1;zoomSource();
 if(!model){$('quality').textContent='No processed model available.';$('issues').textContent='';$('model-2d').replaceChildren();render3d();return;}
 const A=model.architecture,F=model.source.sourceFrame,transform=p=>[F[0]+p[0]*F[2],F[1]+p[1]*F[3]];
 const paths=A.slabs.map(p=>`<path d="${polypath(p.map(r=>r.map(transform)))}" fill="#ff9c0022" stroke="#dc7700" stroke-width=".2" fill-rule="evenodd"/>`).join('')+A.walls.map(p=>`<path d="${polypath(p.map(r=>r.map(transform)))}" fill="#d9000066" fill-rule="evenodd"/>`).join('')+A.openings.map(o=>`<path d="M${transform(o.a)}L${transform(o.b)}" stroke="#008ccf" stroke-width=".3"/>`).join('');
 $('source').insertAdjacentHTML('beforeend',`<svg viewBox="${frame.join(' ')}" preserveAspectRatio="none">${paths}</svg>`);overlay();
 const review=current.manualReview;
 const accepted=review?.verdict==='usable-with-limitations';
 const notes=Array.isArray(review?.limitations)?review.limitations:[];
 const issues=[...new Set([...(model.issues||[]),...current.geometryReviewIssues,...current.validation,...notes])];
 $('quality').textContent=(current.validation.length?'Format invalid — rendering blocked.':accepted?'Visually reviewed: usable with limitations.':'Format-valid draft — usability has not been accepted.')+` ${A.walls.length} wall polygons · ${A.openings.length} openings · ${A.stairs.length} stair flights · ${issues.length} review notes.`;
 $('issues').innerHTML=issues.length?issues.map(x=>'<li>'+escape(x)+'</li>').join(''):'<li>No automatic geometry warnings. Manual source review is still required.</li>';
 $('evidence').textContent=JSON.stringify({dimensionsM:A.dimensionsM,wallHeightM:A.wallHeightM,source:model.source,extraction:model.extraction,manualReview:review,refinementGeometry:current.refinementGeometry},null,2);
 if(!current.validation.length)plan();else $('model-2d').replaceChildren();setMode(mode);
}
$('choose').onchange=show;$('overlay').onchange=overlay;$('source-zoom').oninput=zoomSource;
$('source-reset').onclick=()=>{$('source-zoom').value=1;zoomSource();const host=$('source').parentElement;host.scrollTop=host.scrollLeft=0;};
$('mode-3d').onclick=()=>setMode('3d');$('mode-2d').onclick=()=>setMode('2d');$('reset-model').onclick=()=>mode==='3d'?render3d():resetPlan();
window.addEventListener('pagehide',()=>{version++;dispose?.();});show();
})().catch(error=>{document.getElementById('render-status').textContent=error.message;});
