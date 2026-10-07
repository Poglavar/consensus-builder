#!/usr/bin/env python3
"""Recover reviewed ViD Park unit wall fills from public raster sheets, retaining source conflicts.

Sheet coordinates are authoring controls, never cadastral measurements. Pixel segmentation
preserves printed openings; vertical dimensions are explicit estimates. No missing unit,
corridor, lift or garage is synthesized. Requires OpenCV and NumPy.
"""
import argparse, hashlib, json
from pathlib import Path
import cv2
import numpy as np

ROOT=Path(__file__).resolve().parents[2]

def reconstruct(unit,cache,qa):
    path=cache/unit['file']
    if hashlib.sha256(path.read_bytes()).hexdigest()!=unit['sha256']:
        raise ValueError(f"Source hash mismatch: {unit['id']}")
    original=cv2.imread(str(path))
    width=unit['reviewWidthPx']
    im=cv2.resize(original,(width,round(original.shape[0]*width/original.shape[1])))
    b,g,r=cv2.split(im.astype(np.int16))
    mask=((g-r>=12)&(b-r>=7)&(r<140)&(g<170)).astype(np.uint8)*255
    frame=np.zeros(mask.shape,np.uint8)
    outline=np.array(unit['outlinePx'],np.int32)
    cv2.fillPoly(frame,[outline],255)
    mask=cv2.bitwise_and(mask,frame)
    for ax,ay,bx,by in unit.get("excludeWallRectsPx",[]):
        mask[ay:by,ax:bx]=0
    contours,hierarchy=cv2.findContours(mask,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    x0,y0=outline.min(axis=0); x1,y1=outline.max(axis=0)
    def uv(points):
        return [[round(float((x-x0)/(x1-x0)),7),round(float((y-y0)/(y1-y0)),7)] for x,y in points]
    walls=[];accepted=[]
    for i,contour in enumerate(contours):
        if hierarchy[0][i][3]!=-1: continue
        x,y,w,h=cv2.boundingRect(contour)
        if cv2.contourArea(contour)<50 or max(w,h)<24: continue
        polygon=[cv2.approxPolyDP(contour,0.65,True).reshape(-1,2)]
        child=hierarchy[0][i][2]
        while child!=-1:
            if cv2.contourArea(contours[child])>=5:
                polygon.append(cv2.approxPolyDP(contours[child],0.65,True).reshape(-1,2))
            child=hierarchy[0][child][0]
        polygon=[ring for ring in polygon if len(ring)>=3]
        walls.append([uv(ring) for ring in polygon]);accepted.extend(polygon)
    if not walls: raise ValueError('No source wall fills found')
    meters_per_pixel=unit['scaleBarMeters']/(unit['scaleBarPx'][1]-unit['scaleBarPx'][0])
    architecture={'schema':'consensus-builder.floor-architecture.v1',
      'dimensionsM':[round(float((x1-x0)*meters_per_pixel),4),round(float((y1-y0)*meters_per_pixel),4)],
      'wallHeightM':3.1,'slabThicknessM':0.2,'walls':walls,'slabs':[[uv(outline)]],
      'openings':[],'stairs':[],'landings':[],'railings':[],
      'notes':'Wall footprints extracted from reviewed green CAD fills; glazing and opening heights are inferred. Unknown common areas are absent.'}
    for opening in unit.get('openingsPx',[]):
        item={k:v for k,v in opening.items() if k not in ['a','b','hinge','openTip']}
        for key in ['a','b','hinge','openTip']:
            if key in opening: item[key]=uv([opening[key]])[0]
        item.update({'depthM':0.12,'sillM':0.0 if opening['kind']!='window' else 0.9,'heightM':2.1 if opening['kind']!='window' else 1.5})
        architecture['openings'].append(item)
    for a,b in unit.get('railingsPx',[]):
        architecture['railings'].append({'a':uv([a])[0],'b':uv([b])[0],'heightM':1.1})
    overlay=im.copy();cv2.polylines(overlay,accepted,True,(225,35,235),2)
    cv2.polylines(overlay,[outline],True,(245,150,0),1)
    for opening in unit.get('openingsPx',[]):
        cv2.line(overlay,tuple(opening['a']),tuple(opening['b']),(255,140,0),2)
        if opening.get('hinge') and opening.get('openTip'):
            cv2.line(overlay,tuple(opening['hinge']),tuple(opening['openTip']),(0,100,255),2)
    qa.mkdir(parents=True,exist_ok=True)
    cv2.imwrite(str(qa/f"{unit['id']}-overlay.png"),overlay)
    return {'unitId':unit['id'],'floor':unit['floor'],'sourceFloorConflict':unit.get('sourceFloorConflict'),
      'areaM2':unit['areaM2'],'physicalNetAreaM2':unit['physicalNetAreaM2'],
      'rooms':unit['rooms'],'architecture':architecture,
      'source':{'url':unit['url'],'sha256':unit['sha256'],'listingUrl':unit['listingUrl'],
      'reviewFramePx':[width,im.shape[0]],'outlinePx':unit['outlinePx'],'scaleBarPx':unit['scaleBarPx'],'scaleBarMeters':unit['scaleBarMeters'],
      'originalImagePx':[original.shape[1],original.shape[0]]},
      'building':{'source':'landmark','id':'avenue-v','connection':'verified-project-and-source-inset','placement':'requires-registration-review'},
      'elevationM':unit.get('elevationM'),'elevationBasis':unit.get('elevationBasis'),
      'verticalDimensionsBasis':'Estimated 3.10 m walls plus 0.20 m slab; source elevations retained separately.',
      'status':'needs_review' if unit.get('sourceFloorConflict') else 'reviewed-local-geometry'}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cache',type=Path,required=True)
    p.add_argument('--manifest',type=Path,default=ROOT/'rekonstrukcije/avenue-v/floor-plan-sources.json')
    p.add_argument('--output',type=Path,default=ROOT/'rekonstrukcije/avenue-v/unit-models.json')
    p.add_argument('--qa',type=Path,required=True)
    args=p.parse_args();source=json.loads(args.manifest.read_text())
    units=[]
    for i,unit in enumerate(source['units'],1):
        model=reconstruct(unit,args.cache,args.qa);units.append(model)
        print(f"{i}/{len(source['units'])}: {unit['id']} — {len(model['architecture']['walls'])} wall polygons")
    output={'schema':'consensus-builder.unit-floor-models.v1','building':source['building'],'units':units,
      'coverage':{'knownUnits':len(units),'reportedTotalUnits':74,'wholeFloors':0,'commonAreas':'unknown','basements':'unknown'}}
    args.output.write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
if __name__=='__main__':main()
