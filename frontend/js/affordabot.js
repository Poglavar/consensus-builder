// Affordabot research desk. Rendering uses text nodes; all feasibility arithmetic lives in the shared model.
(function startAffordabot(root) {
    'use strict';
    const model=root.AffordabotModel,el=id=>document.getElementById(id),params=new URLSearchParams(location.search);
    const tr=(key,values={})=>root.i18n.t(`affordabot.${key}`,values);
    const local=['localhost','127.0.0.1'].includes(location.hostname);
    const backend=((local?params.get('backend'):null)||(location.hostname.endsWith('urbangametheory.xyz')?'https://api.urbangametheory.xyz':location.origin)).replace(/\/$/,'');
    const storageKey='consensus-builder.affordabot.research.v1';
    const areas={west:[15.93,45.78,15.97,45.81],centre:[15.96,45.79,16.00,45.82],east:[16.00,45.78,16.04,45.81]};
    const state={report:null,site:null,variantId:null,assumptions:{...model.defaults},saved:[],map:null,layers:[],mapBbox:null,busy:false,valid:true};
    const locale=()=>({en:'en-GB',es:'es-ES',sr:'sr-Latn-RS',hr:'hr-HR'}[root.i18n.getLanguage()]||'en-GB');
    const number=(n,digits=0)=>typeof n==='number'&&Number.isFinite(n)?new Intl.NumberFormat(locale(),{maximumFractionDigits:digits}).format(n):tr('unknown');
    const money=n=>typeof n==='number'&&Number.isFinite(n)?new Intl.NumberFormat(locale(),{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n):tr('unknown');
    const date=value=>value?new Date(value).toLocaleDateString(locale()):tr('unknown');
    const text=(tag,value,className)=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;};
    const selected=()=>state.site?.variants.find(v=>v.id===state.variantId);
    const label=v=>`${tr(v.scenario)} · ${tr(v.form)}`;
    const finance=(site,variant)=>model.rentalFeasibility({gfaM2:variant.gfaM2,siteAreaM2:site.areaM2,maxHomes:variant.maxHomes,minParkingPerHome:variant.minParkingPerHome},state.assumptions);
    function status(value,kind=''){el('status').textContent=value;el('status').className=`notice ${kind?'is-'+kind:''}`;}
    function busy(value){state.busy=value;el('scan-button').disabled=value;el('map-search').disabled=value;el('scan-button').textContent=tr(value?'scanning':'scan');}
    async function request(path,body){
        const response=await fetch(backend+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(45000)});
        const payload=await response.json();if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);return payload;
    }
    function initMap(){
        if(!root.L){el('site-map').append(text('p',tr('failed',{message:'Map library unavailable'}),'empty'));return;}
        state.map=root.L.map(el('site-map'),{zoomAnimation:false,fadeAnimation:false,markerZoomAnimation:false}).setView([45.795,15.95],13);
        root.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(state.map);
    }
    function drawMap(focus=false){
        if(!state.map||!state.site)return;
        for(const layer of state.layers)layer.remove();state.layers=[];
        const css=getComputedStyle(document.documentElement),site=state.site,variant=selected();
        const ground=root.L.geoJSON(site.geometry,{style:{color:css.getPropertyValue('--ground').trim(),weight:2,fillOpacity:.08}}).addTo(state.map);state.layers.push(ground);
        if(variant)state.layers.push(root.L.geoJSON(variant.massing,{style:{color:css.getPropertyValue('--building').trim(),weight:2,fillOpacity:.52}}).addTo(state.map));
        const stop=site.accessibility?.nearestStop;
        if(Number.isFinite(stop?.lat)&&Number.isFinite(stop?.lng)){
            const marker=root.L.circleMarker([stop.lat,stop.lng],{radius:6,color:css.getPropertyValue('--ground').trim(),fillOpacity:1}).bindTooltip(text('span',stop.name)).addTo(state.map);state.layers.push(marker);
        }
        if(focus&&ground.getBounds().isValid())state.map.fitBounds(ground.getBounds().pad(.5),{maxZoom:17,animate:false});
    }
    function summary(){
        el('scanned-count').textContent=state.report?number(state.report.scanned):'—';
        el('lead-count').textContent=state.report?number(state.report.candidates.length):'—';
        el('target-count').textContent=state.report&&state.valid?number(state.report.candidates.filter(site=>{
            const variant=site.variants.find(v=>v.id===site.recommendedVariantId);return variant&&finance(site,variant).withinTarget;
        }).length):'—';
        el('saved-count').textContent=number(state.saved.length);
    }
    function renderCandidates(){
        el('candidate-list').replaceChildren();
        const sites=state.report?.candidates||[];el('empty-list').hidden=sites.length>0;
        el('empty-list').textContent=tr(state.report?'noResults':'empty');
        for(const site of sites){
            const variant=site.variants.find(v=>v.id===site.recommendedVariantId),f=finance(site,variant);
            const button=document.createElement('button');button.type='button';button.className='candidate';button.setAttribute('aria-pressed',String(state.site?.parcelId===site.parcelId));
            button.append(text('span',site.koName||site.parcelId,'candidate-title'),text('span',site.parcelId,'candidate-id'));
            const values=text('span','','candidate-values');values.append(text('span',`${number(f.homes)} ${tr('homes')}`),text('span',money(state.valid?f.rentMonth:null)));button.append(values);
            button.append(text('span',tr('distance',{distance:number(site.accessibility?.nearestStop?.distanceM)}),'candidate-foot'));
            button.addEventListener('click',()=>choose(site,true));el('candidate-list').append(button);
        }
        summary();
    }
    function renderSaved(){
        el('saved-list').replaceChildren();
        if(!state.saved.length)el('saved-list').append(text('p',tr('noDrafts'),'form-note'));
        for(const draft of state.saved){
            const button=text('button',`${draft.site.koName||draft.site.parcelId} · ${date(draft.updatedAt)}`,'action');button.type='button';
            button.addEventListener('click',()=>{
                state.assumptions=model.validateAssumptions(draft.assumptions);state.valid=true;state.site=structuredClone(draft.site);state.variantId=draft.variantId;
                el('review-note').value=draft.note||'';renderAssumptions();renderSite(true);renderCandidates();
            });el('saved-list').append(button);
        }
        summary();
    }
    function renderAssumptions(){
        const form=el('assumptions-form');form.replaceChildren();
        for(const [key,value]of Object.entries(state.assumptions)){
            const field=document.createElement('div');field.className='field';const id=`assumption-${key}`;
            const labelNode=text('label',tr(`input.${key}`));labelNode.htmlFor=id;
            const input=document.createElement('input');input.type='number';input.id=id;input.dataset.assumption=key;
            input.min=model.ranges[key][0];input.max=model.ranges[key][1];input.step=['netRatio','parkingPerHome'].includes(key)?'.01':['annualInterestPct','operatingEurM2Month'].includes(key)?'.1':'1';
            input.value=value===null?'':value;field.append(labelNode,input);form.append(field);
        }
    }
    function readAssumptions(){
        const next={};for(const input of el('assumptions-form').querySelectorAll('input'))next[input.dataset.assumption]=input.value===''?null:input.valueAsNumber;
        state.assumptions=model.validateAssumptions(next);state.valid=true;
    }
    function changesFor(variant){
        const changes=(variant?.changes||state.site.changes).filter(change=>change.field!=='parkingPerHome');
        const minimum=state.site.planning.rule?.minParkingPerUnit,parking=state.assumptions.parkingPerHome;
        if(variant?.scenario==='reform'&&Number.isFinite(minimum)&&Number.isFinite(parking)&&parking<minimum)changes.push({field:'parkingPerHome',from:minimum,to:parking});
        return changes;
    }
    function changesText(){
        const changes=changesFor(selected());
        if(!changes.length)return [tr(state.site.planning.housingUse===null||!Number.isFinite(state.site.planning.rule?.maxFloors)||!Number.isFinite(state.site.planning.rule?.minSetbackM)?'unknownChanges':'noChanges')];
        return changes.map(change=>tr('change',{field:tr(`field.${change.field}`),from:change.from??tr('unknown'),to:typeof change.to==='string'?(['residential-or-mixed','courtyard'].includes(change.to)?tr(change.to):change.to):number(change.to,2)}));
    }
    function renderFinance(){
        const site=state.site,variant=selected();if(!site||!variant)return;
        const f=finance(site,variant),body=el('comparison');body.replaceChildren();
        for(const alternative of site.variants){
            const result=finance(site,alternative),row=document.createElement('tr');if(alternative.id===variant.id)row.className='is-selected';
            row.append(text('td',label(alternative)),text('td',number(result.homes)),text('td',money(state.valid?result.rentMonth:null)),text('td',`${number(alternative.gfaM2)} m²`));body.append(row);
        }
        const metrics=el('site-metrics');metrics.replaceChildren();
        for(const [value,caption]of [[number(f.homes),tr('homes')],[money(state.valid?f.rentMonth:null),tr('rentLabel')],[number(site.accessibility?.nearestStop?.distanceM)+' m',tr('distance',{distance:number(site.accessibility?.nearestStop?.distanceM)})]]){
            const card=document.createElement('div');card.className='site-metric';card.append(text('strong',value),text('span',caption));metrics.append(card);
        }
        const description=!state.valid?tr('financeInvalid'):f.rentMonth===null?tr('financeMissing'):f.operatingFloorAboveTarget?tr('operatingFloor'):tr(f.withinTarget?'financeYes':'financeNo',{rent:money(f.rentMonth),target:money(f.targetRentMonth),gap:money(f.additionalGrantPerHome)});
        el('finance-summary').textContent=description+(variant.minParkingPerHome>0?' '+tr('parkingMinimum',{count:variant.minParkingPerHome}):'');el('finance-summary').className=`notice ${state.valid&&f.withinTarget?'is-positive':''}`;
        const costs=el('cost-breakdown');costs.replaceChildren();
        if(state.valid&&f.cost){
            for(const key of ['construction','land','parking','soft','contingency','capital','grant','financed'])costs.append(text('dt',tr(`cost.${key}`)),text('dd',money(f.cost[key])));
            costs.append(text('dt',`${tr('cost.sensitivity')} (±${number(state.assumptions.costSensitivityPct)}%)`),text('dd',`${money(f.rentLowMonth)} – ${money(f.rentHighMonth)}`));
        }
        for(const id of ['save-draft','open-design','export-draft','copy-post'])el(id).disabled=!state.valid;
        renderDrafts();summary();
    }
    function renderDrafts(){
        const site=state.site,variant=selected();if(!site||!variant)return;
        const f=finance(site,variant),values={homes:number(f.homes),place:site.koName||site.parcelId,rent:money(state.valid?f.rentMonth:null),target:money(state.valid?f.targetRentMonth:null),
            form:tr(variant.form),floors:number(variant.floors),parcel:site.parcelId,changes:changesText().join('\n'),source:site.planning.rule?.url||tr('unknown'),notes:el('review-note').value||tr('unknown')};
        el('post-draft').textContent=tr('postTemplate',values);el('authority-draft').textContent=tr('authorityTemplate',values);
    }
    function renderSite(focus=false){
        const site=state.site;if(!site)return;
        el('site-empty').hidden=true;el('site-detail').hidden=false;
        el('site-id').textContent=site.parcelId;el('site-name').textContent=`${site.koName||site.parcelId} · ${tr('areaM2',{area:number(site.areaM2)})}`;
        el('variant').replaceChildren(...site.variants.map(variant=>{const option=text('option',label(variant));option.value=variant.id;return option;}));el('variant').value=state.variantId;
        el('planning-context').textContent=tr('planningContext',{use:site.planning.landUse?.mark||tr('unknown'),rule:site.planning.rule?.shortName||tr('unknown')});
        el('planning-changes').replaceChildren(...changesText().map(line=>text('li',line)));
        const link=el('rule-link');link.hidden=!site.planning.rule?.url;if(!link.hidden)link.href=site.planning.rule.url;
        const stop=site.accessibility?.nearestStop;
        el('transit-evidence').textContent=stop?tr('transit',{distance:number(stop.distanceM),stop:stop.name,feed:site.accessibility.feedId,date:date(site.accessibility.feedFetchedAt)}):tr('noTransit');
        el('evidence-gaps').replaceChildren(...site.evidenceGaps.map(key=>text('li',tr(`gap.${key}`))));
        renderFinance();drawMap(focus);
    }
    function choose(site,focus){state.site=site;state.variantId=site.recommendedVariantId;el('review-note').value='';renderSite(focus);renderCandidates();}
    function packageDraft(){
        readAssumptions();const site=state.site,variant=selected(),f=finance(site,variant),now=new Date().toISOString();
        const proposal=model.buildResearchProposal(site,variant,state.assumptions,{
            proposalId:`affordabot-${crypto.randomUUID()}`,createdAt:now,
            title:tr('proposalTitle',{place:site.koName||site.parcelId,homes:number(f.homes)}),description:el('authority-draft').textContent
        });
        const snapshot=structuredClone(site);
        snapshot.variants.forEach(alternative=>{alternative.finance=finance(site,alternative);alternative.changes=changesFor(alternative);});
        snapshot.changes=changesFor(variant);
        snapshot.currentHomes=site.currentHomes===null?null:Math.max(0,...snapshot.variants.filter(v=>v.scenario==='current').map(v=>v.finance.homes??0));
        snapshot.addedHomes=snapshot.currentHomes===null?null:f.homes-snapshot.currentHomes;
        return {version:1,language:root.i18n.getLanguage(),site:snapshot,variantId:variant.id,assumptions:{...state.assumptions},
            note:el('review-note').value,updatedAt:now,proposal,postDraft:el('post-draft').textContent,authorityDraft:el('authority-draft').textContent,
            scan:state.report?{generatedAt:state.report.generatedAt,search:state.report.search,scanned:state.report.scanned,status:state.report.status,failures:state.report.failures}:null};
    }
    function saveDraft(){
        const draft=packageDraft(),key=`${draft.site.parcelId}:${draft.variantId}`;
        const next=[{...draft,key},...state.saved.filter(item=>item.key!==key)].slice(0,30);
        localStorage.setItem(storageKey,JSON.stringify(next));state.saved=next;renderSaved();status(tr('savedNotice'));return draft;
    }
    function handleSave(){try{return saveDraft();}catch(error){status(tr('storageFailed'),'error');console.error(error.message);return null;}}
    async function scan(){
        if(state.busy)return;
        try{
            readAssumptions();const bbox=el('area').value==='map'?state.mapBbox:areas[el('area').value];
            const reform={floors:el('reform-floors').valueAsNumber,setbackM:el('reform-setback').valueAsNumber,coveragePct:el('reform-coverage').valueAsNumber};
            busy(true);status(tr('scanning'));
            const report=await request('/affordabot/scan',{bbox,reform,assumptions:state.assumptions});
            state.report=report;state.site=null;state.variantId=null;state.assumptions=report.assumptions;
            el('site-detail').hidden=true;el('site-empty').hidden=false;
            for(const layer of state.layers)layer.remove();state.layers=[];
            renderAssumptions();renderCandidates();
            if(report.candidates.length)choose(report.candidates[0],true);
            const message=tr('scanComplete',{scanned:number(report.scanned),leads:number(report.candidates.length),excluded:number(report.excluded.length),time:date(report.generatedAt)});
            status([message,report.sampleCapped?tr('capped'):'',report.failures.length?tr('partial',{count:report.failures.length}):''].filter(Boolean).join(' '),report.failures.length?'warning':'');
        }catch(error){status(tr('failed',{message:error.message}),'error');}
        finally{busy(false);}
    }
    el('scan-form').addEventListener('submit',event=>{event.preventDefault();scan();});
    el('assumptions-form').addEventListener('submit',event=>event.preventDefault());
    el('assumptions-form').addEventListener('input',()=>{
        try{readAssumptions();renderFinance();renderCandidates();}
        catch(error){state.valid=false;renderFinance();renderCandidates();}
    });
    el('variant').addEventListener('change',()=>{state.variantId=el('variant').value;renderSite();});
    el('review-note').addEventListener('input',renderDrafts);
    el('save-draft').addEventListener('click',handleSave);
    el('copy-post').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(el('post-draft').textContent);status(tr('copied'));}catch{status(tr('copyFailed'),'error');}});
    el('export-draft').addEventListener('click',()=>{
        try{
            const draft=packageDraft(),blob=new Blob([JSON.stringify(draft,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob);
            const anchor=document.createElement('a');anchor.href=url;anchor.download=`affordabot-${state.site.parcelId}.json`;anchor.click();URL.revokeObjectURL(url);
        }catch(error){status(error.message,'error');}
    });
    el('open-design').addEventListener('click',()=>{
        const draft=handleSave();if(!draft)return;
        try{
            const token=crypto.randomUUID();localStorage.setItem('consensus-builder.affordabot.handoff.v1',JSON.stringify({version:1,token,proposal:draft.proposal}));
            const url=new URL('index.html',location.href);url.searchParams.set('city','zg');url.searchParams.set('lang',root.i18n.getLanguage());url.searchParams.set('affordabotDraft',token);
            for(const key of ['apiPort','backend'])if(params.has(key))url.searchParams.set(key,params.get(key));
            location.assign(url.href);
        }catch(error){status(tr('storageFailed'),'error');}
    });
    el('map-search').addEventListener('click',()=>{
        if(!state.map)return;const bounds=state.map.getBounds();state.mapBbox=[bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()];
        el('area').querySelector('[value=map]').hidden=false;el('area').value='map';scan();
    });
    el('language').value=root.i18n.getLanguage();el('language').addEventListener('change',()=>root.i18n.setLanguage(el('language').value));
    root.i18n.onChange(()=>{root.i18n.applyTranslations();renderAssumptions();renderCandidates();renderSaved();renderSite();});
    try{const saved=JSON.parse(localStorage.getItem(storageKey)||'[]');if(!Array.isArray(saved)||saved.some(draft=>!draft.site?.variants?.length||!draft.assumptions||!draft.variantId))throw new Error('Invalid saved drafts');state.saved=saved;}catch(error){status(tr('storageFailed'),'error');}
    initMap();renderAssumptions();renderSaved();busy(false);
    const builderURL=new URL('index.html',location.href);builderURL.searchParams.set('lang',root.i18n.getLanguage());
    if(local)builderURL.searchParams.set('backend',backend);el('builder-link').href=builderURL.href;
    request('/affordabot/config').catch(error=>status(tr('failed',{message:error.message}),'error'));
})(window);
