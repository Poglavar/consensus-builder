# Decode measured SVG path geometry and summarize CAD layers for the private LLM trial.
import json,re,math
from pathlib import Path
from lxml import etree
ROOT=Path(__file__).resolve().parents[1]/'logs/stanovanje-plus-ten-20261019'
NUM=r'[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?'
def matrix(s):
 m=re.fullmatch(r'\s*matrix\((.*?)\)\s*',s or '')
 if not s:return [1,0,0,1,0,0]
 if not m:raise ValueError('Unsupported transform '+s)
 return [float(x) for x in re.findall(NUM,m[1])]
def mul(a,b):
 return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]]
def paths(d):
 ts=re.findall(r'[A-Za-z]|'+NUM,d);i=0;cmd=None;p=[0,0];start=None;pts=[];curved=False;out=[]
 def save(closed=False):
  nonlocal pts,curved
  if len(pts)>1:out.append({'points':pts,'closed':closed or pts[0]==pts[-1],'curved':curved})
  pts=[];curved=False
 while i<len(ts):
  if ts[i].isalpha():cmd=ts[i];i+=1
  if cmd is None:raise ValueError('path without command')
  op=cmd.upper();rel=cmd.islower();base=p[:]
  if op=='Z':
   if start is not None:p=start[:]
   save(True);cmd=None;continue
  n={'M':2,'L':2,'H':1,'V':1,'C':6,'Q':4,'S':4,'T':2,'A':7}.get(op)
  if n is None:raise ValueError('unsupported '+op)
  v=list(map(float,ts[i:i+n]));i+=n
  if len(v)!=n:raise ValueError('short path')
  if op in ['M','L','T']:
   q=[v[0]+(p[0] if rel else 0),v[1]+(p[1] if rel else 0)]
   if op=='M':save();start=q[:]
   elif op=='T':curved=True
   pts.append(q);p=q
   if op=='M':cmd='l' if rel else 'L'
  elif op in ['H','V']:
   p=p[:];j=0 if op=='H' else 1;p[j]=v[0]+(p[j] if rel else 0);pts.append(p)
  elif op in ['C','Q']:
   curved=True;c=[[v[j]+(base[0] if rel else 0),v[j+1]+(base[1] if rel else 0)] for j in range(0,n,2)]
   for k in range(1,13):
    t=k/12;u=1-t
    if op=='C':q=[u**3*base[j]+3*u*u*t*c[0][j]+3*u*t*t*c[1][j]+t**3*c[2][j] for j in [0,1]]
    else:q=[u*u*base[j]+2*u*t*c[0][j]+t*t*c[1][j] for j in [0,1]]
    pts.append(q)
   p=c[-1]
  else:
   # Unsupported smooth/elliptical curves are retained as endpoint evidence but never wall fills.
   curved=True;p=[v[-2]+(p[0] if rel else 0),v[-1]+(p[1] if rel else 0)];pts.append(p)
 save();return out

def collect(svg):
 root=etree.fromstring(svg);ns='{http://www.inkscape.org/namespaces/inkscape}';out=[];layers={}
 for el in root.iter():
  if etree.QName(el).localname!='path' or any(etree.QName(a).localname in ['defs','clipPath'] for a in el.iterancestors()):continue
  ancestors=list(el.iterancestors());label=next((a.get(ns+'label') for a in ancestors if a.get(ns+'label')), '(unlabelled)')
  m=[1,0,0,1,0,0]
  for a in list(reversed(ancestors))+[el]:m=mul(m,matrix(a.get('transform')))
  fill=el.get('fill','black');sub=paths(el.get('d',''))
  for s in sub:
   s['points']=[[round(m[0]*x+m[2]*y+m[4],5),round(m[1]*x+m[3]*y+m[5],5)] for x,y in s['points']]
  item={'id':'P'+str(len(out)),'layer':label,'fill':fill,'subpaths':sub};out.append(item)
  row=layers.setdefault(label,{'paths':0,'closedSubpaths':0,'filledSubpaths':0,'bounds':[1e9,1e9,-1e9,-1e9]})
  row['paths']+=1
  for s in sub:
   row['closedSubpaths']+=int(s['closed']);row['filledSubpaths']+=int(fill!='none' and len(s['points'])>=3)
   for x,y in s['points']:
    row['bounds']=[min(row['bounds'][0],x),min(row['bounds'][1],y),max(row['bounds'][2],x),max(row['bounds'][3],y)]
 return {'viewBox':list(map(float,root.get('viewBox').split())),'layers':layers,'paths':out}
if __name__=='__main__':
 for source in json.loads((ROOT/'selection.json').read_text()):
  folder=ROOT/source['code'];e=collect((folder/'source.svg').read_bytes());(folder/'evidence.json').write_text(json.dumps(e,separators=(',',':')))
  (folder/'layer-summary.json').write_text(json.dumps({'viewBox':e['viewBox'],'layers':e['layers']},ensure_ascii=False,indent=2))
  print(source['code'],len(e['paths']),len(e['layers']))
