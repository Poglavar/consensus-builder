// Novogradnje is a consumer of the shared publication API. It owns presentation and URLs only.
import {publicProject} from './public-catalogue.js';
import {createRequire} from 'node:module';
const {compareCompletion}=createRequire(import.meta.url)('../../frontend/novogradnje/catalogue.js');
export function catalogueFromPublishedPlans(plans) {
    const groups=new Map(),retained=new Map();
    for(const p of plans){if(!p.buildingId||!p.building)continue;const b=p.building;
        retained.set(p.source.sha256,p.source.mediaType||null);
        if(!groups.has(p.buildingId))groups.set(p.buildingId,{public_id:p.buildingId,built_at:p.updatedAt,model:{siteKey:`publication:${p.buildingId}`,label:b.label||b.name,
            location:{status:p.location?.status||(p.location?'located':'unknown')},envelope:b.envelope||null,placements:[],sources:b.sources||[],archiveEvidence:b.archiveEvidence||null,
            inventory:{name:b.name||b.label,kind:b.kind||'unknown',constructionYear:b.constructionYear,completionYear:b.completionYear,apartments:[],floorPlans:[]}}});
        const row=groups.get(p.buildingId),item={id:p.externalId||p.id,label:p.label,hasPlan:true,architecture:p.architecture,source:p.source,
            scope:p.scope,unitId:p.unitId,levels:p.levels||[],floor:p.floor,areaM2:p.areaM2,rooms:p.rooms,orientation:p.orientation||[],
            marketedAreaM2:p.marketedAreaM2,physicalNetAreaM2:p.physicalNetAreaM2,reviewStatus:p.quality?.status,reviewNotes:p.quality?.issues||[],
            sourceTitle:p.source.label,sourceUrls:p.source.urls||[],postingUrl:p.source.listingUrl,planId:p.id};
        row.model.inventory[p.scope==='floor'?'floorPlans':'apartments'].push(item);if(p.placement)row.model.placements.push({...p.placement,planId:p.id});
        if(new Date(p.updatedAt||0)>new Date(row.built_at||0))row.built_at=p.updatedAt;
    }
    const projects=[...groups.values()].map(row=>publicProject(row,{detail:true,retained})).filter(Boolean).sort(compareCompletion);
    return {projects,counts:{projects:projects.length,apartments:projects.reduce((n,p)=>n+p.apartments.length,0),floorPlans:projects.reduce((n,p)=>n+p.floorPlans.length,0),withPlans:projects.length},updatedAt:projects.map(p=>p.updatedAt).filter(Boolean).sort().at(-1)||null};
}
export function createSharedCatalogue({baseUrl,city='Zagreb',country='HR',fetchImpl=fetch,ttlMs=30000}={}) {
    const base=new URL(baseUrl);if(!['http:','https:'].includes(base.protocol))throw Error('Invalid shared floor-plan API URL.');
    let cached=null,until=0,pending=null;
    async function read(){if(cached&&Date.now()<until)return cached;if(pending)return pending;
        pending=(async()=>{const plans=[];for(let offset=0;offset<=100000;offset+=100){const url=new URL(`${base.href.replace(/\/$/,'')}/floor-plans`);url.search=new URLSearchParams({limit:'100',offset:String(offset),publicationCity:city,country});
            const response=await fetchImpl(url,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error(`Shared floor-plan API: HTTP ${response.status}`);
            const data=await response.json();if(!Array.isArray(data.plans))throw Error('Invalid shared floor-plan collection.');plans.push(...data.plans);if(!data.hasMore){cached=catalogueFromPublishedPlans(plans);until=Date.now()+ttlMs;return cached;}}
            throw Error('Shared floor-plan collection exceeded its bounded pagination.');})();
        try{return await pending}finally{pending=null}
    }
    return {read,async project(token){return(await read()).projects.find(p=>p.id===token||token.endsWith(`-${p.id}`))||null;},sourceUrl(hash){return `${base.href.replace(/\/$/,'')}/floor-plans/sources/${hash}`;}};
}
