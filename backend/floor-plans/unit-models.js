// Validates unit geometry independently of global registration and retains every model revision.
import { createRequire } from 'node:module';
import { fingerprint } from '../buildings/floor-models.js';
const require=createRequire(import.meta.url);
const {validateArchitecture}=require('../../frontend/js/building-floor-plans.js');
export function validateUnitModel(model) {
 const errors=validateArchitecture(model?.architecture);
 if(!model?.unitId || !model?.building?.id || !model?.building?.source) errors.push('Stable unit and building identities are required.');
 if(!/^[a-f0-9]{64}$/.test(model?.source?.sha256 || '')) errors.push('Source SHA-256 is required.');
 for(const key of ['url','listingUrl']) {try {if(!['https:','http:'].includes(new URL(model?.source?.[key]).protocol)) throw 0;}catch{errors.push(`Public source ${key} is required.`);}}
 if(model?.floor!==null && !Number.isInteger(model?.floor)) errors.push('Floor must be an integer or explicitly unknown.');
 if(model?.sourceFloorConflict && model.status!=='needs_review') errors.push('A source floor conflict requires review.');
 if(!['reviewed-local-geometry','needs_review'].includes(model?.status)) errors.push('Explicit local geometry review status is required.');
 if(!Array.isArray(model?.rooms)) errors.push('Rooms must be an array.');
 if(errors.length) throw new Error(errors.join('; '));
 return model;
}
export async function importUnitModels(db,document) {
 if(document?.schema!=='consensus-builder.unit-floor-models.v1' || !Array.isArray(document.units)) throw new Error('Expected unit-floor-models.v1 manifest.');
 const out=[];
 for(const model of document.units) {
  validateUnitModel(model);
  const hash=model.source.sha256,modelHash=fingerprint(model);
  await db.query('BEGIN');
  try {
   const existing=(await db.query(`SELECT e.model FROM floor_plan.extraction e JOIN floor_plan.target t ON t.current_sha256=e.sha256 WHERE e.sha256=$1 AND t.url=$2 AND t.kind='asset' FOR UPDATE OF e`,[hash,model.source.url])).rows[0];
   if(!existing) throw new Error(`Source is not archived at the declared URL: ${model.unitId}`);
   const changed=!existing.model || fingerprint(existing.model)!==modelHash;
   if(changed) {
    await db.query(`INSERT INTO floor_plan.model_revision(source_sha256,model_sha256,model) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[hash,modelHash,JSON.stringify(model)]);
    await db.query(`UPDATE floor_plan.extraction SET model=$2,status=$3,error=NULL,updated_at=now() WHERE sha256=$1`,[hash,JSON.stringify(model),model.status==='needs_review'?'needs_review':'reviewed']);
   }
   await db.query(`UPDATE floor_plan.listing SET building_id=$1,building_source=$2,match_status='verified',building_evidence=$3,updated_at=now()
      WHERE url=$4 OR asset_urls @> $5::jsonb`,[model.building.id,model.building.source,JSON.stringify({basis:'Explicit agency project and unit sheet inset',sourceUrl:model.source.url,unitId:model.unitId,floorConflict:model.sourceFloorConflict || null}),model.source.listingUrl,JSON.stringify([{url:model.source.url,listingOwned:true}])]);
   const saved=(await db.query('SELECT model FROM floor_plan.extraction WHERE sha256=$1',[hash])).rows[0];
   if(fingerprint(saved.model)!==modelHash) throw new Error(`Model read-back failed: ${model.unitId}`);
   await db.query('COMMIT');out.push({unitId:model.unitId,changed,status:model.status,modelHash});
  } catch(error) {await db.query('ROLLBACK');throw error;}
 }
 return {models:out};
}
