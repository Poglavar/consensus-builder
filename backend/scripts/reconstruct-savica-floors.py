#!/usr/bin/env python3
"""Rebuild the reviewed Savica office and shared basement traces as architectural solids.

Requires PyMuPDF and Shapely. Source PDFs are checksum-verified before using the
reviewed pixel annotations. No room layout is inferred from the furniture-free plans.
"""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sys
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from pionir_floor_architecture import pieces, strip

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / 'rekonstrukcije/pionir-paron/savica-f1-f3'
spec = importlib.util.spec_from_file_location('reconstruction', Path(__file__).with_name('reconstruct-borongaj-floors.py'))
rec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rec)

def build_offices(feature, sources):
    # All eight source pages align after translation. The reference is the 1st floor.
    frame=[4,34,1158,1384];W,H=frame[2]-frame[0],frame[3]-frame[1]
    refcrop=[470+frame[0]/2,70+frame[1]/2,470+frame[2]/2,70+frame[3]/2]
    reg=rec.registration(feature,{'id':'F3','northInDrawing':'up','floors':[{'source':{'crop':refcrop},'level':1}]});scale=reg['metresPerPdfPoint']/2
    reg['basis']='Uniform-scale fit of the published F3 L-shaped floor outline to the oriented DGU footprint; the north symbol fixes rotation.'
    print('Registered F3 office outline', flush=True)
    uv=lambda p:[round((p[0]-frame[0])/W,6),round((p[1]-frame[1])/H,6)]
    outline=Polygon([(4,34),(1158,34),(1158,1384),(614,1384),(614,568),(4,568)])
    # Filled rectangle columns, traced from the same repeated structural grid on all source sheets.
    columns=[(x,147,x+15,193) for x in [199,360,522,970]]+[(970,256,985,303)]+[(x,362,x+15,408) for x in [199,360]]
    columns += [(756,348,802,363)]+[(x,y,x+46,y+15) for y in [472,625,784,943,1102] for x in [756,970]]+[(756,1258,802,1273)]
    # Source hollow lift shafts have sliding leaves, represented separately from their perimeter walls.
    def rectwall(a,b,c,d,t):return box(a,b,c,d).difference(box(a+t,b+t,c-t,d-t))
    def build(level):
     walls=[];openings=[];flights=[];platforms=[];voids=[];rails=[]
     slab=outline
     body=box(4,34,1158,568) if level==7 else outline
     walls.append(body.boundary.buffer(13,join_style='mitre').intersection(body))
     # West staircase enclosure and service/lift/stair core along the northern facade.
     walls += [box(119,47,130,192),box(18,186,130,193),box(573,47,615,219),box(849,47,892,219),box(616,47,628,173),box(839,47,851,173),box(628,212,839,220)]
     walls += [rectwall(670,94,796,171,9),box(729,98,738,170),rectwall(519,343,639,517,12),box(523,425,637,435)]
     walls += [box(*r) for r in columns if level!=7 or r[1]<560]
     if level!=7:walls += [box(970,1263,1145,1275),box(986,1275,993,1370)]
     def opening(a,b,kind='window',hinge=None,tip=None,depth=13,sill=.85,height=1.45):
      o={'a':a,'b':b,'kind':kind,'depthM':depth*scale,'sillM':sill,'heightM':height,'basis':'Reviewed published raster plan; vertical dimensions and glazing type inferred'}
      if kind=='door':o.update(hinge=hinge or a,openTip=tip or (a[0],a[1]-math.dist(a,b)))
      openings.append(o)
     # Thin parallel strokes in the exterior wall give these window-bank extents.
     for a,b in [(154,208),(239,292),(324,377),(410,463),(496,548),(665,717),(750,802),(919,972),(1005,1057)]:opening((a,40.5),(b,40.5))
     for a,b in [(139,163),(225,275),(311,360),(397,446)]:opening((10.5,a),(10.5,b))
     for a,b in [(124,178),(209,262),(294,347),(378,433),(464,518)]:opening((a,561.5),(b,561.5))
     for a,b in [(142,194),(227,279),(312,364),(397,450),(482,535),(567,620),(652,705),(737,790),(823,875),(907,960),(993,1045),(1078,1130),(1163,1216)]:
      if level!=7 or b<567:opening((1151.5,a),(1151.5,b))
     if level!=7:
      for a,b in [(697,751),(782,836),(867,921),(952,1006),(1038,1091),(1123,1176),(1208,1261)]:opening((620.5,a),(620.5,b))
      for a,b in [(744,796),(829,881),(914,966),(1027,1051)]:opening((a,1377.5),(b,1377.5))
     else:
      # Roof terrace is drawn, not an eighth full office wing.
      for a,b in [(665,717),(750,802),(919,972),(1005,1057)]:opening((a,561.5),(b,561.5),'glazedDoor',sill=0,height=2.3)
      rails=[{'a':(620,568),'b':(620,1378),'heightM':1.05},{'a':(620,1378),'b':(1151,1378),'heightM':1.05},{'a':(1151,1378),'b':(1151,568),'heightM':1.05}]
     # Swing leaves and lift doors are directly located by the source symbols.
     opening((87,189.5),(118,189.5),'door',hinge=(118,189.5),tip=(118,158.5),sill=0,height=2.1,depth=7)
     for a,b,hinge,tip in [((727,216),(752,216),(727,216),(727,191)),((752,216),(778,216),(778,216),(778,190))]:opening(a,b,'door',hinge,tip,depth=8,sill=0,height=2.1)
     for a,b in [((681,168),(728,168)),((739,168),(786,168)),((633,375),(633,418)),((633,443),(633,486))]:opening(a,b,'slidingDoor',depth=12,sill=0,height=2.1)
     if level!=7:opening((989.5,1275),(989.5,1309),'door',hinge=(989.5,1275),tip=(1023.5,1275),depth=7,sill=0,height=2.1)
     if level==0:
      # Ground-floor entrance hall separates PP1A/PP1B, with its vestibule at the inner corner.
      walls += [box(623,218,630,344),box(623,517,630,566),box(811,220,818,665),box(628,658,818,666),box(693,559,701,665)]
      opening((626.5,254),(626.5,300),'door',hinge=(626.5,254),tip=(580.5,254),depth=7,sill=0,height=2.1)
      opening((814.5,254),(814.5,300),'door',hinge=(814.5,254),tip=(860.5,254),depth=7,sill=0,height=2.1)
      opening((620.5,593),(620.5,640),'glazedDoor',depth=13,sill=0,height=2.3)
      opening((637,562),(680,562),'door',hinge=(680,562),tip=(680,519),depth=8,sill=0,height=2.1)
      opening((678,40.5),(726,40.5),'glazedDoor',depth=13,sill=0,height=2.3)
      opening((10.5,141),(10.5,166),'door',hinge=(10.5,166),tip=(35.5,166),depth=13,sill=0,height=2.1)
     # Three measured runs around each stair void; risers divide an estimated 3 m storey.
     def stair_group(runs,landing_rings,void):
      total=sum(s[3] for s in runs);step=0
      for a,b,width,n in runs:
       flights.append({'a':a,'b':b,'widthM':width*scale,'steps':n,'fromM':3*step/total,'toM':3*(step+n)/total});step+=n
      step=0
      for i,ring in enumerate(landing_rings):
       step+=runs[i][3];platforms.append({'rings':[ring],'elevationM':3*step/total})
      voids.append(Polygon(void))
     stair_group([((99,151),(99,85),36,9),((81,66),(55,66),36,4),((36,85),(36,151),36,9)],
                 [[(81,48),(118,48),(118,85),(81,85)],[(18,48),(55,48),(55,85),(18,85)]],[(18,48),(118,48),(118,156),(18,156)])
     stair_group([((819,154),(819,95),40,8),((760,75),(705,75),36,8),((648,95),(648,154),40,8)],
                 [[(760,49),(839,49),(839,95),(760,95)],[(628,49),(705,49),(705,95),(628,95)]],[(628,48),(839,48),(839,161),(628,161)])
     if level!=7:
      stair_group([((1049,1349),(1105,1349),37,9),((1125,1331),(1125,1313),36,3),((1105,1294),(1049,1294),37,9)],
                  [[(1105,1331),(1144,1331),(1144,1370),(1105,1370)],[(1105,1275),(1144,1275),(1144,1313),(1105,1313)]],[(1027,1275),(1145,1275),(1145,1370),(1027,1370)])
     walls=unary_union(walls).intersection(outline)
     cuts=[strip(o['a'],o['b'],o['depthM']/scale+4) for o in openings]
     walls=walls.difference(unary_union(cuts))
     slab=slab.difference(unary_union(voids+[box(535,358,623,425),box(535,435,623,501)]))
     def polys(g):return [[[uv(p) for p in list(r.coords)[:-1]] for r in [poly.exterior,*poly.interiors]] for poly in pieces(g,'Polygon') if poly.area>1]
     def points(d):return {k:uv(v) if k in ['a','b','hinge','openTip'] else round(v,5) if isinstance(v,float) else v for k,v in d.items()}
     return {'schema':'consensus-builder.floor-architecture.v1','dimensionsM':[round(W*scale,4),round(H*scale,4)],'wallHeightM':2.8,'slabThicknessM':.2,'walls':polys(walls),'slabs':polys(slab),'openings':[points(o) for o in openings],'stairs':[points(f) for f in flights],'landings':[],'platforms':[{'rings':[[uv(p) for p in ring] for ring in q['rings']],'elevationM':q['elevationM']} for q in platforms],'railings':[points(r) for r in rails],'inference':{'wallFootprints':'reviewed raster wall and column traces','openings':'reviewed window strokes, door swings and lift shaft entries','verticalDimensions':'estimated','stairRise':'measured tread counts divide an estimated 3 m storey','coverage':'open office on levels 0–6; level 7 northern office with southern roof terrace'},'quality':{'floorAreaM2':round(outline.area*scale**2,2),'wallAreaM2':round(walls.area*scale**2,2),'modelledOpenings':len(openings)}}
    layouts=[];floors=[]
    shifts=[12,0,17,5,13,11,9,4]
    for level in range(8):
     source=dict(sources[level]); source['crop']=[refcrop[0]+shifts[level]/2,refcrop[1],refcrop[2]+shifts[level]/2,refcrop[3]]; source['method']='reviewed raster trace; source frame translated to the common building coordinates'
     model=build(level);layouts.append({'id':f'F3-layout-{level}','source':source,'architecture':model});floors.append({'id':f'F3-floor-{level}','level':level,'elevationM':level*3,'elevationBasis':'estimated','layoutId':f'F3-layout-{level}','source':source,'apartments':[]})
    plans={'schema':'consensus-builder.building-floor-plans.v2','registration':reg,'layouts':layouts,'floors':floors,'notes':['Published office catalogue, not an as-built survey.','All storey heights, window sills/heads and lift-door construction are estimates.','Furniture-free open office areas follow the raster drawing; dashed service clearance zones are not walls.']}
    print('wrote',len(floors),'floor models',flush=True)
    # Check registration against the entire L shape, not merely its bounding rectangle.
    cs=reg['corners'];lnglat=lambda p:[(1-p[0])*(1-p[1])*cs[0][k]+p[0]*(1-p[1])*cs[1][k]+p[0]*p[1]*cs[2][k]+(1-p[0])*p[1]*cs[3][k] for k in [0,1]]
    traced=Polygon([lnglat(uv(p)) for p in list(outline.exterior.coords)]);target=Polygon(feature['geometry']['coordinates'][0][0]);overlap=traced.intersection(target).area/traced.union(target).area
    if overlap < .95: raise ValueError('F3 footprint no longer matches reviewed source outline')
    return plans

