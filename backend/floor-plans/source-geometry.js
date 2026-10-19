// Derive immutable wall corners and possible openings from measured source-image strokes.
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export function wallCorners(wall) {
    const length=distance(wall.a,wall.b),half=wall.widthPx/2;
    if(!(length>0&&half>0))throw new Error('Invalid source wall candidate.');
    const dx=-(wall.b[1]-wall.a[1])/length*half,dy=(wall.b[0]-wall.a[0])/length*half;
    return [[wall.a[0]+dx,wall.a[1]+dy],[wall.b[0]+dx,wall.b[1]+dy],
        [wall.b[0]-dx,wall.b[1]-dy],[wall.a[0]-dx,wall.a[1]-dy]];
}
export function candidateFrame(walls) {
    const points=walls.flatMap(wallCorners);
    if(!points.length)throw new Error('No selected source geometry.');
    const x=Math.min(...points.map(p=>p[0])),y=Math.min(...points.map(p=>p[1]));
    return [x,y,Math.max(...points.map(p=>p[0]))-x,Math.max(...points.map(p=>p[1]))-y];
}
export const frameCorners=([x,y,w,h])=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
function projection(p,a,b) {
    const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;
    const t=((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den;
    return {t,distance:distance(p,[a[0]+t*dx,a[1]+t*dy])};
}
function supportsOutwardExtension(wall,a,b,tolerance) {
    const direction=[b[0]-a[0],b[1]-a[1]],gapLength=Math.hypot(...direction);
    const wallDirection=[wall.b[0]-wall.a[0],wall.b[1]-wall.a[1]],wallLength=Math.hypot(...wallDirection);
    if(gapLength===0||wallLength===0)return false;
    // A proposed aperture must continue a measured segment from one of its endpoints.
    for(const [endpoint,other,outward] of [[wall.a,wall.b,[wall.a[0]-wall.b[0],wall.a[1]-wall.b[1]]],
        [wall.b,wall.a,[wall.b[0]-wall.a[0],wall.b[1]-wall.a[1]]]]) {
        if(distance(endpoint,a)>tolerance&&distance(endpoint,b)>tolerance)continue;
        const target=distance(endpoint,a)<=distance(endpoint,b)?b:a;
        const cross=Math.abs(wallDirection[0]*direction[1]-wallDirection[1]*direction[0])/wallLength;
        const alignment=(target[0]-endpoint[0])*outward[0]+(target[1]-endpoint[1])*outward[1];
        if(cross<=tolerance&&alignment>0)return true;
    }
    return false;
}
export function sourceGeometry(evidence) {
    const walls=evidence.wallCandidates,seen=new Set(),gaps=[];
    for(let i=0;i<walls.length;i++)for(let j=i+1;j<walls.length;j++) {
        const first=walls[i],last=walls[j];
        for(const a of [first.a,first.b])for(const b of [last.a,last.b]) {
            const length=distance(a,b),width=Math.max(first.widthPx,last.widthPx);
            if(length<15||length>Math.min(200,width*12))continue;
            if(Math.min(Math.abs(a[0]-b[0]),Math.abs(a[1]-b[1]))>Math.max(2,Math.min(first.widthPx,last.widthPx)/2))continue;
            const horizontal=Math.abs(a[1]-b[1])<=Math.abs(a[0]-b[0]);
            const x=horizontal?[Math.min(a[0],b[0]),(a[1]+b[1])/2]:[(a[0]+b[0])/2,Math.min(a[1],b[1])];
            const y=horizontal?[Math.max(a[0],b[0]),x[1]]:[x[0],Math.max(a[1],b[1])];
            const alignmentTolerance=Math.max(2,Math.min(first.widthPx,last.widthPx)/2);
            if(!supportsOutwardExtension(first,x,y,alignmentTolerance)&&
                !supportsOutwardExtension(last,x,y,alignmentTolerance))continue;
            // A span through a substantial source stroke is not a gap. Thin glazing is retained.
            const blocked=walls.some(w=>{
                const minimumWidth=Math.min(first.widthPx,last.widthPx);
                if(w.widthPx<minimumWidth*.6)return false;
                const t1=projection(w.a,x,y).t,t2=projection(w.b,x,y).t;
                const lo=Math.max(.02,Math.min(t1,t2)),hi=Math.min(.98,Math.max(t1,t2));
                if(hi<lo)return false;
                const t=(lo+hi)/2,p=[x[0]+(y[0]-x[0])*t,x[1]+(y[1]-x[1])*t],r=projection(p,w.a,w.b);
                return r.t>=0&&r.t<=1&&r.distance<=Math.max(w.widthPx/2,minimumWidth*.55);
            });
            if(blocked)continue;
            const key=JSON.stringify([x,y]);if(seen.has(key))continue;seen.add(key);
            gaps.push({a:x,b:y,widthPx:width,between:[first.id,last.id]});
        }
    }
    gaps.sort((a,b)=>a.a[1]-b.a[1]||a.a[0]-b.a[0]||a.b[1]-b.b[1]||a.b[0]-b.b[0]);
    const issues=[...evidence.issues];
    if(gaps.length>500)issues.push('Possible opening candidates were truncated; check missing openings.');
    return {...evidence,issues,wallCandidates:walls.map(w=>({...w,corners:wallCorners(w)})),
        openingCandidates:gaps.slice(0,500).map((g,i)=>({...g,id:`G${i+1}`})),
        candidateFramePx:walls.length?candidateFrame(walls):[0,0,evidence.widthPx,evidence.heightPx],
        outlineCorners:walls.length?frameCorners(candidateFrame(walls)):[]};
}

export function selectedCandidates(ids,candidates) {
    if(!Array.isArray(ids)||new Set(ids).size!==ids.length)throw new Error('Duplicate or invalid source selections.');
    return ids.map(id=>{
        const found=candidates.find(c=>c.id===id);if(!found)throw new Error(`Unknown source candidate: ${id}`);return found;
    });
}
