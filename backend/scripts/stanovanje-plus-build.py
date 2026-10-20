# Apply checkpointed semantic readings to exact source polygons; never calls an LLM or database.
import json,math,time,hashlib
from pathlib import Path
from shapely.geometry import Polygon,LineString
from shapely.ops import unary_union
ROOT=Path(__file__).resolve().parents[1]/'logs/stanovanje-plus-ten-20261019'
def polys(g):
 if g.is_empty:return []
 if g.geom_type=='Polygon':return [g]
 if hasattr(g,'geoms'):return [p for x in g.geoms for p in polys(x)]
 return []
def compile_model(source,evidence,reading):
 if reading['code']!=source['code']:raise ValueError('Wrong source identity')
 all_layers=set(evidence['layers']);selected=set(reading['wallFillLayers']);outlines=set(reading['wallClosedOutlineLayers'])
 if not selected|outlines or not (selected|outlines)<=all_layers:raise ValueError('Invalid layer selection')
 exclude=set(reading['excludePathIds']);known={p['id'] for p in evidence['paths']}
 if not exclude<=known:raise ValueError('Unknown excluded path')
 walls=[];used=[];rejected=[]
 for path in evidence['paths']:
  if path['id'] in exclude:continue
  filled=path['layer'] in selected and path['fill']!='none'
  outline=path['layer'] in outlines
  if not filled and not outline:continue
  for i,s in enumerate(path['subpaths']):
   if len(s['points'])<3 or (not filled and not s['closed']):continue
   p=Polygon(s['points'])
   if p.area<1e-6:continue
   if not p.is_valid:
    rejected.append(path['id']+':'+str(i));continue
   walls.append(p);used.append(path['id']+':'+str(i))
 if not walls:raise ValueError('No measured wall solids')
 wall=unary_union(walls)
 # GEOS overlay can create microscopic components at shared triangle boundaries.
 # Omit only sub-1e-5 source-unit² components and retain their area in diagnostics.
 slivers=[p for p in polys(wall) if p.area<1e-5]
 wall=unary_union([p for p in polys(wall) if p.area>=1e-5])
 smallholes=[Polygon(r) for p in polys(wall) for r in p.interiors if Polygon(r).area<1e-5]
 slabs=[]
 for p in reading['footprint']:
  poly=Polygon(p['outer'],p['holes'])
  if not poly.is_valid or poly.area<=0:raise ValueError('Invalid/self-intersecting source outline')
  slabs.append(poly)
 slab=unary_union(slabs)
 scale=reading['scale']
 if not scale or not isinstance(scale['lengthM'],(int,float)) or scale['lengthM']<=0 or not scale['quote']:raise ValueError('No documented metric scale')
 span=math.dist(scale['a'],scale['b'])
 if span<=0:raise ValueError('Zero scale span')
 m=scale['lengthM']/span
 xmin,ymin,xmax,ymax=unary_union([wall,slab]).bounds;w=xmax-xmin;h=ymax-ymin
 def uv(p):return [round((p[0]-xmin)/w,8),round((p[1]-ymin)/h,8)]
 def rings(p):return [[uv(x) for x in list(p.exterior.coords)[:-1]]]+[[uv(x) for x in list(r.coords)[:-1]] for r in p.interiors if Polygon(r).area>=1e-5]
 architecture={'schema':'consensus-builder.floor-architecture.v1','dimensionsM':[round(w*m,5),round(h*m,5)],'wallHeightM':2.7,'slabThicknessM':.2,'walls':[rings(p) for p in polys(wall)],'slabs':[rings(p) for p in polys(slab)],'landings':[],'openings':[],'stairs':[],'railings':[]}
 for o in reading['openings']:
  if math.dist(o['a'],o['b'])<.1:continue
  architecture['openings'].append({'kind':o['kind'],'a':uv(o['a']),'b':uv(o['b']),'depthM':.2,'sillM':.9 if o['kind']=='window' else 0,'heightM':1.4 if o['kind']=='window' else 2.1})
 outside=wall.difference(slab).area/wall.area
 footprintArea=slab.area*m*m;wallArea=wall.area*m*m
 issues=list(reading['issues'])
 issues+=['Private draft: no verified geographic registration.','Footprint and opening coordinates estimated visually against the source grid; wall solids use measured SVG polygons.','Heights estimated: walls 2.70 m; slab 0.20 m; openings 0.90/1.40 m windows, 2.10 m doors.']
 if outside>.01:issues.append(f'{outside*100:.2f}% of source wall area falls outside the estimated slab outline; review required.')
 if smallholes:issues.append(f'{len(smallholes)} microscopic overlay holes below 1e-5 source-unit² omitted; total area recorded in diagnostics.')
 if slivers:issues.append(f'{len(slivers)} microscopic GEOS overlay components below 1e-5 source-unit² omitted; total area recorded in diagnostics.')
 if rejected:issues.append(f'{len(rejected)} invalid source polygon subpaths omitted and listed in extraction diagnostics.')
 return {'schema':'consensus-builder.processed-floor-plan.v1','unitId':source.get('unitId', source['code']+'-tl-kk1'),'label':source['title']+' — '+reading['floorLabel'],'scope':'floor','floor':None,'elevationM':None,'elevationBasis':None,'building':None,'rooms':[],'architecture':architecture,'source':{'url':source['sourceUrl'],'sha256':source['sourceSha256'],'sourceFrame':[xmin,ymin,w,h],'viewBox':evidence['viewBox'],'metersPerSourceUnit':m,'scale':scale,'scaleBasis':'visually-read-printed-scale-bar','scaleEstimated':True,'wallFillLayers':reading['wallFillLayers'],'wallClosedOutlineLayers':reading['wallClosedOutlineLayers'],'sourceFootprint':reading['footprint'],'footprintEvidence':reading['footprintEvidence'],'registration':None},'provenance':{'processor':'stanovanje-plus-ten-private-v1','model':'gpt-6.1-sol','effort':'medium','coverage':reading['coverage'],'confidence':reading['confidence'],'reviewStatus':'unreviewed-private-draft'},'issues':issues,'extraction':{'selectedSourceSubpaths':len(used),'sourceSubpathIds':used,'invalidSourceSubpaths':rejected,'numericalHolesOmitted':len(smallholes),'numericalHoleAreaSourceUnits2':sum(p.area for p in smallholes),'numericalSliversOmitted':len(slivers),'numericalSliverAreaSourceUnits2':sum(p.area for p in slivers),'wallPolygons':len(polys(wall)),'footprintAreaM2':round(footprintArea,2),'wallAreaM2':round(wallArea,2),'wallFraction':round(wallArea/footprintArea,4),'wallOutsideSlabFraction':round(outside,5)}}
if __name__=='__main__':
 results=[]
 for s in json.loads((ROOT/'selection.json').read_text()):
  d=ROOT/s['code'];response=d/'response.json'
  if not response.exists():results.append({'code':s['code'],'status':'missing-response'});continue
  try:
   r=json.loads(response.read_text());model=compile_model(s,json.loads((d/'evidence.json').read_text()),r['data'])
   model['accounting']={k:r.get(k) for k in ['model','usage','equivalentUsd','costUsd','ms','raw']}
   (d/'model.json').write_text(json.dumps(model,ensure_ascii=False,indent=2))
   results.append({'code':s['code'],'title':s['title'],'status':'built-awaiting-validation','extraction':model['extraction'],'usage':r['usage'],'equivalentUsd':r['equivalentUsd'],'costUsd':r['costUsd'],'ms':r['ms'],'issues':model['issues']})
  except Exception as e:
   results.append({'code':s['code'],'status':'build-failed','error':str(e)})
 (ROOT/'build-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps([{k:v for k,v in r.items() if k in ['code','status','error']} for r in results]))
