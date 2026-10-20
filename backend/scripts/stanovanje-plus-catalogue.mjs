// Prepare private publication-contract rows using retained full-source PNGs.
// This builds review artifacts only; it never writes the shared publication database.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {publicationRows} from '../floor-plans/publication.js';
import {catalogueFromPublishedPlans} from '../floor-plan-archive/shared-catalogue.js';
import {createRequire} from 'node:module';
const {validateArchitecture}=createRequire(import.meta.url)('../../frontend/js/building-floor-plans.js');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function archiveCatalogue(root){
 const selection=read(path.join(root,'selection.json')),groups=new Map(),sources=[],issues=[];
 for(const source of selection){
  if(!source.sourceSha256){issues.push({code:source.code,reason:'Source collection is pending or unavailable'});continue;}
  const dir=path.join(root,source.code),raster=path.join(dir,'source-full.png'),svg=path.join(dir,'source.svg');
  if(!fs.existsSync(raster)||!fs.existsSync(svg)){issues.push({code:source.code,reason:'Retained source raster unavailable'});continue;}
  if(hash(fs.readFileSync(svg))!==source.sourceSha256)throw Error('Source hash mismatch: '+source.code);
  const rasterBytes=fs.readFileSync(raster),sha256=hash(rasterBytes);
  sources.push({sha256,media_type:'image/png',byte_count:rasterBytes.length,file:source.code+'/source-full.png',
   originalSvg:{sha256:source.sourceSha256,file:source.code+'/source.svg',url:source.sourceUrl},
   basis:'Full original SVG rasterized by stanovanje-plus-render.cjs; no inferred reconstruction in this source image'});
  const modelFile=['model.refined.json','model.json'].find(file=>fs.existsSync(path.join(dir,file)));
  const model=modelFile?read(path.join(dir,modelFile)):null;
  const validation=model?validateArchitecture(model.architecture):[];
  const architecture=model&&!validation.length?model.architecture:null;
  const reviewFile=path.join(dir,'manual-review.json'),review=fs.existsSync(reviewFile)?read(reviewFile):null;
  const reviewed=architecture&&review?.modelSha256===hash(fs.readFileSync(path.join(dir,modelFile)))&&review.verdict==='usable-with-limitations';
  const attribution='Stanovanje.plus — Digitalni arhiv stambenih zgrada Hrvatske; project author(s): '+source.author;
  if(!groups.has(source.buildingCode)){
   const evidence=path.join(root,'buildings',source.buildingCode,'building-evidence.json');
   const metadata=fs.existsSync(evidence)?read(evidence):null,year=metadata?.fields?.['Godina izvođenja'];
   groups.set(source.buildingCode,{publicationCity:source.city,publicationCountry:'HR',model:{
    siteKey:'stanovanje-plus:'+source.buildingCode,label:source.title,location:{status:'unknown'},placements:[],
    sources:[{url:source.infoUrl,label:'Stanovanje.plus archive metadata'}],
    archiveEvidence:{description:'Archival building floor drawings',attribution,source:'Stanovanje.plus',url:source.infoUrl,
     designState:'Archive drawings; current as-built condition and geographic placement are unverified.',permitYear:null},
    inventory:{name:source.title,kind:'existing',constructionYear:/^\d{4}$/.test(year||'')?Number(year):null,apartments:[],floorPlans:[]}}});
  }
  groups.get(source.buildingCode).model.inventory.floorPlans.push({
   id:source.unitId,unitId:source.unitId,label:model?.label||source.title+' — '+source.drawingId,
   hasPlan:true,scope:'floor',floor:null,levels:[],architecture,reviewStatus:reviewed?'reviewed':'needs_review',
   reviewNotes:[...(model?.issues||[]),...validation,...(reviewed?review.limitations||[]:[])].map(x=>String(x).slice(0,2000)).slice(0,100),
   source:{url:source.sourceUrl,sha256,page:1,crop:null,attribution},sourceTitle:source.planLabel,
   sourceUrls:[source.sourceUrl,source.infoUrl],postingUrl:source.infoUrl});
 }
 const blobs=new Map(sources.map(s=>[s.sha256,{bytes_available:true,media_type:s.media_type}]));
 const rows=publicationRows([...groups.values()],{blobs});
 const plans=rows.map(row=>({...row.document,id:row.id,buildingId:row.building_id,updatedAt:null}));
 return {private:true,publication:'pending-source-permission-and-review',rows,sources,issues,
  catalogue:catalogueFromPublishedPlans(plans)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=process.argv.find(a=>a.startsWith('--root='))?.slice(7);
 if(!root)console.log('Usage: node stanovanje-plus-catalogue.mjs --root=<archive>');
 else{const result=archiveCatalogue(path.resolve(root));fs.writeFileSync(path.join(root,'publication-bundle.json'),JSON.stringify(result));
  console.log(JSON.stringify({private:result.private,publication:result.publication,...result.catalogue.counts,sourceGaps:result.issues.length}));}
}
