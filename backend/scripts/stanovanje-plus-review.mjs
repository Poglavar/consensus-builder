// Generate a private review bundle; --serve exposes only its explicit read-only routes.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {geometryIssues} from '../floor-plans/geometry-quality.js';
import {reviewRoutes} from './stanovanje-plus-review/routes.mjs';
import {buildingOutline} from './stanovanje-plus-review/building-model.mjs';
const {validateArchitecture}=createRequire(import.meta.url)('../../frontend/js/building-floor-plans.js');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const root=path.join(repo,'backend/logs/stanovanje-plus-ten-20261019');
const assets=path.join(repo,'backend/scripts/stanovanje-plus-review');
const read=(name)=>JSON.parse(fs.readFileSync(name,'utf8'));
const optional=name=>fs.existsSync(name)?read(name):null;
const selection=read(path.join(root,'selection.json'));
const originalManifest=optional(path.join(root,'manifest.json'));
const items=selection.map(source=>{
 const dir=path.join(root,source.code),revision=fs.existsSync(path.join(dir,'model.refined.json'))?'refined':'original';
 const file=revision==='refined'?'model.refined.json':'model.json',model=optional(path.join(dir,file));
 const modelSha256=model?createHash('sha256').update(fs.readFileSync(path.join(dir,file))).digest('hex'):null;
 const review=optional(path.join(dir,'manual-review.json'));
 const manualReview=review&&review.modelSha256===modelSha256?review:null;
 const validation=model?validateArchitecture(model.architecture):['No processed model available.'];
 const issues=model&&!validation.length?geometryIssues(model.architecture,{rooms:model.rooms||[]}):[];
 const evidence=optional(path.join(dir,'building-evidence.json'));
 const building=model&&!validation.length?buildingOutline(evidence,model.architecture):null;
 if(building)fs.writeFileSync(path.join(dir,'building-outline.json'),JSON.stringify(building,null,2));
 return {source,revision,model,modelSha256,building,validation,geometryReviewIssues:issues,manualReview,refinementGeometry:optional(path.join(dir,'refinement-geometry.json')),frame:optional(path.join(dir,'frame.json')),
  image:`/source/${source.code}/source.png`,download:`/model/${source.code}/${file}`,
  originalReceipt:optional(path.join(dir,'response.json'))&&{file:'response.json'},
  refinementReceipt:optional(path.join(dir,'refinement-response.json'))&&{file:'refinement-response.json'}};
});
const manifest={schema:'stanovanje-plus.private-review.v2',createdAt:new Date().toISOString(),private:true,
 publication:'none',geographicRegistration:'none; local drawing coordinates only',
 qualityGate:'Per-model manual review is bound to its exact file hash. Format validation and geometry checks do not establish usability.',
 originalRunManifest:originalManifest,
 models:items.map(i=>({code:i.source.code,revision:i.revision,model:i.download,buildingOutline:i.building?{aboveGroundCount:i.building.aboveGroundCount,belowGroundCount:i.building.belowGroundCount,heightBasis:i.building.heightBasis,outlineBasis:i.building.outlineBasis}:null,formatValid:!i.validation.length,manualReview:i.manualReview,validation:i.validation,geometryReviewIssues:i.geometryReviewIssues,
  originalReceipt:i.originalReceipt,refinementReceipt:i.refinementReceipt})),
 accounting:'Original run totals are preserved above. Refinement receipts are separate; no aggregate or 200-building projection is recomputed here.'};
fs.writeFileSync(path.join(root,'review-manifest.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(root,'review-data.json'),JSON.stringify({manifest,items}));
for(const [from,to] of [['index.html','review.html'],['review.css','review.css'],['review.js','review.js']])fs.copyFileSync(path.join(assets,from),path.join(root,to));
if(process.argv.includes('--serve')){
 const port=Number(process.argv.find(v=>v.startsWith('--port='))?.split('=')[1]||8603);
 const routes=reviewRoutes(root,repo,items);
 const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'};
 const server=http.createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
  const file=routes.get(new URL(req.url,'http://localhost').pathname);
  if(!file||!fs.existsSync(file)){res.writeHead(404).end('Not found');return;}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);
 });
 server.listen(port,'127.0.0.1',()=>console.log(`Private read-only review: http://localhost:${port}`));
}else console.log(JSON.stringify({review:'review.html',models:items.length,refined:items.filter(i=>i.revision==='refined').length,manifest:'review-manifest.json'}));