def append_basement(plans, trace, source):
    cs=plans['registration']['corners']
    frame=trace['pixelFrame'];W,H=frame[2]-frame[0],frame[3]-frame[1];anchor=trace['F3Anchor']
    fx=(anchor[2]-anchor[0])/W;fy=(anchor[3]-anchor[1])/H
    lnglat=lambda u,v:[(1-u)*(1-v)*cs[0][k]+u*(1-v)*cs[1][k]+u*v*cs[2][k]+(1-u)*v*cs[3][k] for k in [0,1]]
    plans['registration']['corners']=[lnglat(u,v) for u,v in [(0,0),(1/fx,0),(1/fx,1/fy),(0,1/fy)]]
    plans['registration']['basis']='F3 catalogue outline fitted to its oriented DGU footprint; the connected F1/F2/F3 basement is registered by that same F3 outline and drawn once under F3.'
    plans['registration']['sharedBasementBuildingIds']=['dgu-building:13350652','dgu-building:13086209','dgu-building:13086210']
    for l in plans['layouts']:
     a=l['architecture'];a['dimensionsM']=[a['dimensionsM'][0]/fx,a['dimensionsM'][1]/fy]
     def point(p):return [round(p[0]*fx,7),round(p[1]*fy,7)]
     for kind in ['walls','slabs','landings']:a[kind]=[[[point(p) for p in ring] for ring in poly] for poly in a[kind]]
     for plat in a.get('platforms',[]):plat['rings']=[[point(p) for p in ring] for ring in plat['rings']]
     for kind in ['openings','stairs','railings']:
      for obj in a[kind]:
       for k in ['a','b','hinge','openTip']:
        if k in obj:obj[k]=point(obj[k])
     l['source']['commonFrameTransform']={'offset':[0,0],'scale':[fx,fy]}
    width,height=plans['layouts'][0]['architecture']['dimensionsM'];scale=width/W
    uv=lambda p:[round((p[0]-frame[0])/W,7),round((p[1]-frame[1])/H,7)]
    outline=Polygon(trace['outline']).buffer(0)
    sourcepolys=trace['wallPolygons']
    walls=unary_union([Polygon(p[0],p[1:]).buffer(0) for p in sourcepolys]).intersection(outline)
    # Close only the continuous perimeter stroke; internal parking lines remain unextruded.
    walls=unary_union([walls,outline.difference(outline.buffer(-8,join_style='mitre'))])
    # Treads and arrows are separate geometry, never wall polygons.
    voids=[box(30,62,130,130),box(1061,1295,1135,1376),box(1960,700,2042,765),box(2960,700,3042,765)]
    walls=walls.difference(unary_union(voids));slab=outline.difference(unary_union(voids))
    openings=[]
    def door(a,b,hinge,tip,kind='door'):
     o={'kind':kind,'a':a,'b':b,'depthM':.25,'sillM':0,'heightM':2.1,'basis':'Published basement door symbol; leaf construction/head inferred'}
     if kind=='door':o.update(hinge=hinge,openTip=tip)
     openings.append(o)
    # Personnel doors in the four stair/lift service cores.
    for a,b,h,t in [((96,202),(126,202),(126,202),(126,172)),((788,210),(820,210),(820,210),(820,178)),((848,198),(875,198),(848,198),(848,171)),((972,96),(972,124),(972,96),(1000,96)),((799,418),(799,447),(799,418),(770,418)),((976,1343),(1004,1343),(976,1343),(976,1315)),((1924,875),(1951,875),(1951,875),(1951,848)),((3018,875),(3046,875),(3018,875),(3018,847))]:door(a,b,h,t)
    # The source has four lift shafts in F3 and one in each residential core.
    for a,b in [((700,164),(738,164)),((752,164),(790,164)),((638,370),(638,406)),((638,450),(638,486)),((1904,683),(1943,683)),((3088,683),(3127,683))]:door(a,b,None,None,'slidingDoor')
    wallcuts=[strip(o['a'],o['b'],o['depthM']/scale+3) for o in openings];walls=walls.difference(unary_union(wallcuts))
    flights=[];platforms=[]
    def pair(x,y,w,h,n=9):
     # Each reviewed U-stair uses two opposite flights and an intermediate landing.
     flights.extend([{'a':(x+w*.25,y+h),'b':(x+w*.25,y),'widthM':w*.42*scale,'steps':n,'fromM':0,'toM':1.5},{'a':(x+w*.75,y),'b':(x+w*.75,y+h),'widthM':w*.42*scale,'steps':n,'fromM':1.5,'toM':3}])
     platforms.append({'rings':[[(x,y-22),(x+w,y-22),(x+w,y),(x,y)]],'elevationM':1.5})
    for args in [(31,82,98,48),(1062,1310,72,60),(1962,716,78,46),(2962,716,78,46)]:pair(*args)
    def polys(g):return [[[uv(p) for p in list(r.coords)[:-1]] for r in [poly.exterior,*poly.interiors]] for poly in pieces(g,'Polygon') if poly.area>2]
    def pointobj(o):return {k:uv(v) if k in ['a','b','hinge','openTip'] else v for k,v in o.items()}
    model={'schema':'consensus-builder.floor-architecture.v1','dimensionsM':[width,height],'wallHeightM':2.8,'slabThicknessM':.2,'walls':polys(walls),'slabs':polys(slab),'openings':[pointobj(o) for o in openings],'stairs':[pointobj(f) for f in flights],'landings':[],'platforms':[{'rings':[[uv(p) for p in r] for r in q['rings']],'elevationM':q['elevationM']} for q in platforms],'railings':[],'inference':{'wallFootprints':'reviewed raster wall mask, thick neutral strokes; text and parking lines excluded','verticalDimensions':'estimated 3 m basement storey','coverage':'shared F1/F2/F3 basement, stored once under F3','ramp':'ramp outline retained in slab; its undocumented vertical profile is not reconstructed'},'quality':{'floorAreaM2':round(outline.area*scale**2,2),'wallAreaM2':round(walls.area*scale**2,2),'modelledOpenings':len(openings)}}
    source=dict(source); source['crop']=[55+frame[0]/4,250+frame[1]/4,55+frame[2]/4,250+frame[3]/4]; source['method']='reviewed raster mask and traced service cores'
    plans['layouts'].insert(0,{'id':'F3-shared-basement','source':source,'architecture':model});plans['floors'].insert(0,{'id':'F3-floor--1','level':-1,'elevationM':-3,'elevationBasis':'estimated','layoutId':'F3-shared-basement','source':source,'apartments':[]})
    plans['notes'].append('The connected basement spans F1/F2/F3 and is owned once by F3; ramp elevation, drainage and fixtures are not documented in the catalogue.')
    print(model['quality'],len(model['walls']),'floors',len(plans['floors']))
    return plans

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir',type=Path,required=True)
    parser.add_argument('--sources',type=Path,default=PROJECT/'floor-plan-sources.json')
    parser.add_argument('--traces',type=Path,default=PROJECT/'floor-plan-traces.json')
    parser.add_argument('--proposal',type=Path,default=PROJECT/'proposal.geojson')
    parser.add_argument('--write',action='store_true')
    parser.add_argument('--fetch',action='store_true',help='Download missing PDFs and verify their recorded checksums')
    if len(sys.argv)==1: parser.print_help(); return
    args=parser.parse_args()
    sources={f['level']:f['source'] for f in json.loads(args.sources.read_text())['buildings'][0]['floors']}
    for source in sources.values(): rec.source_file(source,args.cache_dir,args.fetch)
    trace=json.loads(args.traces.read_text())
    if trace['sourceSha256'] != sources[-1]['sha256']: raise ValueError('Raster trace source changed')
    archive=json.loads(args.proposal.read_text())
    feature=next(f for f in archive['features'] if f['properties'].get('name')=='F3')
    plans=append_basement(build_offices(feature,sources),trace,sources[-1])
    # Different source sheets can corroborate one identical structural layout.
    unique={}; layouts=[]
    for layout in plans['layouts']:
        key=json.dumps(layout['architecture'],sort_keys=True,separators=(',',':'))
        if key in unique:
            for floor in plans['floors']:
                if floor['layoutId']==layout['id']: floor['layoutId']=unique[key]
        else: unique[key]=layout['id']; layouts.append(layout)
    plans['layouts']=layouts
    feature['properties']['floorPlans']=plans
    if args.write:
        text=json.dumps(archive,ensure_ascii=False,indent=2)+'\n'
        text=re.sub(r'\[\n\s+(-?\d+(?:\.\d+)?),\n\s+(-?\d+(?:\.\d+)?)\n\s+\]',r'[\1, \2]',text)
        temporary=args.proposal.with_suffix('.geojson.part');temporary.write_text(text);temporary.replace(args.proposal)
    print(f"{'Wrote' if args.write else 'Validated'} {len(plans['floors'])} floors, {len(layouts)} layouts.")

if __name__=='__main__': main()
