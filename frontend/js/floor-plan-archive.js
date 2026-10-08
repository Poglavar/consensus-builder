// Read-only comparison of source images, local architectural geometry and agency coverage.
(function () {
'use strict';
const params=new URLSearchParams(location.search),translations=window.__floorPlanArchiveTranslations;
const lang=translations[(params.get('lang')||'en').slice(0,2)]?(params.get('lang')||'en').slice(0,2):'en';
const tr=key=>translations[lang][key]||translations.en[key]||key,el=id=>document.getElementById(id);
document.documentElement.lang=lang;document.title=tr('title');document.querySelector('[role=tablist]').setAttribute('aria-label',tr('title'));document.querySelectorAll('[data-i18n]').forEach(node=>node.textContent=tr(node.dataset.i18n));
for(const [id,key] of [['agency-search','search'],['source-filter','sourceSearch']]){el(id).placeholder=tr(key);el(id).setAttribute('aria-label',tr(key));}
const backend=(params.get('backend')||location.origin).replace(/\/$/,''),geometry=window.__floorPlanReviewGeometry,renderer=window.__floorPlanReviewRenderer;
let catalogue={buildings:[],sources:[]},building=null,plans=[],agencies=[],mode='2d',map=null;
let selectionGeneration=0,planGeneration=0,buildingGeneration=0,disposePlan=null,disposeBuilding=null,activeTab='buildings';
const selected=()=>plans[Number(el('unit').value)];
async function get(path){const response=await fetch(backend+path,{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();}
function textNode(tag,text,className){const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;}
function safeURL(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u:null;}catch{return null;}}
function sourceLink(url,label){const u=safeURL(url);if(!u)return textNode('span',label);const a=textNode('a',label);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';return a;}
function empty(id,key){el(id).replaceChildren(textNode('p',tr(key),'empty'));}
function status(key){el('status').textContent=tr(key);}
function fail(error){el('status').textContent=`${tr('unavailable')}: ${error.message}`;console.error(error);}
function updateURL(){const next=new URL(location.href);next.searchParams.set('tab',activeTab);next.searchParams.set('building',el('building').value);const plan=selected();if(plan)next.searchParams.set('plan',plan.id||plan.sha256);else next.searchParams.delete('plan');history.replaceState(null,'',next);}
function cards(id,items){el(id).replaceChildren(...items.map(([key,value])=>{const card=document.createElement('div');card.append(textNode('b',value??0),textNode('span',tr(key)));return card;}));}
function stopPlan(){planGeneration++;disposePlan?.();disposePlan=null;}
function stopBuilding(){buildingGeneration++;disposeBuilding?.();disposeBuilding=null;}
function svgElement(tag,attributes){const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,String(value));return node;}
function draw2d(a){
 const [width,depth]=a.dimensionsM,pad=.25;const svg=svgElement('svg',{viewBox:`${-pad} ${-pad} ${width+2*pad} ${depth+2*pad}`,'aria-label':tr('reconstructed'),role:'img'});
 const pathData=rings=>rings.map(ring=>ring.map((p,i)=>`${i?'L':'M'}${p[0]*width} ${p[1]*depth}`).join(' ')+' Z').join(' ');
 for(const rings of a.slabs)svg.append(svgElement('path',{d:pathData(rings),fill:'#e0e9e8','fill-rule':'evenodd'}));
 for(const rings of a.walls)svg.append(svgElement('path',{d:pathData(rings),fill:'#344750','fill-rule':'evenodd'}));
 for(const o of a.openings){svg.append(svgElement('line',{x1:o.a[0]*width,y1:o.a[1]*depth,x2:o.b[0]*width,y2:o.b[1]*depth,stroke:o.kind==='door'?'#c28656':'#43a1c0','stroke-width':.055}));if(o.hinge&&o.openTip)svg.append(svgElement('line',{x1:o.hinge[0]*width,y1:o.hinge[1]*depth,x2:o.openTip[0]*width,y2:o.openTip[1]*depth,stroke:'#a77349','stroke-width':.035}));}
 el('plan').replaceChildren(svg);
}
async function drawPlan(plan){
 stopPlan();const token=planGeneration,a=plan?.architecture;el('view3d').disabled=!a;el('view3d').textContent=tr(mode==='3d'?'view2d':'view3d');
 if(!a){empty('plan','noGeometry');return;}
 try{const errors=window.__buildingFloorPlans.validateArchitecture(a);if(errors.length)throw new Error(errors.join('; '));if(mode==='2d')draw2d(a);else{empty('plan','loading');disposePlan=await renderer.preview(el('plan'),THREE=>window.__threeFloorPlans.createLocalUnitGroup(THREE,a,window.__buildingFloorPlans),()=>token===planGeneration);}}
 catch(error){if(token===planGeneration)el('plan').replaceChildren(textNode('p',`${tr('renderFailed')}: ${error.message}`,'empty'));console.error(error);}
}
function showSource(plan){
 const source=plan.source||{},sha=plan.archivedSha256;const original=safeURL(source.url||plan.sourceUrl),url=sha?`${backend}/floor-plan-archive/asset/${sha}`:original?.href;
 el('source-link').replaceChildren();
 if(original)el('source-link').append(sourceLink(original.href,tr('openDrawing')));
 if(source.listingUrl)el('source-link').append(sourceLink(source.listingUrl,tr('source')));
 if(source.page)el('source-link').append(textNode('span',` · ${tr('page')} ${source.page}`));
 if(!url){empty('asset','noDrawing');return;}
 const pdf=plan.mediaType==='application/pdf'||/\.pdf(?:[?#]|$)/i.test(url);
 if(pdf){const frame=document.createElement('iframe');frame.title=tr('original');frame.src=url+(source.page?`#page=${source.page}`:'');el('asset').replaceChildren(frame);}
 else{const image=document.createElement('img');image.src=url;image.alt=`${tr('original')} · ${plan.label||plan.id||''}`;image.addEventListener('error',()=>{if(el('asset').contains(image))empty('asset','noDrawing');},{once:true});el('asset').replaceChildren(image);}
}
function renderPlan(plan){
 showSource(plan);const rooms=plan.rooms||[];el('plan-details').hidden=!plan.architecture;
 el('rooms').replaceChildren();for(const room of rooms){const row=document.createElement('tr');row.append(textNode('td',room.name),textNode('td',`${room.areaM2??'—'} m²`));el('rooms').append(row);}if(!rooms.length){const row=document.createElement('tr'),cell=textNode('td',tr('noRooms'));cell.colSpan=2;row.append(cell);el('rooms').append(row);}
 el('areas').replaceChildren(textNode('dt',tr('physical')),textNode('dd',`${plan.physicalNetAreaM2??'—'} m²`),textNode('dt',tr('marketed')),textNode('dd',`${plan.areaM2??'—'} m²`));
 el('dimensions').textContent=plan.architecture?`${tr('dimensions')}: ${plan.architecture.dimensionsM.map(v=>v.toFixed(2)).join(' × ')} m`:'';
 const reviewNotes=[...(plan.reviewNotes||[])];
 if(plan.sourceFloorConflict)reviewNotes.unshift(`${tr('conflict')}: ${JSON.stringify(plan.sourceFloorConflict)}`);
 el('conflict').hidden=!reviewNotes.length;el('conflict').textContent=reviewNotes.join(' · ');
 el('processing-note').replaceChildren();
 if(plan.processing){
  el('processing-note').append(textNode('p',tr('interpretedNote')));
  if(plan.verticalDimensionsBasis)el('processing-note').append(textNode('p',plan.verticalDimensionsBasis));
  if(plan.processing.costUsd!==null&&Number.isFinite(Number(plan.processing.costUsd)))el('processing-note').append(textNode('p',`${tr('processingCost')}: $${Number(plan.processing.costUsd).toFixed(4)}`));
 }
 el('geometry-note').textContent=tr(!plan.architecture?'noGeometry':building?.kind==='registered'?'registeredNote':'localNote');
 drawPlan(plan);status(plan.sourceFloorConflict?'conflict':plan.reviewStatus==='needs_review'?'needs_review':'ready');
}
async function choosePlan(){
 const plan=selected(),token=++selectionGeneration;stopPlan();el('asset').replaceChildren();el('plan-details').hidden=true;el('conflict').hidden=true;el('geometry-note').textContent='';el('processing-note').replaceChildren();
 el('previous').disabled=Number(el('unit').value)<=0;el('next').disabled=Number(el('unit').value)>=plans.length-1;
 updateURL();if(!plan){empty('asset','noResults');empty('plan','noResults');return;}
 if(building){renderPlan(plan);return;}
 status('loading');empty('plan','loading');
 try{const source=await get(`/floor-plan-archive/source/${plan.sha256}`);if(token!==selectionGeneration)return;
 const review={...(source.model||{}),id:source.sha256,label:source.label,sourceUrl:source.sourceUrl,reviewStatus:source.status,mediaType:source.mediaType,archivedSha256:source.sha256};
 el('selection-name').textContent=source.label;el('selection-note').textContent=`${tr('sourceOnly')} · ${tr(source.status==='reviewed'?'reviewedStatus':source.status||'unknownStatus')}`;renderPlan(review);
 }catch(error){if(token===selectionGeneration)fail(error);}
}
function renderMap(){
 map?.remove();map=null;el('map').replaceChildren();el('map-note').replaceChildren();
 if(!geometry.locationValid(building?.location)){empty('map','noLocation');return;}
 const {latitude,longitude,basis}=building.location;
 if(!window.L){empty('map','unavailable');}else{
 map=L.map(el('map'),{zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false}).setView([latitude,longitude],17);
 L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
 L.circleMarker([latitude,longitude],{radius:6,color:'#12695e',fillOpacity:1}).addTo(map);
 if(building.footprint){const outline=L.geoJSON(building.footprint,{style:{color:'#147a6a',weight:2,fillOpacity:.17}}).addTo(map);if(outline.getBounds().isValid())map.fitBounds(outline.getBounds().pad(.7),{maxZoom:18,animate:false});}
 }
 el('map-note').append(textNode('span',`${tr(basis==='registered-footprint'?'mapBasis':'landmarkBasis')} · `),sourceLink(`https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=18/${latitude}/${longitude}`,tr('openMap')));
}
async function drawBuilding(){
 stopBuilding();const token=buildingGeneration,current=building;el('show-building').disabled=!current?.wholeBuilding;
 if(!current?.wholeBuilding){empty('building-3d','noWhole');return;}
 empty('building-3d','loading');
 try{
 const data=current.wholeBuilding.type==='landmark'?await get(current.wholeBuilding.url):null;if(token!==buildingGeneration)return;
 disposeBuilding=await renderer.preview(el('building-3d'),THREE=>data?renderer.landmark(THREE,data,current.location):window.__threeFloorPlans.createBuildingGroup(THREE,{type:'Feature',geometry:current.footprint,properties:{floorPlans:current.floorPlans,name:current.name}},geometry.projectAt(current.location),window.__buildingFloorPlans),()=>token===buildingGeneration);
 }catch(error){if(token===buildingGeneration)el('building-3d').replaceChildren(textNode('p',`${tr('renderFailed')}: ${error.message}`,'empty'));console.error(error);}
}
function fillPlans(preferred){
 el('unit').replaceChildren(...plans.map((plan,i)=>{const option=textNode('option',plan.label||plan.id||plan.sha256);option.value=i;return option;}));
 const index=plans.findIndex(p=>(p.id||p.sha256)===preferred);el('unit').value=String(index<0?0:index);el('unit').disabled=!plans.length;choosePlan();
}
function sourcePlans(preferred){
 const query=el('source-filter').value.toLocaleLowerCase();plans=catalogue.sources.filter(s=>`${s.label} ${s.sourceUrl} ${s.status} ${tr(s.status)}`.toLocaleLowerCase().includes(query));fillPlans(preferred);
}
async function chooseBuilding(preferred){
 const id=el('building').value,token=++selectionGeneration;stopPlan();stopBuilding();building=null;plans=[];el('unit').replaceChildren();el('unit').disabled=true;el('plan-details').hidden=true;el('conflict').hidden=true;el('asset').replaceChildren();empty('plan','loading');empty('building-3d','loading');renderMap();status('loading');
 el('source-filter-label').hidden=id!=='archive';el('building-context').hidden=id==='archive';
 if(id==='archive'){el('selection-name').textContent=tr('archive');el('selection-note').textContent=tr('allSources');el('building-note').textContent='';el('show-building').disabled=true;empty('building-3d','noWhole');sourcePlans(preferred);return;}
 try{const result=await get(`/floor-plan-archive/building/${encodeURIComponent(id)}`);if(token!==selectionGeneration)return;building=result;plans=result.plans||[];
 el('selection-name').textContent=result.name;el('selection-note').textContent=`${plans.length} ${tr('planCount')} · ${tr(result.kind==='units'?'unitCollectionNote':'registeredNote')}`;
 el('building-note').textContent=tr(result.wholeBuilding?.type==='landmark'?'exteriorNote':'stackNote');renderMap();fillPlans(preferred);if(activeTab==='buildings')drawBuilding();else empty('building-3d','load3d');
 }catch(error){if(token===selectionGeneration)fail(error);}
}
function renderAgencies(){
 const query=el('agency-search').value.toLocaleLowerCase(),matches=agencies.filter(a=>`${a.legal_name} ${a.registered_address} ${a.website||''}`.toLocaleLowerCase().includes(query));el('agencies').replaceChildren();el('agency-count').textContent=`${matches.length} / ${agencies.length}`;
 for(const agency of matches){const row=document.createElement('tr'),website=document.createElement('td');if(safeURL(agency.website))website.append(sourceLink(agency.website,new URL(agency.website).hostname));else if(agency.candidate_websites?.length){for(const candidate of agency.candidate_websites){if(!safeURL(candidate.url))continue;const lead=document.createElement('p');lead.append(sourceLink(candidate.url,new URL(candidate.url).hostname),textNode('small',` · ${tr('candidate')}`));website.append(lead);}}else website.append(textNode('span',tr('unknown')));row.append(textNode('td',agency.legal_name),textNode('td',agency.registered_address),website);el('agencies').append(row);}
}
function setTab(tab){activeTab=tab;el('status').hidden=tab==='agencies';for(const name of ['buildings','agencies']){const active=name===tab;el(`tab-${name}`).setAttribute('aria-selected',String(active));el(`tab-${name}`).tabIndex=active?0:-1;el(`panel-${name}`).hidden=!active;}if(tab==='buildings'){map?.invalidateSize();if(building&&!disposeBuilding)drawBuilding();}else stopBuilding();updateURL();}
async function init(){
 status('loading');
 try{
 const [result,summary,registry]=await Promise.all([get('/floor-plan-archive/catalogue'),get('/floor-plan-archive/status'),get('/floor-plan-archive/agencies?limit=500')]);catalogue=result;agencies=registry.agencies||[];
 for(const entry of catalogue.buildings){const option=textNode('option',`${entry.name} · ${entry.planCount}`);option.value=entry.id;el('building').append(option);}const archive=textNode('option',`${tr('archive')} · ${catalogue.sources.length}`);archive.value='archive';el('building').append(archive);
 cards('coverage',[['buildings',catalogue.buildings.length],['floors',catalogue.buildings.filter(b=>b.kind==='registered').reduce((s,b)=>s+b.planCount,0)],['units',catalogue.buildings.filter(b=>b.kind==='units').reduce((s,b)=>s+b.planCount,0)],['sources',catalogue.sources.length]]);
 cards('agency-coverage',[['agencies',summary.coverage.agencies.total],['websites',summary.coverage.agencies.websites]]);renderAgencies();
 const preferred=params.get('building');el('building').value=[...el('building').options].some(o=>o.value===preferred)?preferred:catalogue.buildings.find(b=>b.id==='avenue-v')?.id||catalogue.buildings[0]?.id||'archive';
 activeTab=params.get('tab')==='agencies'?'agencies':'buildings';await chooseBuilding(params.get('plan'));setTab(activeTab);
 }catch(error){fail(error);}
}
el('building').addEventListener('change',()=>chooseBuilding());el('unit').addEventListener('change',choosePlan);el('source-filter').addEventListener('input',()=>sourcePlans());el('agency-search').addEventListener('input',renderAgencies);
for(const [id,offset]of [['previous',-1],['next',1]])el(id).addEventListener('click',()=>{el('unit').value=String(Number(el('unit').value)+offset);choosePlan();});
el('view3d').addEventListener('click',()=>{mode=mode==='2d'?'3d':'2d';const plan=selected();if(building)drawPlan(plan);else choosePlan();});el('show-building').addEventListener('click',drawBuilding);
for(const tab of ['buildings','agencies']){el(`tab-${tab}`).addEventListener('click',()=>setTab(tab));el(`tab-${tab}`).addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'buildings':event.key==='End'?'agencies':tab==='buildings'?'agencies':'buildings';setTab(next);el(`tab-${next}`).focus();}});}
window.addEventListener('pagehide',()=>{selectionGeneration++;stopPlan();stopBuilding();map?.remove();});init();
})();
