// Read-only comparison of source images, local architectural geometry and agency coverage.
(function () {
'use strict';
const params=new URLSearchParams(location.search),lang=(params.get('lang')||'en').slice(0,2);
const translations={
 en:{eyebrow:'Agency floor-plan archive',title:'Avenue V · floor-plan review',lede:'Five published apartments. Compare the source drawing with reconstructed walls and openings. The building has 74 homes; these plans do not cover the whole building.',unit:'Apartment',view3d:'3D view',view2d:'2D view',original:'Source plan',reconstructed:'Local reconstruction',localNote:'Metric scale comes from each drawing. Wall, window and door heights are estimated. Placement within the building remains unresolved.',rooms:'Rooms as published',room:'Room',area:'Area',areas:'Areas and dimensions',loading:'Loading…',none:'No reviewed models found.',reviewed:'Reviewed local geometry · building placement unresolved',conflict:'Conflicting floor labels in source',physical:'Physical net area',marketed:'Marketed weighted area',agencies:'Registered agencies',websites:'Verified agency websites',models:'Apartment models',sources:'Archived source files',source:'Open agency listing',unavailable:'Archive unavailable',dimensions:'Drawing dimensions',registry:'Registered agencies and verified websites',registryNote:'Official HGK registry, City of Zagreb settlements. A blank website means unresolved; it does not mean the agency has no website.',agency:'Agency',address:'Registered address',website:'Website',candidate:'Candidate, unverified',search:'Search agencies',unknown:'Unresolved',floor:'Floor',renderFailed:'3D preview failed'},
 hr:{eyebrow:'Arhiva agencijskih tlocrta',title:'Avenue V · pregled tlocrta',lede:'Pet objavljenih stanova. Usporedite izvorni nacrt s rekonstruiranim zidovima i otvorima. Zgrada ima 74 stana; ovi tlocrti ne obuhvaćaju cijelu zgradu.',unit:'Stan',view3d:'3D prikaz',view2d:'2D prikaz',original:'Izvorni tlocrt',reconstructed:'Lokalna rekonstrukcija',localNote:'Mjerilo je preuzeto s nacrta. Visine zidova, prozora i vrata su procijenjene. Položaj u zgradi još nije potvrđen.',rooms:'Objavljene prostorije',room:'Prostorija',area:'Površina',areas:'Površine i dimenzije',loading:'Učitavanje…',none:'Nema pregledanih modela.',reviewed:'Pregledana lokalna geometrija · položaj u zgradi nepotvrđen',conflict:'Proturječne oznake kata u izvoru',physical:'Fizička neto površina',marketed:'Oglašena obračunska površina',agencies:'Registrirane agencije',websites:'Potvrđene mrežne stranice',models:'Modeli stanova',sources:'Arhivirane izvorne datoteke',source:'Otvori oglas agencije',unavailable:'Arhiva nije dostupna',dimensions:'Dimenzije nacrta',registry:'Registrirane agencije i potvrđene stranice',registryNote:'Službeni registar HGK-a, naselja Grada Zagreba. Prazno polje stranice znači da nije potvrđena, a ne da je agencija nema.',agency:'Agencija',address:'Adresa sjedišta',website:'Mrežna stranica',candidate:'Kandidat, nepotvrđeno',search:'Pretraži agencije',unknown:'Nepotvrđeno',floor:'Kat',renderFailed:'3D prikaz nije uspio'},
 es:{eyebrow:'Archivo de planos de agencias',title:'Avenue V · revisión de planos',lede:'Cinco apartamentos publicados. Compare el plano original con los muros y huecos reconstruidos. El edificio tiene 74 viviendas; estos planos no cubren todo el edificio.',unit:'Apartamento',view3d:'Vista 3D',view2d:'Vista 2D',original:'Plano original',reconstructed:'Reconstrucción local',localNote:'La escala procede del plano. Las alturas de muros, puertas y ventanas son estimadas. La ubicación dentro del edificio sigue sin verificarse.',rooms:'Habitaciones publicadas',room:'Habitación',area:'Superficie',areas:'Superficies y dimensiones',loading:'Cargando…',none:'No hay modelos revisados.',reviewed:'Geometría local revisada · ubicación pendiente',conflict:'Plantas contradictorias en el original',physical:'Superficie neta física',marketed:'Superficie comercial ponderada',agencies:'Agencias registradas',websites:'Sitios verificados',models:'Modelos de apartamentos',sources:'Archivos originales guardados',source:'Abrir anuncio de la agencia',unavailable:'Archivo no disponible',dimensions:'Dimensiones del plano',registry:'Agencias registradas y sitios verificados',registryNote:'Registro oficial HGK, localidades de la Ciudad de Zagreb. Un sitio vacío significa sin verificar; no significa que no exista.',agency:'Agencia',address:'Dirección registrada',website:'Sitio web',candidate:'Candidato sin verificar',search:'Buscar agencias',unknown:'Sin verificar',floor:'Planta',renderFailed:'Falló la vista 3D'},
 sr:{eyebrow:'Arhiva agencijskih tlocrta',title:'Avenue V · pregled tlocrta',lede:'Pet objavljenih stanova. Uporedite izvorni nacrt sa rekonstruisanim zidovima i otvorima. Zgrada ima 74 stana; ovi tlocrti ne obuhvataju celu zgradu.',unit:'Stan',view3d:'3D prikaz',view2d:'2D prikaz',original:'Izvorni tlocrt',reconstructed:'Lokalna rekonstrukcija',localNote:'Razmera je preuzeta sa nacrta. Visine zidova, prozora i vrata su procenjene. Položaj u zgradi još nije potvrđen.',rooms:'Objavljene prostorije',room:'Prostorija',area:'Površina',areas:'Površine i dimenzije',loading:'Učitavanje…',none:'Nema pregledanih modela.',reviewed:'Pregledana lokalna geometrija · položaj u zgradi nepotvrđen',conflict:'Protivrečne oznake sprata u izvoru',physical:'Fizička neto površina',marketed:'Oglašena obračunska površina',agencies:'Registrovane agencije',websites:'Potvrđene veb stranice',models:'Modeli stanova',sources:'Arhivirane izvorne datoteke',source:'Otvori oglas agencije',unavailable:'Arhiva nije dostupna',dimensions:'Dimenzije nacrta',registry:'Registrovane agencije i potvrđene stranice',registryNote:'Zvanični registar HGK-a, naselja Grada Zagreba. Prazno polje stranice znači da nije potvrđena, a ne da je agencija nema.',agency:'Agencija',address:'Adresa sedišta',website:'Veb stranica',candidate:'Kandidat, nepotvrđeno',search:'Pretraži agencije',unknown:'Nepotvrđeno',floor:'Sprat',renderFailed:'3D prikaz nije uspeo'}
};
const tr=key=>translations[lang]?.[key]||translations.en[key],el=id=>document.getElementById(id);
document.documentElement.lang=translations[lang]?lang:'en';
document.querySelectorAll('[data-i18n]').forEach(node=>{node.textContent=tr(node.dataset.i18n);});
el('agency-search').placeholder=tr('search');el('agency-search').setAttribute('aria-label',tr('search'));
const backend=(params.get('backend')||location.origin).replace(/\/$/,'');
let models=[],agencies=[],mode='2d',dispose3d=null,generation=0;
const selected=()=>models[Number(el('unit').value)]?.model;
async function get(path){const response=await fetch(backend+path,{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();}
function textNode(tag,text){const node=document.createElement(tag);node.textContent=text;return node;}
function sourceLink(url,label){const a=textNode('a',label);const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))throw new Error('Invalid source URL');a.href=parsed.href;a.target='_blank';a.rel='noopener noreferrer';return a;}
function svgElement(tag,attributes){const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));return node;}
function draw2d(model){
 const a=model.architecture,[width,depth]=a.dimensionsM,pad=.25;
 const svg=svgElement('svg',{viewBox:`${-pad} ${-pad} ${width+2*pad} ${depth+2*pad}`,'aria-label':tr('reconstructed'),role:'img'});
 const pathData=rings=>rings.map(ring=>ring.map((p,i)=>`${i?'L':'M'}${p[0]*width} ${p[1]*depth}`).join(' ')+' Z').join(' ');
 for(const rings of a.slabs)svg.append(svgElement('path',{d:pathData(rings),fill:'#e4e9eb','fill-rule':'evenodd'}));
 for(const rings of a.walls)svg.append(svgElement('path',{d:pathData(rings),fill:'#344750','fill-rule':'evenodd'}));
 for(const o of a.openings){svg.append(svgElement('line',{x1:o.a[0]*width,y1:o.a[1]*depth,x2:o.b[0]*width,y2:o.b[1]*depth,stroke:o.kind==='door'?'#c28656':'#43a1c0','stroke-width':.055}));if(o.hinge&&o.openTip)svg.append(svgElement('line',{x1:o.hinge[0]*width,y1:o.hinge[1]*depth,x2:o.openTip[0]*width,y2:o.openTip[1]*depth,stroke:'#a77349','stroke-width':.035}));}
 el('plan').replaceChildren(svg);
}
async function draw3d(model,token){
 const [THREE,{OrbitControls}]=await Promise.all([import('three'),import('three/addons/controls/OrbitControls.js')]);
 if(token!==generation)return;
 const host=el('plan'),a=model.architecture,[width,depth]=a.dimensionsM;
 const scene=new THREE.Scene();scene.background=new THREE.Color('#f8fafb');
 const camera=new THREE.PerspectiveCamera(40,1,.05,500);camera.up.set(0,0,1);
 const extent=Math.max(width,depth);camera.position.set(width/2+extent*.9,depth/2-extent*1.2,extent*1.3);
 const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
 host.replaceChildren(renderer.domElement);
 const group=window.__threeFloorPlans.createLocalUnitGroup(THREE,a,window.__buildingFloorPlans);scene.add(group);
 scene.add(new THREE.HemisphereLight(0xffffff,0x697b83,2.5));const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(-10,-10,25);scene.add(light);
 const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(width/2,depth/2,.7);controls.enableDamping=false;controls.update();
 const render=()=>renderer.render(scene,camera);controls.addEventListener('change',render);
 const resize=()=>{const w=host.clientWidth,h=host.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();render();};
 const observer=new ResizeObserver(resize);observer.observe(host);resize();
 dispose3d=()=>{observer.disconnect();controls.dispose();window.__threeFloorPlans.disposeGroup(group);renderer.dispose();};
}
async function draw(){
 const token=++generation;if(dispose3d){dispose3d();dispose3d=null;}
 const model=selected();if(!model)return;
 el('view3d').textContent=tr(mode==='3d'?'view2d':'view3d');
 try{if(mode==='3d')await draw3d(model,token);else draw2d(model);}catch(error){if(token===generation)el('plan').textContent=`${tr('renderFailed')}: ${error.message}`;console.error(error);}
}
function render(){
 const model=selected();if(!model)return;
 const errors=window.__buildingFloorPlans.validateArchitecture(model.architecture);if(errors.length)throw new Error(errors.join('; '));
 const image=document.createElement('img');image.src=`${backend}/floor-plan-archive/asset/${encodeURIComponent(model.source.sha256)}`;image.alt=`${tr('original')} ${model.unitId}`;el('asset').replaceChildren(image);
 el('source-link').replaceChildren(sourceLink(model.source.listingUrl,tr('source')));
 el('rooms').replaceChildren();for(const room of model.rooms){const row=document.createElement('tr');row.append(textNode('td',room.name),textNode('td',`${room.areaM2??'—'} m²`));el('rooms').append(row);}
 el('areas').replaceChildren(textNode('dt',tr('physical')),textNode('dd',`${model.physicalNetAreaM2??'—'} m²`),textNode('dt',tr('marketed')),textNode('dd',`${model.areaM2??'—'} m²`));
 el('dimensions').textContent=`${tr('dimensions')}: ${model.architecture.dimensionsM.map(v=>v.toFixed(2)).join(' × ')} m`;
 el('status').textContent=tr(model.sourceFloorConflict?'conflict':'reviewed');el('conflict').hidden=!model.sourceFloorConflict;
 el('conflict').textContent=model.sourceFloorConflict?`${tr('conflict')}: ${JSON.stringify(model.sourceFloorConflict)}`:'';
 draw();
}
function renderAgencies(){
 const search=el('agency-search').value.toLocaleLowerCase();el('agencies').replaceChildren();
 for(const agency of agencies.filter(a=>`${a.legal_name} ${a.registered_address}`.toLocaleLowerCase().includes(search))){const row=document.createElement('tr'),website=document.createElement('td');if(agency.website) website.append(sourceLink(agency.website,new URL(agency.website).hostname)); else if(agency.candidate_websites?.length) {for(const candidate of agency.candidate_websites){const lead=document.createElement('p');lead.append(sourceLink(candidate.url,new URL(candidate.url).hostname),textNode('small',` · ${tr('candidate')}`));website.append(lead);}} else website.append(textNode('span',tr('unknown')));row.append(textNode('td',agency.legal_name),textNode('td',agency.registered_address),website);el('agencies').append(row);}
}
async function init(){
 el('status').textContent=tr('loading');
 try{
 const [status,result,registry]=await Promise.all([get('/floor-plan-archive/status'),get('/floor-plan-archive/models?building=avenue-v'),get('/floor-plan-archive/agencies?limit=500')]);
 models=result.models||[];agencies=registry.agencies||[];
 for(const [i,entry] of models.entries()){const option=textNode('option',`${entry.model.unitId} · ${tr('floor')} ${entry.model.floor??'?'}`);option.value=i;el('unit').append(option);}
 const coverage=status.coverage,cards=[['agencies',coverage.agencies.total],['websites',coverage.agencies.websites],['models',models.length],['sources',(coverage.extraction||[]).reduce((sum,row)=>sum+row.count,0)]];
 for(const [key,value] of cards){const card=document.createElement('div');card.append(textNode('b',value),textNode('span',tr(key)));el('coverage').append(card);}
 renderAgencies();if(models.length)render();else el('status').textContent=tr('none');
 }catch(error){el('status').textContent=`${tr('unavailable')}: ${error.message}`;console.error(error);}
}
el('unit').addEventListener('change',render);el('agency-search').addEventListener('input',renderAgencies);
el('view3d').addEventListener('click',()=>{mode=mode==='2d'?'3d':'2d';draw();});
window.addEventListener('pagehide',()=>{generation++;dispose3d?.();});init();
})();
