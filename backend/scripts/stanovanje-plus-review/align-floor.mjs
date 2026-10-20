// Reuse the production floor fitter, with printed metric scale fixed and no physical mirroring.
import {fitPlan,ringArea,toLocalMetres} from '../../floor-plans/plan-placement.js';
import {drawingMatrix} from './registration.mjs';
const open=ring=>ring.length>1&&ring[0][0]===ring.at(-1)[0]&&ring[0][1]===ring.at(-1)[1]?ring.slice(0,-1):ring;
function exterior(geometry){
 const polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:[];
 return polygons.length===1?open(polygons[0][0]):null;
}
export function alignFloor({code,architecture,evidence,modelSha256}){
 const base={schema:'stanovanje-plus.floor-registration.v1',code,modelSha256,status:'unlocated',candidates:[],defaultCandidateId:null};
 if(evidence?.identityStatus!=='verified')return {...base,reason:'Building identity has not been independently established.'};
 const location=evidence.location;
 if(!Number.isFinite(location?.lat)||!Number.isFinite(location?.lng))return {...base,reason:'Missing verified map position.'};
 const origin=[location.lng,location.lat],dimensions=architecture.dimensionsM;
 if(architecture.slabs.length!==1)return {...base,status:'unresolved',reason:'Detached floor components need separate source-region interpretation.'};
 const plan=architecture.slabs[0][0].map(([u,v])=>[u*dimensions[0],-v*dimensions[1]]);
 const parts=evidence.parts||[{id:'building',label:evidence.address||'Building',footprint:evidence.footprint,footprintSource:evidence.footprintSource}];
 const candidates=[],targets=[],warnings=[];
 for(const part of parts){
  const outer=exterior(part.footprint);
  if(!outer){warnings.push(`${part.label}: disconnected or missing footprint; no convex hull is substituted.`);continue;}
  const target=toLocalMetres(outer,origin);
  const fit=fitPlan({plan,target,scope:'floor',scalePrior:{mPerUnit:1,tolerance:0}});
  targets.push({id:part.id,label:part.label,ring:target,source:part.footprintSource,areaM2:ringArea(target)});
  for(const [index,p] of fit.placements.entries())candidates.push({id:part.id+':'+index,partId:part.id,partLabel:part.label,rank:index,iou:p.iou,rotationDeg:p.rotationDeg,matrix:drawingMatrix(p),orientationStatus:fit.status,orientationMargin:fit.margin});
 }
 candidates.sort((a,b)=>b.iou-a.iou);
 const best=candidates[0],otherPart=candidates.find(c=>c.partId!==best?.partId),partMargin=best?best.iou-(otherPart?.iou||0):0;
 const good=best&&best.iou>=.75;
 const unique=good&&best.orientationStatus==='placed'&&partMargin>=.05;
 return {...base,origin,location,identityEvidence:evidence.identityEvidence,address:evidence.address,targets,warnings,
  candidates,status:unique?'aligned':good?'ambiguous':'unresolved',defaultCandidateId:unique?best.id:null,
  bestIou:best?.iou??null,partMargin,reason:unique?'Unique outline fit at printed scale.':good?'Rotation or building-part assignment has comparable alternatives.':'No sufficiently close independent footprint match.',
  method:'Independent survey/cadastral footprint; rigid rotation and translation at fixed printed scale. Drawing y-down converted to north-up. No inferred floor number.'};
}
