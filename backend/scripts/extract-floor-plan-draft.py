#!/usr/bin/env python3
"""Extract source linework and OCR into reviewable drafts; never infer metric scale or building placement."""
import argparse, json, re, subprocess, tempfile
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

def command(args, timeout=90):
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout).stdout.decode('utf8', errors='replace')

def image_page(path, text=''):
    image = Image.open(path).convert('RGB')
    image.thumbnail((2000, 2000))
    rgb = np.asarray(image)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    height, width = gray.shape
    if not text.strip():
        text = command(['tesseract', str(path), 'stdout', '--psm', '11'])
    edges = cv2.Canny(gray, 80, 180)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=30,
        minLineLength=max(15, min(width, height)//60), maxLineGap=3)
    segments = []
    for entry in ([] if lines is None else lines.reshape(-1,4)[:6000]):
        x1,y1,x2,y2 = (int(x) for x in entry)
        segments.append([round(x1/width,6),round(y1/height,6),round(x2/width,6),round(y2/height,6)])
    spread = rgb.max(axis=2).astype(int)-rgb.min(axis=2).astype(int)
    pale = float(np.mean(gray > 210))
    colorful = float(np.mean(spread > 45))
    plan_words = bool(re.search(r'tlocrt|floor\s*plan|spava|bedroom|dnevni|living|kupaon|bathroom|lo[dg]a|kuhinja',text,re.I))
    likely_plan = len(segments) >= 30 and pale > .45 and (plan_words or colorful < .08)
    return {'widthPx':width,'heightPx':height,'text':text[:50000], 'segments':segments,
        'screening':{'likelyPlan':likely_plan,'lineCount':len(segments),'paleFraction':round(pale,3),
                     'colorFraction':round(colorful,3),'planWords':plan_words}}

def extract(path, media_type):
    pages=[]; total_pages=1
    with tempfile.TemporaryDirectory(prefix='floor-plan-ocr-') as tmp:
        if media_type == 'application/pdf' or Path(path).read_bytes()[:5] == b'%PDF-':
            info=command(['pdfinfo',str(path)])
            match=re.search(r'^Pages:\s*(\d+)',info,re.M)
            if not match: raise ValueError('PDF page count missing')
            total_pages=int(match[1])
            # Bound each document, but record the omitted pages as an explicit coverage gap.
            for page in range(1,min(total_pages,30)+1):
                text=command(['pdftotext','-f',str(page),'-l',str(page),str(path),'-'])
                prefix=str(Path(tmp)/f'page-{page}')
                command(['pdftoppm','-f',str(page),'-l',str(page),'-singlefile','-scale-to','2000','-png',str(path),prefix])
                pages.append({'page':page,**image_page(prefix+'.png',text)})
        else:
            pages.append({'page':1,**image_page(path)})
    combined='\n'.join(p['text'] for p in pages)
    likely=any(p['screening']['likelyPlan'] for p in pages)
    legal=bool(re.search(r'opći uvjeti|general terms|privacy policy|politika privatnosti',combined,re.I))
    photo=all(p['screening']['colorFraction']>.20 and p['screening']['paleFraction']<.35 and not p['screening']['planWords'] for p in pages)
    not_plan=(legal or photo) and not likely and total_pages == len(pages)
    return {'schema':'consensus-builder.floor-plan-draft.v1','status':'not_plan' if not_plan else 'needs_review',
        'coordinateSpace':'normalized-source-image','scaleMPerUnit':None,'building':None,'floor':None,
        'totalPages':total_pages,'processedPages':len(pages),'truncated':len(pages)<total_pages,'pages':pages,
        'method':'OpenCV Canny/Hough source linework and Tesseract/PDF text; linework includes annotations and furniture.',
        'reviewRequired':['classify-plan','identify-drawing-region','wall-and-opening-semantics','metric-scale','unit-floor','building-registration']}

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file');parser.add_argument('--media-type',default='')
    args=parser.parse_args()
    print(json.dumps(extract(args.file,args.media_type),ensure_ascii=False))
