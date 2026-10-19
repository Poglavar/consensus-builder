// Croatian catalogue UI: shareable filters, project cards, map pins and apartment detail routes.
(function () {
    'use strict';
    const text = {
        kinds:{new_build:'Novogradnja',existing:'Starogradnja',unknown:'Vrsta nije utvrđena'},
        rooms:n=>`${n} ${n===1?'soba':n>=2&&n<=4?'sobe':'soba'}`,
        orientations:{N:'Sjever',NE:'Sjeveroistok',E:'Istok',SE:'Jugoistok',S:'Jug',SW:'Jugozapad',W:'Zapad',NW:'Sjeverozapad'},
        noAddress:'Lokacija nije navedena',plans:n=>`${n} ${n===1?'tlocrt':n>=2&&n<=4?'tlocrta':'tlocrta'}`,
        project:n=>`${n} ${n===1?'stan':n>=2&&n<=4?'stana':'stanova'}`,
        year:p=>Number.isFinite(p.constructionYear)?`Godina izgradnje ${p.constructionYear}`:Number.isFinite(p.completionYear)?`Planirani završetak ${p.completionYear}`:'Godina nije navedena'
    };
    const C=window.NovogradnjeCatalogue, V=window.NovogradnjeViewer;
    const byId=id=>document.getElementById(id), node=(tag,cls,content)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(content!==undefined)n.textContent=content;return n;};
    const safePath=(value,fallback)=>typeof value==='string'&&value.startsWith('/novogradnje/')?value:fallback;
    const safeHref=value=>{if(typeof value!=='string'||!value.trim())return null;if(value.startsWith('/'))return value;try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}};
    const projectPath=p=>safePath(p.url,`/novogradnje/zgrada/${encodeURIComponent(p.slug||p.id)}/`);
    const apartmentPath=(p,a)=>safePath(a.url,`${projectPath(p).replace(/\/$/,'')}/stan/${encodeURIComponent(a.id)}/`);
    let boot={},catalogue={projects:[],counts:{}},detail=null,activeApartmentId=null,map=null,markerLayer=null,viewers=[],catalogueError='',detailError='';
    try { const raw=byId('novogradnje-boot').textContent.trim(); if(raw&&raw!=='__NOVOGRADNJE_BOOT__')boot=JSON.parse(raw); } catch { /* A missing server payload falls through to the public API. */ }
    if(boot.project){document.body.classList.add('detail-page');}
    const initial=C.decodeFilters(location.search);
    function controls(filters){byId('q').value=filters.q;byId('kind').value=filters.kind;byId('minArea').value=filters.minArea??'';byId('maxArea').value=filters.maxArea??'';byId('rooms').value=filters.rooms??'';byId('orientation').value=filters.orientation;byId('clear-search').hidden=!filters.q;}
    function readControls(){return C.normalizeFilters({q:byId('q').value,kind:byId('kind').value,minArea:byId('minArea').value,maxArea:byId('maxArea').value,rooms:byId('rooms').value,orientation:byId('orientation').value});}
    function updateURL(push=false){const url=new URL(location.href);for(const key of ['q','kind','min','max','rooms','orientation'])url.searchParams.delete(key);const encoded=C.encodeFilters(readControls());for(const [k,v] of new URLSearchParams(encoded))url.searchParams.set(k,v);if(url.href!==location.href)history[push?'pushState':'replaceState']({},'',url);}
    function areaLabel(value){return `${new Intl.NumberFormat('hr-HR',{maximumFractionDigits:2}).format(value)} m²`;}
    function apartmentAreas(a){
        const advertised=Number.isFinite(a.marketedAreaM2)?a.marketedAreaM2:Number.isFinite(a.areaM2)?a.areaM2:null;
        const physical=Number.isFinite(a.physicalNetAreaM2)?a.physicalNetAreaM2:null;
        return {advertised,physical};
    }
    function apartmentFacts(a){
        const {advertised,physical}=apartmentAreas(a),bits=[];
        bits.push(advertised===null?'Oglasna površina nije navedena':`Oglasna površina ${areaLabel(advertised)}`);
        if(physical!==null&&physical!==advertised)bits.push(`Neto površina tlocrta ${areaLabel(physical)}`);
        else if(physical===null)bits.push('Neto površina tlocrta nije utvrđena');
        if(Number.isFinite(a.rooms))bits.push(text.rooms(a.rooms));
        if(Number.isFinite(a.floor))bits.push(`${a.floor}. kat`);
        if(Array.isArray(a.orientation)&&a.orientation.length)bits.push(a.orientation.map(o=>text.orientations[o]||o).join(' / '));
        return bits;
    }
    function makeCard(project){
        const article=node('article','project-card'),link=node('a','card-link');link.href=projectPath(project);link.setAttribute('aria-label',`${project.name||project.label||'Projekt'} — otvori projekt`);
        const visual=node('div','card-visual'),tag=project.kind==='new_build'?null:node('span','building-tag',text.kinds[project.kind]||text.kinds.unknown),thumbnail=safePath(project.thumbnailUrl,null);
        if(thumbnail){const image=node('img','building-thumbnail');image.src=thumbnail;image.alt=`3D obris zgrade ${project.name||project.label||''}`;image.width=320;image.height=180;image.loading='lazy';image.decoding='async';visual.append(image);}
        else visual.append(node('span','thumbnail-unavailable','3D obris još nije dostupan'));
        if(tag)visual.append(tag);const body=node('div','card-body'),title=node('h3','card-title',project.name||project.label||project.slug||'Stambeni projekt'),address=node('p','card-address',project.address||text.noAddress);body.append(title,address);
        const chips=node('div','card-chips');chips.append(node('span','chip',text.year(project)));if(project.kind==='new_build')chips.append(node('span','chip amber','Novogradnja'));if(project.kind==='unknown')chips.append(node('span','chip','Vrsta nije utvrđena'));
        const facts=node('div','card-count'),count=node('strong','',(project.apartments||[]).length?text.project(project.apartments.length):'Broj stanova nije naveden'),planCount=node('span','',text.plans(project.planCount||0));facts.append(count,planCount);body.append(chips,facts);link.append(visual,body);article.append(link);
        const pills=node('div','plan-pills');(project.apartments||[]).slice(0,4).forEach(apartment=>{if(!apartment.hasPlan)return;const a=node('a','plan-pill',apartment.label||'Tlocrt stana');a.href=apartmentPath(project,apartment);a.addEventListener('click',ev=>ev.stopPropagation());pills.append(a);});if(pills.childNodes.length)article.append(pills);
        return article;
    }
    function renderMap(projects){
        const host=byId('project-map');if(!window.L){host.textContent='Karta nije dostupna.';return;}if(!map){map=window.L.map(host,{zoomControl:true,scrollWheelZoom:false}).setView([45.815,15.982],11);window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);markerLayer=window.L.layerGroup().addTo(map);}markerLayer.clearLayers();
        const points=[];for(const p of projects){const loc=p.location;if(!loc||!Number.isFinite(loc.lat)||!Number.isFinite(loc.lng))continue;const marker=window.L.marker([loc.lat,loc.lng]).addTo(markerLayer);const a=document.createElement('a');a.href=projectPath(p);a.textContent=p.name||p.label||'Stambeni projekt';const div=document.createElement('div');div.append(a);marker.bindPopup(div);points.push([loc.lat,loc.lng]);}
        if(points.length)map.fitBounds(points,{padding:[24,24],maxZoom:14});
    }
    function renderResults(){
        const host=byId('results');host.replaceChildren();byId('catalogue-error').hidden=!catalogueError;byId('catalogue-error').textContent=catalogueError;
        const filtered=catalogueError?[]:C.filterProjects(catalogue.projects,readControls());
        filtered.forEach(project=>host.append(makeCard(project)));const apartments=filtered.reduce((sum,p)=>sum+p.apartments.length,0);
        byId('catalogue-count').textContent=catalogueError?'':`${apartments} ${apartments===1?'stan':apartments>=2&&apartments<=4?'stana':'stanova'} · ${filtered.length} ${filtered.length===1?'projekt':'projekata'}`;
        byId('result-summary').textContent=catalogueError?'':`${filtered.length} projekata`;byId('empty-state').hidden=filtered.length>0||Boolean(catalogueError);
        if(!document.body.classList.contains('detail-page'))renderMap(filtered);
    }
    function clearViewers(){viewers.forEach(v=>v.dispose());viewers=[];}
    function addSourceLink(host,href,label){const safe=safeHref(href);if(!safe)return;const a=node('a','source-link',label);a.href=safe;if(/^https?:/.test(safe)){a.target='_blank';a.rel='noopener noreferrer';}host.append(a);}
    function addOriginal(host,source){
        const href=safeHref(source?.assetUrl);if(!href)return;
        const type=String(source.mediaType||'').toLowerCase(),pdf=type==='application/pdf'||/\.pdf(?:[?#]|$)/i.test(href),viewer=node('div','original-preview');
        if(pdf){const frame=node('iframe');frame.title='Izvorni tlocrt u PDF-u';frame.src=href;viewer.append(frame);}
        else {const image=node('img');image.src=href;image.alt='Izvorna slika tlocrta';image.loading='lazy';viewer.append(image);}
        host.append(viewer);addSourceLink(host,href,'Otvori izvorni tlocrt ↗');
    }
    function renderDetail(project,apartmentId){
        clearViewers();const host=byId('detail');host.replaceChildren();if(!project)return;
        document.body.classList.add('detail-page');
        const apartments=project.apartments||[],selected=apartmentId?apartments.find(a=>String(a.id)===String(apartmentId)):null;
        const card=node('article','detail-card');
        if(selected){
            const breadcrumb=node('nav','detail-breadcrumb');breadcrumb.setAttribute('aria-label','Putanja projekta');
            const parent=node('a','',`← ${project.name||project.label||project.address||'Stambeni projekt'} · svi stanovi`);parent.href=projectPath(project);breadcrumb.append(parent);card.append(breadcrumb);
        }
        const head=node('div','detail-head'),left=node('div');
        const projectName=project.name||project.label||'Stambeni projekt',addressText=project.address||text.noAddress;
        const title=selected?`${selected.label||'Stan'} · ${projectName}${projectName===addressText?'':` — ${addressText}`}`:projectName;
        const h=node('h1','detail-title',title),address=node('p','detail-address',addressText);left.append(h,address);
        const links=node('div','detail-links'),home=node('a','', selected?'Povratak na pretragu':'← Povratak na pretragu');home.href='/novogradnje/';links.append(home);head.append(left,links);card.append(head);
        card.append(node('p','confidence-note',`${text.kinds[project.kind]||text.kinds.unknown} · ${text.year(project)}. Oznake ovise o dostupnim izvorima.`));
        if(!apartments.length)card.append(node('p','confidence-note','Projekt je pronađen kod izvora. Još nemamo podatke o pojedinim stanovima ni tlocrte za pregled. Pogledajte projekt kod izvora ili pretražite dostupne stanove.'));
        if(!selected){
            const sources=project.sources||[];
            if(sources.length){
                const projectSources=node('details','detail-sources'),summary=node('summary','',`Izvori oglasa (${sources.length})`),sourceList=node('div','detail-source-list');
                projectSources.open=!apartments.length;
                for(const source of sources)addSourceLink(sourceList,source.url,source.label||'Otvori oglas ↗');
                projectSources.append(summary,sourceList);card.append(projectSources);
            }
        }
        const visibleApartments=apartmentId?(selected?[selected]:[]):apartments,list=node('div',`apartment-list${selected?' single-apartment':''}`);
        for(const apartment of visibleApartments){
            const row=node('div',selected?'apartment-row selected-apartment':'apartment-row');
            const route=node(selected?'div':'a','apartment-route');
            if(!selected)route.href=apartmentPath(project,apartment);
            route.append(node('strong','',apartment.label||'Stan'),node('span','apartment-facts',apartmentFacts(apartment).join(' · ')));
            row.append(route);
            if(apartment.hasPlan)row.append(node('span','apartment-plan-status','Tlocrt dostupan'));
            if(apartment.postingUrl)addSourceLink(row,apartment.postingUrl,'Otvori izvor oglasa ↗');
            list.append(row);
        }
        if(visibleApartments.length)card.append(list);
        if(selected){
            const hasGeometry=Boolean(selected.architecture);
            const hasOriginal=Boolean(safeHref(selected.source?.assetUrl));
            const hasPlan=selected.hasPlan||hasGeometry||hasOriginal;
            const review=!hasPlan?'Tlocrt još nije obrađen.':hasGeometry?(selected.reviewStatus==='reviewed'||selected.reviewStatus==='published'?'Pregledana geometrija tlocrta.':'Procijenjena rekonstrukcija tlocrta; potrebna je provjera.'):'Dostupan je izvorni tlocrt.';
            card.append(node('p','confidence-note',`${review} Orijentacije i površine prikazane su samo kada su navedene u izvoru.`));
            const grid=node('div','viewer-grid');
            if(hasPlan){
                const plan=node('section','viewer-panel'),planTitle=node('h3','',hasGeometry?'Tlocrt i 3D prikaz':'Izvorni tlocrt');plan.append(planTitle);
                if(hasGeometry){const planHost=node('div','');plan.append(planHost);viewers.push(V.mountApartment(planHost,selected));}
                if(hasOriginal){addOriginal(plan,selected.source);if(!hasGeometry)plan.append(node('p','viewer-copy','3D rekonstrukcija još nije izrađena.'));}
                addSourceLink(plan,selected.source?.url||selected.source?.publicUrl,'Otvori izvor tlocrta ↗');grid.append(plan);
            }
            if(C.hasEnvelope(project.model)){
                const building=node('section','viewer-panel'),buildingTitle=node('h3','', 'Obris i katovi zgrade'),buildingHost=node('div','viewer-canvas');building.append(buildingTitle,buildingHost);
                const placement=selected.placement,floorAvailable=Number.isFinite(selected.floor)&&(project.model?.envelope?.storeys||[]).some(s=>s.level===selected.floor&&Number.isFinite(s.elevationM));
                const placementText=placement?.status==='placed'&&floorAvailable?'Procijenjeni položaj prema tlocrtu i obrisu zgrade.':placement?.status==='ambiguous'?'Položaj nije jednoznačan; tlocrt nije postavljen u zgradu.':'Položaj stana nije prikazan jer kat ili siguran položaj nisu poznati.';
                building.append(node('p','viewer-copy',placementText));viewers.push(V.mountEnvelope(buildingHost,project.model,selected));grid.append(building);
            }
            if(grid.childNodes.length)card.append(grid);
        } else if(C.hasEnvelope(project.model)) {
            const envelope=node('section','viewer-panel'),title=node('h3','', 'Obris i katovi zgrade'),canvas=node('div','viewer-canvas');envelope.append(title,canvas,node('p','viewer-copy','Model prikazuje dostupni obris zgrade i katove; visine mogu biti procijenjene iz izvora.'));viewers.push(V.mountEnvelope(canvas,project.model,null));card.append(envelope);
        }
        host.append(card);if(detailError)host.append(node('p','confidence-note',detailError));if(apartmentId&&!selected)host.append(node('p','confidence-note','Traženi stan nije dostupan u trenutnom katalogu.'));
    }
    async function load(){
        controls(initial);
        if(boot.catalogue)catalogue=boot.catalogue;
        else try{const r=await fetch('/novogradnje/api/projects',{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);catalogue=await r.json();}catch(error){catalogueError=`Katalog trenutačno nije dostupan. ${error.message||'Provjerite vezu i pokušajte ponovno.'}`;}
        renderResults();
        detail=boot.project||null;activeApartmentId=boot.apartmentId||null;
        if(detail&&!detail.model)try{const response=await fetch(`/novogradnje/api/projects/${encodeURIComponent(detail.id||detail.slug)}`,{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);detail=await response.json();}catch(error){detailError=`Detalji projekta nisu se učitali. Prikazujemo samo podatke dostupne na ovoj stranici. ${error.message||''}`;}
        if(detail)renderDetail(detail,activeApartmentId);
    }
    let searchEditing=false;
    byId('filters').addEventListener('submit',ev=>{ev.preventDefault();searchEditing=false;updateURL(true);renderResults();});
    for(const control of [byId('kind'),byId('minArea'),byId('maxArea'),byId('rooms'),byId('orientation')])control.addEventListener('change',()=>{searchEditing=false;updateURL(true);renderResults();});
    byId('q').addEventListener('input',()=>{byId('clear-search').hidden=!byId('q').value;renderResults();updateURL(!searchEditing);searchEditing=true;});
    byId('q').addEventListener('change',()=>{searchEditing=false;updateURL(true);});
    byId('clear-search').addEventListener('click',()=>{byId('q').value='';byId('clear-search').hidden=true;searchEditing=false;updateURL(true);renderResults();byId('q').focus();});
    byId('reset').addEventListener('click',()=>{controls(C.normalizeFilters({}));searchEditing=false;updateURL(true);renderResults();});
    byId('include-older').addEventListener('click',()=>{byId('kind').value='all';searchEditing=false;updateURL(true);renderResults();});
    addEventListener('popstate',()=>{searchEditing=false;controls(C.decodeFilters(location.search));renderResults();});
    addEventListener('pagehide',()=>{clearViewers();map?.remove();});
    load();
})();
