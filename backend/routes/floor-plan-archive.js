// Read-only access to public agency evidence, coverage, and separately reviewed unit geometry.
import { coverage } from '../floor-plans/archive.js';
export function setupFloorPlanArchiveRoute(app,pool) {
 const route=(path,handler)=>app.get(`/floor-plan-archive${path}`,async(req,res,next)=>{
  res.set('Cache-Control','no-store');
  try {await handler(req,res);} catch(error) {if(error.code==='42P01') return res.status(503).json({error:'Floor-plan archive has not been initialized.'});next(error);}
 });
 route('/status',async(_req,res)=>res.json({coverage:await coverage(pool),lastRun:(await pool.query('SELECT * FROM floor_plan.run ORDER BY created_at DESC LIMIT 1')).rows[0] || null}));
 route('/agencies',async(req,res)=>{
  const offset=Math.max(0,Number.parseInt(req.query.offset,10)||0),limit=Math.min(500,Math.max(1,Number.parseInt(req.query.limit,10)||100));
  res.json({agencies:(await pool.query(`SELECT registry_id,legal_name,registered_address,registry_source,registry_observed_at,website,website_status,website_evidence,COALESCE((SELECT jsonb_agg(jsonb_build_object('url',c.url,'sourceUrl',c.source_url)) FROM floor_plan.website_candidate c WHERE c.agency_id=floor_plan.agency.registry_id),'[]'::jsonb) AS candidate_websites FROM floor_plan.agency WHERE in_scope ORDER BY legal_name LIMIT $1 OFFSET $2`,[limit,offset])).rows});
 });
 route('/models',async(req,res)=>{
  const building=String(req.query.building || '').slice(0,255);
  const rows=(await pool.query(`SELECT sha256,status,model,updated_at FROM floor_plan.extraction WHERE model ? 'architecture' AND EXISTS(SELECT 1 FROM floor_plan.target t WHERE t.current_sha256=floor_plan.extraction.sha256 AND t.kind='asset') AND ($1='' OR model->'building'->>'id'=$1) ORDER BY model->>'unitId',sha256 LIMIT 100`,[building])).rows;
  res.json({models:rows});
 });
 route('/asset/:sha256',async(req,res)=>{
  if(!/^[a-f0-9]{64}$/.test(req.params.sha256)) return res.status(400).json({error:'Invalid source hash.'});
  const row=(await pool.query(`SELECT b.media_type,b.data FROM floor_plan.blob b JOIN floor_plan.extraction e USING(sha256) WHERE sha256=$1`,[req.params.sha256])).rows[0];
  if(!row) return res.status(404).json({error:'Source not found.'});
  const media=row.media_type.split(';')[0].toLowerCase();
  if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(media)) return res.status(415).json({error:'Source is not a displayable plan image or PDF.'});
  res.set('Content-Type',media).set('X-Content-Type-Options','nosniff').send(row.data);
 });
}
