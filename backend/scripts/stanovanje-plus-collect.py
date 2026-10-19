# Collect exactly ten private archive examples and retain source-coordinate evidence.
import json,re,urllib.request,hashlib
from pathlib import Path
from lxml import html,etree
ROOT=Path(__file__).resolve().parents[1]/'logs/stanovanje-plus-ten-20261019'
ROOT.mkdir(parents=True,exist_ok=True)
BASE='https://stanovanje.plus/'
def get(url):
 with urllib.request.urlopen(url,timeout=45) as r:
  data=r.read(8_000_001)
 if len(data)>8_000_000:raise ValueError('source exceeds bounded 8 MB')
 return data
index=html.fromstring((ROOT/'index.html').read_bytes())
selected=[]
for row in index.xpath('//tr[td]'):
 cells=row.xpath('./td')
 links=row.xpath('.//a/@href')
 if len(cells)<3 or 'Zagreb' not in cells[2].text_content():continue
 plans=[a for a in links if 'nc=tl-kk1' in a]
 if not plans:continue
 selected.append({'code':re.search(r'code=([^&]+)',plans[0])[1],'title':cells[0].text_content().strip(),'author':cells[1].text_content().strip(),'city':'Zagreb','sourceUrl':BASE+plans[0].replace('nacrti.php','2026nacrti.php'),'infoUrl':BASE+next(a for a in links if 'info.php' in a).replace('info.php','2026info.php')})
 if len(selected)==9:break
selected.append({'code':'11218vm','title':'Stambeno poslovni objekt, Ilica','city':'Zagreb','author':'Boris Duplančić','sourceUrl':BASE+'2026nacrti.php?code=11218vm&nc=tl-kk1','infoUrl':BASE+'2026info.php?code=11218vm'})
assert len({s['code'] for s in selected})==10
for i,s in enumerate(selected):
 folder=ROOT/s['code'];folder.mkdir(exist_ok=True)
 raw=get(s['sourceUrl'])
 # Preserve original SVG bytes rather than HTML parser normalization of SVG case.
 m=re.search(rb'<svg\b[\s\S]*?</svg>',raw)
 if not m:raise ValueError('No SVG '+s['code'])
 svg=m[0]; (folder/'source.svg').write_bytes(svg)
 s['sourceSha256']=hashlib.sha256(svg).hexdigest(); s['bytes']=len(svg)
 page=html.fromstring(raw)
 text=' '.join(page.text_content().split())
 (folder/'page-text.txt').write_text(text[:20000])
 info=get(s['infoUrl']);infotext=' '.join(html.fromstring(info).text_content().split())
 (folder/'metadata.txt').write_text(infotext[:25000])
 s['planLabel']='tl-kk1 — first characteristic floor from archive';s['registration']=None
 (folder/'source.json').write_text(json.dumps(s,ensure_ascii=False,indent=2))
 print(i+1,s['code'],len(svg),flush=True)
(ROOT/'selection.json').write_text(json.dumps(selected,ensure_ascii=False,indent=2))
