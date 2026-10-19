// Producer projection into the shared worldwide floor-plan publication contract.
// Plan identity depends on the source drawing and its unit/page, never geographic association.
import {fingerprint} from '../buildings/floor-models.js';
import {projectId} from '../floor-plan-archive/public-catalogue.js';
import {createRequire} from 'node:module';
const {validateArchitecture}=createRequire(import.meta.url)('../../frontend/js/building-floor-plans.js');
const finite=n=>typeof n==='number'&&Number.isFinite(n)?n:null;
export function publicationPlanId(item) {
    if(!item.source?.url||!item.source?.sha256)throw Error('A source drawing is required for publication.');
    return fingerprint(['source-plan',item.source.url,item.source.page||1,item.unitId||item.id]);
}
function point(model) {
    if(!['located','probable'].includes(model.location?.status))return null;
    const f=model.envelope?.footprint,r=f?.type==='Polygon'?f.coordinates?.[0]:f?.type==='MultiPolygon'?f.coordinates?.[0]?.[0]:null;
    if(!r||r.length<4||r.some(p=>!Array.isArray(p)||p.length<2||!p.slice(0,2).every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>90))return null;
    const open=r.slice(0,-1);return {lng:open.reduce((s,p)=>s+p[0],0)/open.length,lat:open.reduce((s,p)=>s+p[1],0)/open.length,status:model.location.status};
}
export function publicationRows(models,{city=null,country=null,blobs=new Map()}={}) {
    const plans=new Map();
    for(const row of models){const m=row.model,inv=m?.inventory;if(!m?.siteKey||!inv||inv.excludedUse)continue;
        const location=point(m),buildingId=projectId(m.siteKey),building={id:buildingId,label:m.label||inv.name||'Project',name:inv.name||m.label||null,
            address:location?m.label:null,city:Object.hasOwn(row,'publicationCity')?row.publicationCity:city,country:Object.hasOwn(row,'publicationCountry')?row.publicationCountry:country,kind:inv.kind||'unknown',constructionYear:inv.constructionYear??null,completionYear:inv.completionYear??null,
            location,footprint:location?m.envelope.footprint:null,envelope:location?m.envelope:null,sources:m.sources||[],archiveEvidence:m.archiveEvidence||null};
        for(const item of [...(inv.apartments||[]),...(inv.floorPlans||[])]){
            const blob=blobs.get(item.source?.sha256);if(item.hasPlan!==true||!blob?.bytes_available)continue;
            const architecture=item.architecture && validateArchitecture(item.architecture).length===0 ? item.architecture : null;
            const scope=item.scope==='floor'?'floor':'unit',id=publicationPlanId(item);
            const document={externalId:item.id,label:item.label||'Floor plan',scope,unitId:item.unitId||null,levels:item.levels||[],floor:item.floor??null,
                areaM2:finite(item.areaM2),marketedAreaM2:finite(item.marketedAreaM2),physicalNetAreaM2:finite(item.physicalNetAreaM2),rooms:finite(item.rooms),
                orientation:item.orientation||[],roomSchedule:Array.isArray(item.roomSchedule)?item.roomSchedule:[],architecture,location,building,
                buildingRef:item.buildingRef||null,placement:location?(m.placements||[]).find(p=>p.planId===item.planId)||null:null,
                source:{sha256:item.source.sha256,url:item.source.url,page:item.source.page||1,crop:item.source.crop||null,
                    mediaType:blob.media_type.split(';')[0].toLowerCase(),urls:item.sourceUrls||[],listingUrl:item.postingUrl||null,
                    label:item.sourceTitle||null,attribution:item.source.attribution||m.archiveEvidence?.attribution||null},
                quality:{status:!architecture?'source':['reviewed','published'].includes(item.reviewStatus)?'reviewed':'needs_review',issues:item.reviewNotes||item.issues||item.quality?.issues||[]}};
            const value={id,building_id:buildingId,document,updated_at:row.built_at||null};const old=plans.get(id);
            if(!old||(!old.document.architecture&&architecture)||(Boolean(old.document.architecture)===Boolean(architecture)&&new Date(value.updated_at||0)>new Date(old.updated_at||0)))plans.set(id,value);
        }
    }
    return [...plans.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
