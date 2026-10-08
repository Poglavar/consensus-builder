// Semantic geometry checks supplement the shared format validator; these are review gates.
import { polygon, kinks } from '@turf/turf';
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export const closeRing=ring=>distance(ring[0],ring.at(-1))<1e-10?ring:[...ring,ring[0]];
const metric=(p,size)=>p.map((v,i)=>v*size[i]);
function pointSegment(p,a,b) {
    const d=b.map((v,i)=>v-a[i]),den=d[0]**2+d[1]**2;
    const t=den?Math.max(0,Math.min(1,((p[0]-a[0])*d[0]+(p[1]-a[1])*d[1])/den)):0;
    return distance(p,[a[0]+t*d[0],a[1]+t*d[1]]);
}
function inRing(p,ring) {
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
        const a=ring[i],b=ring[j];
        if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
    }
    return inside;
}
const inPolygon=(p,rings)=>inRing(p,rings[0])&&!rings.slice(1).some(r=>inRing(p,r));
function crossesSolid(a,b,rings) {
    const d=[b[0]-a[0],b[1]-a[1]],cuts=[0,1],cross=(p,q)=>p[0]*q[1]-p[1]*q[0];
    for(const ring of rings)for(let i=0;i<ring.length;i++) {
        const p=ring[i],q=ring[(i+1)%ring.length],e=[q[0]-p[0],q[1]-p[1]],den=cross(d,e);
        if(Math.abs(den)<1e-10)continue;
        const offset=[p[0]-a[0],p[1]-a[1]],t=cross(offset,e)/den,u=cross(offset,d)/den;
        if(t>0&&t<1&&u>=0&&u<=1)cuts.push(t);
    }
    cuts.sort((x,y)=>x-y);
    return cuts.slice(1).some((end,i)=>{
        if(end-cuts[i]<1e-8)return false;
        const t=(cuts[i]+end)/2;return inPolygon([a[0]+t*d[0],a[1]+t*d[1]],rings);
    });
}
const edgeDistance=(p,polygons)=>Math.min(...polygons.flatMap(rings=>rings.flatMap(ring=>ring.map((a,i)=>pointSegment(p,a,ring[(i+1)%ring.length])))));

export function geometryIssues(architecture,{rooms=[]}={}) {
    const issues=[],size=architecture.dimensionsM;
    const walls=architecture.walls.map(rings=>rings.map(r=>r.map(p=>metric(p,size))));
    const slabs=architecture.slabs.map(rings=>rings.map(r=>r.map(p=>metric(p,size))));
    if(architecture.slabs.some(rings=>kinks(polygon(rings.map(closeRing))).features.length)) issues.push('Slab outline intersects itself.');
    if(walls.length<Math.max(4,rooms.length*2)) issues.push('Too few wall segments for the room schedule; check completeness.');
    if(walls.some(rings=>rings[0].some(p=>!slabs.some(s=>inPolygon(p,s))&&edgeDistance(p,slabs)>.6))) issues.push('Wall geometry extends outside the slab outline.');
    for(const opening of architecture.openings) {
        const a=metric(opening.a,size),b=metric(opening.b,size),span=distance(a,b);
        if(span>.01 && walls.some(w=>crossesSolid(a,b,w))) {
            issues.push('An opening overlaps a solid wall; its wall gap needs review.');
        }
        if([a,b].some(p=>edgeDistance(p,walls)>Math.max(.3,opening.depthM))) issues.push('An opening is disconnected from its adjoining walls.');
        if(opening.kind==='door') {
            const hinge=metric(opening.hinge,size),tip=metric(opening.openTip,size);
            if(Math.min(distance(hinge,a),distance(hinge,b))>.1||Math.abs(distance(hinge,tip)-span)>Math.max(.15,span*.2)) issues.push('Door hinge or leaf length does not match its opening.');
        }
    }
    return [...new Set(issues)];
}
