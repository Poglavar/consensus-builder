// Explicit route inventory keeps the local review server away from unrelated files.
import path from 'node:path';
export function reviewRoutes(root,repo,items){
 const routes=new Map([['/',path.join(root,'review.html')],...['review.html','review.css','review.js','review-data.json','review-manifest.json'].map(f=>['/'+f,path.join(root,f)])]);
 for(const f of ['building-model.mjs','building-view.mjs','registration.mjs'])routes.set('/'+f,path.join(repo,'backend/scripts/stanovanje-plus-review',f));
 for(const f of ['building-floor-plans.js','three-floor-plans.js','floor-plan-review-renderer.js'])routes.set('/shared/'+f,path.join(repo,'frontend/js',f));
 for(const i of items){
  if(!/^[a-z0-9-]+$/i.test(i.source.code))throw new Error('Invalid source code');
  routes.set('/source/'+i.source.code+'/source.png',path.join(root,i.source.code,'source.png'));
  routes.set('/model/'+i.source.code+'/building-outline.json',path.join(root,i.source.code,'building-outline.json'));
  for(const file of ['model.json','model.refined.json'])routes.set('/model/'+i.source.code+'/'+file,path.join(root,i.source.code,file));
 }
 return routes;
}
