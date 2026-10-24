// Shared interior rendering, walking and lifecycle support.
    'use strict';
    const BODY_RADIUS_M = .36, MIN_SEPARATION_M = .76;
    const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
    const validPoint = p => Array.isArray(p) && p.length >= 2 && p.slice(0,2).every(Number.isFinite);
    function pointSegmentDistance(p,a,b) {
        const dx=b[0]-a[0],dy=b[1]-a[1],size=dx*dx+dy*dy;
        const t=size?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/size)):0;
        return distance(p,[a[0]+t*dx,a[1]+t*dy]);
    }
    function segmentDistance(a,b,c,d) {
        const cross = (p,q,r) => (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
        if (cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) return 0;
        return Math.min(pointSegmentDistance(a,c,d),pointSegmentDistance(b,c,d),pointSegmentDistance(c,a,b),pointSegmentDistance(d,a,b));
    }
    function inRing(p,ring) {
        let inside=false;
        for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
            const a=ring[i],b=ring[j];
            if((a[1]>p[1])!==(b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
        }
        return inside;
    }
    const inPolygon = (p,rings) => inRing(p,rings[0])&&!rings.slice(1).some(r=>inRing(p,r));
    const edges = rings => rings.flatMap(ring=>ring.map((a,i)=>[a,ring[(i+1)%ring.length]]));
    function strip(a,b,width) {
        const size=distance(a,b);if(size<1e-6)return null;
        const nx=-(b[1]-a[1])/size*width/2,ny=(b[0]-a[0])/size*width/2;
        return [[[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny]]];
    }
    function buildNavigation(architecture) {
        const dimensions=architecture?.dimensionsM;
        if(!Array.isArray(dimensions)||dimensions.length!==2||!dimensions.every(v=>Number.isFinite(v)&&v>0&&v<=80))return null;
        // Match buildLocalUnitParts: drawings are y-down; the displayed metre frame is y-up.
        const [width,depth]=dimensions,metric=p=>[p[0]*width,(1-p[1])*depth];
        const validPolygon=rings=>Array.isArray(rings)&&rings.length&&rings.every(r=>Array.isArray(r)&&r.length>=3&&r.every(validPoint));
        for(const polygons of [architecture.slabs,architecture.walls||[],architecture.landings||[],(architecture.platforms||[]).map(p=>p.rings)])if(!Array.isArray(polygons)||!polygons.every(validPolygon))return null;
        const convert = polygons => (polygons||[]).map(rings=>rings.map(r=>r.map(metric)));
        const supports=convert(architecture.slabs);
        if(!supports.length)return null;
        const obstacles=convert(architecture.walls).concat(convert(architecture.landings));
        for(const platform of architecture.platforms||[])obstacles.push(...convert([platform.rings]));
        const addStrip=(a,b,size)=>{if(validPoint(a)&&validPoint(b)&&Number.isFinite(size)&&size>0){const polygon=strip(metric(a),metric(b),size);if(polygon)obstacles.push(polygon);}};
        for(const stair of architecture.stairs||[]){if(!validPoint(stair.a)||!validPoint(stair.b)||!Number.isFinite(stair.widthM)||stair.widthM<=0)return null;addStrip(stair.a,stair.b,stair.widthM);}
        for(const rail of architecture.railings||[])addStrip(rail.a,rail.b,.06);
        for(const opening of architecture.openings||[]) {
            if(!validPoint(opening.a)||!validPoint(opening.b))return null;
            // Only the renderer's swung door is open. Sliding leaves and glazed doors are closed.
            if(opening.kind!=='door'||!Number.isFinite(opening.sillM)||opening.sillM>.03||!Number.isFinite(opening.heightM)||opening.heightM<1.9) {
                addStrip(opening.a,opening.b,Math.max(opening.depthM||0,.06));continue;
            }
            if(!validPoint(opening.hinge)||!validPoint(opening.openTip))return null;
            addStrip(opening.hinge,opening.openTip,.04);
            const a=metric(opening.a),b=metric(opening.b),size=distance(a,b);
            if(size<.001)continue;
            const t=Math.min(.055,size/4)/size,lerp=f=>[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f];
            for(const [p,q] of [[a,lerp(t)],[lerp(1-t),b]]){const polygon=strip(p,q,Math.max(opening.depthM||0,.06)+.015);if(polygon)obstacles.push(polygon);}
        }
        const supportEdges=supports.map(edges),obstacleEdges=obstacles.map(edges),radius=BODY_RADIUS_M;
        function canWalk(a,b=a) {
            if(!validPoint(a)||!validPoint(b))return false;
            // A whole swept disk stays on one ground slab. This deliberately avoids unsupported
            // seams between separate slabs, elevated landings, stairwells and terrace gaps.
            if(!supports.some((rings,i)=>inPolygon(a,rings)&&inPolygon(b,rings)&&supportEdges[i].every(([c,d])=>segmentDistance(a,b,c,d)>=radius)))return false;
            return obstacles.every((rings,i)=>!inPolygon(a,rings)&&!inPolygon(b,rings)&&obstacleEdges[i].every(([c,d])=>segmentDistance(a,b,c,d)>=radius));
        }
        const step=Math.max(.22,Math.sqrt(width*depth/14000)),cols=Math.ceil(width/step),rows=Math.ceil(depth/step);
        const points=[],links=[],grid=new Int32Array(cols*rows).fill(-1);
        for(let y=0;y<rows;y++)for(let x=0;x<cols;x++) {
            const p=[(x+.5)*step,(y+.5)*step];
            if(!canWalk(p))continue;
            const id=points.length;grid[y*cols+x]=id;points.push(p);links.push([]);
            for(const other of [x?grid[y*cols+x-1]:-1,y?grid[(y-1)*cols+x]:-1])if(other>=0&&canWalk(p,points[other])){links[id].push(other);links[other].push(id);}
        }
        const components=[],seen=new Set();
        for(let id=0;id<points.length;id++)if(!seen.has(id)) {
            const ids=[id];seen.add(id);
            for(let i=0;i<ids.length;i++)for(const next of links[ids[i]])if(!seen.has(next)){seen.add(next);ids.push(next);}
            components.push(ids);
        }
        components.sort((a,b)=>b.length-a.length);
        return {points,links,components,step,radius,canWalk};
    }
    function findPath(nav,start,end) {
        if(!nav?.points[start]||!nav.points[end])return [];
        const queue=[start],parents=new Map([[start,null]]);
        for(let i=0;i<queue.length&&!parents.has(end);i++)for(const next of nav.links[queue[i]])if(!parents.has(next)){parents.set(next,queue[i]);queue.push(next);}
        if(!parents.has(end))return [];
        const result=[];for(let id=end;id!==null;id=parents.get(id))result.push(id);
        return result.reverse();
    }
    function createWalkers(nav,random=Math.random) {
        const ids=nav?.components[0];
        if(!ids||ids.length*nav.step*nav.step<2)return [];
        const centre=ids.reduce((p,id)=>[p[0]+nav.points[id][0]/ids.length,p[1]+nav.points[id][1]/ids.length],[0,0]);
        const first=ids.reduce((best,id)=>distance(nav.points[id],centre)<distance(nav.points[best],centre)?id:best,ids[0]);
        const second=ids.reduce((best,id)=>distance(nav.points[id],nav.points[first])>distance(nav.points[best],nav.points[first])?id:best,first);
        if(distance(nav.points[first],nav.points[second])<1.2)return [];
        return [first,second].map((id,index)=>({id,x:nav.points[id][0],y:nav.points[id][1],heading:index?Math.PI:0,path:[],pause:1+random()*3,phase:0,moving:false,blocked:0}));
    }
    function advanceWalkers(nav,walkers,delta,random=Math.random) {
        const dt=Math.max(0,Math.min(delta,.1));let changed=false;
        for(const walker of walkers) {
            // A walker steered from its own eyes moves only by stepWalker.
            if(walker.controlled)continue;
            const wasMoving=walker.moving;walker.moving=false;
            if(walker.pause>0)walker.pause=Math.max(0,walker.pause-dt);
            else {
                if(!walker.path.length) {
                    const ids=nav.components[0],candidates=ids.filter(id=>distance(nav.points[id],[walker.x,walker.y])>1.2&&walkers.every(other=>other===walker||distance(nav.points[id],[other.x,other.y])>MIN_SEPARATION_M));
                    if(candidates.length)walker.path=findPath(nav,walker.id,candidates[Math.min(candidates.length-1,Math.floor(random()*candidates.length))]).slice(1);
                    else walker.pause=2;
                }
                const next=nav.points[walker.path[0]];
                if(next) {
                    const from=[walker.x,walker.y],remaining=distance(from,next),travel=Math.min(.65*dt,remaining),t=remaining?travel/remaining:1;
                    const to=[from[0]+(next[0]-from[0])*t,from[1]+(next[1]-from[1])*t];
                    if(walkers.every(other=>other===walker||pointSegmentDistance([other.x,other.y],from,to)>=MIN_SEPARATION_M)) {
                        walker.heading=Math.atan2(next[1]-walker.y,next[0]-walker.x);walker.x=to[0];walker.y=to[1];walker.phase+=travel*9;walker.moving=travel>0;walker.blocked=0;changed=true;
                        if(remaining<=travel+1e-7){walker.id=walker.path.shift();if(!walker.path.length)walker.pause=2+random()*5;}
                    } else {
                        walker.blocked+=dt;
                        // Finish the current safe grid edge before choosing another route.
                        if(walker.blocked>2){walker.path=[walker.id];walker.pause=1+random()*2;walker.blocked=0;}
                    }
                }
            }
            if(wasMoving!==walker.moving)changed=true;
        }
        return changed;
    }
    function routeWalkerTo(nav,walker,point) {
        let end=null,start=null,best=Math.max(.5,nav.step*1.5),startDistance=nav.step*1.5;
        const from=[walker.x,walker.y];
        nav.points.forEach((p,id)=>{const d=distance(p,point);if(d<best){end=id;best=d;}
            const s=distance(p,from);if(s<startDistance&&nav.canWalk(from,p)){start=id;startDistance=s;}});
        if(end===null||start===null)return false;
        const path=findPath(nav,start,end);if(!path.length)return false;
        // Smooth grid stair-steps only across segments with full swept-body clearance.
        const route=[];let current=from,index=0;
        while(index<path.length){let farthest=index;
            for(let next=index;next<path.length;next++)if(nav.canWalk(current,nav.points[path[next]]))farthest=next;
            route.push(path[farthest]);current=nav.points[path[farthest]];index=farthest+1;
        }
        walker.path=route;walker.pause=0;walker.blocked=0;return true;
    }
    function nearestPoint(nav,point) {
        let best=null,bestDistance=Infinity;
        nav.points.forEach((p,id)=>{const d=distance(p,point);if(d<bestDistance){best=id;bestDistance=d;}});
        return best;
    }
    // Free movement from the eye-level view: the full step if the body fits, else the larger axis that does,
    // so walking into a wall slides along it. Other people block like walls.
    function stepWalker(nav,walker,dx,dy,walkers=[]) {
        if(![dx,dy].every(Number.isFinite)||Math.hypot(dx,dy)<1e-6)return false;
        const from=[walker.x,walker.y];
        const clear=to=>nav.canWalk(from,to)&&walkers.every(other=>other===walker||pointSegmentDistance([other.x,other.y],from,to)>=MIN_SEPARATION_M);
        const moves=[[dx,dy],...(Math.abs(dx)>=Math.abs(dy)?[[dx,0],[0,dy]]:[[0,dy],[dx,0]])];
        for(const [mx,my] of moves) {
            const to=[from[0]+mx,from[1]+my];
            if(Math.hypot(mx,my)<1e-6||!clear(to))continue;
            walker.x=to[0];walker.y=to[1];walker.phase+=Math.hypot(mx,my)*9;walker.moving=true;
            const id=nearestPoint(nav,to);if(id!==null)walker.id=id;
            return true;
        }
        walker.moving=false;return false;
    }
    module.exports = {BODY_RADIUS_M,MIN_SEPARATION_M,buildNavigation,findPath,createWalkers,advanceWalkers,routeWalkerTo,nearestPoint,stepWalker};
