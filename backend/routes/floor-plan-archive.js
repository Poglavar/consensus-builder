// Read-only access to public agency evidence, coverage, and separately reviewed unit geometry.
import { coverage } from '../floor-plans/archive.js';
import { buildingSummary, buildingView, catalogueCounts, sourceView } from '../floor-plan-archive/review-catalogue.js';
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
 route('/catalogue',async(_req,res)=>{
  const buildings=(await pool.query(`SELECT id,owner_id, floor_plans#>>'{floors,0,id}' AS first_floor,
   jsonb_array_length(floor_plans->'floors') AS floor_count, footprint IS NOT NULL AS has_footprint
   FROM consensus.building_floor_model WHERE current ORDER BY id`)).rows.map(buildingSummary);
  const units=(await pool.query(`SELECT count(*)::int AS count FROM floor_plan.extraction e
   WHERE model ? 'architecture' AND model->'building'->>'id'='avenue-v'
   AND EXISTS(SELECT 1 FROM floor_plan.target t WHERE t.current_sha256=e.sha256 AND t.kind='asset')`)).rows[0].count;
  const hasLandmark=(await pool.query(`SELECT EXISTS(SELECT 1 FROM buildings.landmark_mesh WHERE landmark_id='avenue-v') AS available`)).rows[0].available;
  if(units) buildings.unshift({id:'avenue-v',name:'Avenue V',kind:'units',planCount:units,locationAvailable:hasLandmark,wholeBuildingAvailable:hasLandmark});
  const sourceRows=(await pool.query(`SELECT DISTINCT ON (e.sha256) e.sha256,e.status,
   e.model ? 'architecture' AS architecture_available,
   COALESCE(e.model->'source'->>'url',t.url) AS source_url,
   e.model->'source'->>'label' AS label,b.media_type
   FROM floor_plan.extraction e JOIN floor_plan.blob b USING(sha256)
   JOIN floor_plan.target t ON t.current_sha256=e.sha256 AND t.kind='asset'
   WHERE lower(split_part(b.media_type,';',1)) IN ('image/jpeg','image/png','image/webp','application/pdf')
   ORDER BY e.sha256,t.updated_at DESC`)).rows;
  const sources=sourceRows.map(row=>({...sourceView(row),architectureAvailable:Boolean(row.architecture_available)}))
   .sort((a,b)=>a.label.localeCompare(b.label)||a.sha256.localeCompare(b.sha256));
  res.json({buildings,sources,counts:catalogueCounts(buildings,sources)});
 });
 route('/building/:id',async(req,res)=>{
  if(req.params.id==='avenue-v') {
   const units=(await pool.query(`SELECT e.sha256,e.status,e.model,b.media_type FROM floor_plan.extraction e JOIN floor_plan.blob b USING(sha256)
    WHERE e.model ? 'architecture' AND e.model->'building'->>'id'='avenue-v'
    AND EXISTS(SELECT 1 FROM floor_plan.target t WHERE t.current_sha256=e.sha256 AND t.kind='asset')
    ORDER BY e.model->>'unitId'`)).rows;
   if(!units.length) return res.status(404).json({error:'Building not found.'});
   const mesh=(await pool.query(`SELECT ST_AsGeoJSON(ST_Transform(ST_Envelope(ST_Collect(geom2d)),4326),7) AS footprint,
    ST_X(ST_Transform(ST_Centroid(ST_Collect(geom2d)),4326)) AS longitude,
    ST_Y(ST_Transform(ST_Centroid(ST_Collect(geom2d)),4326)) AS latitude FROM buildings.landmark_mesh WHERE landmark_id='avenue-v'`)).rows[0];
   return res.json({id:'avenue-v',name:'Avenue V',kind:'units',footprint:mesh?.footprint ? JSON.parse(mesh.footprint) : null,
    location:mesh?.longitude == null ? null : {longitude:mesh.longitude,latitude:mesh.latitude,basis:'landmark-mesh'},
    plans:units.map(({model,sha256,media_type,status})=>({id:model.unitId,label:`${model.unitId} · ${model.floor??'?'}`,reviewStatus:status,level:model.floor,
     architecture:model.architecture,source:model.source,archivedSha256:sha256,mediaType:media_type,
     rooms:model.rooms,physicalNetAreaM2:model.physicalNetAreaM2,areaM2:model.areaM2,sourceFloorConflict:model.sourceFloorConflict})),
    wholeBuilding:mesh?.footprint?{type:'landmark',url:'/floor-plan-archive/building/avenue-v/mesh'}:null});
  }
  const match=/^registered-(\d+)$/.exec(req.params.id);
  if(!match) return res.status(400).json({error:'Invalid building id.'});
  const row=(await pool.query(`SELECT id,owner_id,building_id,footprint,floor_plans FROM consensus.building_floor_model WHERE id=$1 AND current`,[match[1]])).rows[0];
  if(!row) return res.status(404).json({error:'Building not found.'});
  res.json(buildingView(row));
 });
 route('/building/avenue-v/mesh',async(_req,res)=>{
  const rows=(await pool.query(`SELECT ground_z_m,ST_AsGeoJSON(ST_Transform(shape,4326),7) AS geometry,color_hex,material_kind
   FROM buildings.landmark_mesh WHERE landmark_id='avenue-v' ORDER BY part_index`)).rows;
  if(!rows.length) return res.status(404).json({error:'Building mesh not found.'});
  res.json({groundZ:rows[0]?.ground_z_m ?? null,parts:rows.map(row=>({geometry:row.geometry ? JSON.parse(row.geometry) : null,color:row.color_hex,materialKind:row.material_kind}))});
 });
 route('/source/:sha256',async(req,res)=>{
  if(!/^[a-f0-9]{64}$/.test(req.params.sha256)) return res.status(400).json({error:'Invalid source hash.'});
  const row=(await pool.query(`SELECT e.sha256,e.status,e.model,b.media_type,t.url AS source_url FROM floor_plan.extraction e JOIN floor_plan.blob b USING(sha256) LEFT JOIN floor_plan.target t ON t.current_sha256=e.sha256 AND t.kind='asset' WHERE e.sha256=$1 LIMIT 1`,[req.params.sha256])).rows[0];
  if(!row) return res.status(404).json({error:'Source not found.'});
  res.json({...sourceView(row),model:row.model || null});
 });
}
