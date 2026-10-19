// Infer ceiling-lamp centres from floor regions, independently of human walking clearance.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__apartmentLightRooms = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const CLEARANCE_M = .04, MIN_ROOM_RADIUS_M = .12, GRID_STEP_M = .1, MAX_CELLS = 40000;
    const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
    const validPolygon = rings => Array.isArray(rings) && rings.length > 0 && rings.every(ring => Array.isArray(ring) && ring.length >= 3 && ring.every(validPoint));
    const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    function pointSegmentDistance(p,a,b) {
        const dx=b[0]-a[0],dy=b[1]-a[1],length2=dx*dx+dy*dy;
        const t=length2?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length2)):0;
        return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
    }
    function segmentDistance(a,b,c,d) {
        if(cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0)return 0;
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
    const inPolygon = (p,rings) => inRing(p,rings[0])&&!rings.slice(1).some(ring=>inRing(p,ring));
    const edges = polygons => polygons.flatMap(rings=>rings.flatMap(ring=>ring.map((p,i)=>[p,ring[(i+1)%ring.length]])));
    function lampPositions(architecture) {
        const dimensions=architecture?.dimensionsM;
        if(!Array.isArray(dimensions)||dimensions.length!==2||!dimensions.every(n=>Number.isFinite(n)&&n>0&&n<=1000))return [];
        if(!Array.isArray(architecture.slabs)||!architecture.slabs.length||!architecture.slabs.every(validPolygon))return [];
        const walls=architecture.walls||[],openings=architecture.openings||[],railings=architecture.railings||[];
        if(!Array.isArray(walls)||!walls.every(validPolygon)||![openings,railings].every(items=>Array.isArray(items)&&items.every(item=>validPoint(item?.a)&&validPoint(item?.b))))return [];
        // Architecture is normalized image XY; the renderer uses local metres with Y upward.
        const [width,depth]=dimensions,metric=p=>[p[0]*width,(1-p[1])*depth];
        const convert=polygons=>polygons.map(rings=>rings.map(ring=>ring.map(metric)));
        const floors=convert(architecture.slabs),solids=convert(walls),floorEdges=edges(floors),wallEdges=edges(solids);
        const barriers=railings.map(rail=>[metric(rail.a),metric(rail.b),.03]);
        for(const opening of openings) {
            const a=metric(opening.a),b=metric(opening.b),length=Math.hypot(b[0]-a[0],b[1]-a[1]);
            if(length<1e-7)continue;
            const halfDepth=Number.isFinite(opening.depthM)&&opening.depthM>0?opening.depthM/2:.03;
            // Every aperture closes a room boundary, including ordinary open doors. Extend the
            // seal into the adjoining wall so raster links cannot escape around its endpoints.
            const extension=Math.max(.1,halfDepth),dx=(b[0]-a[0])/length*extension,dy=(b[1]-a[1])/length*extension;
            barriers.push([[a[0]-dx,a[1]-dy],[b[0]+dx,b[1]+dy],halfDepth]);
        }
        const onFloor=p=>floors.some(rings=>inPolygon(p,rings));
        const floorOffsets=Array.from({length:8},(_,i)=>[Math.cos(i*Math.PI/4),Math.sin(i*Math.PI/4)]);
        function canPlace(p,clearance=CLEARANCE_M) {
            // Test the slab union, so adjacent slab pieces do not create imaginary room seams.
            if(!onFloor(p)||!floorOffsets.every(([dx,dy])=>onFloor([p[0]+dx*clearance,p[1]+dy*clearance])))return false;
            return !solids.some(rings=>inPolygon(p,rings))
                &&wallEdges.every(([a,b])=>pointSegmentDistance(p,a,b)>=clearance)
                &&barriers.every(([a,b,radius])=>pointSegmentDistance(p,a,b)>=radius+clearance);
        }
        function canConnect(p,q) {
            // Both endpoints already passed canPlace while building the grid.
            if(wallEdges.some(([a,b])=>segmentDistance(p,q,a,b)<CLEARANCE_M))return false;
            if(barriers.some(([a,b,radius])=>segmentDistance(p,q,a,b)<radius+CLEARANCE_M))return false;
            // An edge may jump a hole narrower than the grid. Check both sides of every floor
            // boundary crossing; shared/overlapping slab boundaries remain connected.
            const dx=q[0]-p[0],dy=q[1]-p[1];
            for(const [a,b] of floorEdges) {
                const ex=b[0]-a[0],ey=b[1]-a[1],denominator=dx*ey-dy*ex;
                if(Math.abs(denominator)<1e-12)continue;
                const ax=a[0]-p[0],ay=a[1]-p[1],t=(ax*ey-ay*ex)/denominator,u=(ax*dy-ay*dx)/denominator;
                if(t<=0||t>=1||u<0||u>1)continue;
                for(const side of [-1e-7,1e-7])if(!onFloor([p[0]+(t+side)*dx,p[1]+(t+side)*dy]))return false;
            }
            return true;
        }
        const step=Math.max(GRID_STEP_M,Math.sqrt(width*depth/MAX_CELLS));
        const cols=Math.max(1,Math.floor(width/step)),rows=Math.max(1,Math.floor(depth/step));
        const cellWidth=width/cols,cellDepth=depth/rows,count=cols*rows;
        const labels=new Int32Array(count).fill(-1),points=new Array(count);
        for(let row=0;row<rows;row++)for(let col=0;col<cols;col++) {
            const id=row*cols+col,p=[(col+.5)*cellWidth,(row+.5)*cellDepth];
            if(canPlace(p)){points[id]=p;labels[id]=0;}
        }
        const positions=[];let regionCount=0;
        for(let id=0;id<count;id++)if(labels[id]===0) {
            const label=++regionCount,region=[id];labels[id]=label;
            let x=0,y=0;
            for(let i=0;i<region.length;i++) {
                const current=region[i],p=points[current],col=current%cols,row=Math.floor(current/cols);
                x+=p[0];y+=p[1];
                for(const next of [col?current-1:-1,col+1<cols?current+1:-1,row?current-cols:-1,row+1<rows?current+cols:-1]) {
                    if(next>=0&&labels[next]===0&&canConnect(p,points[next])){labels[next]=label;region.push(next);}
                }
            }
            // Equal-area cells cover the actual dimensions (no overshooting final row/column).
            // Their area centroid stays continuous instead of snapping a valid centre to a cell.
            const centre=[x/region.length,y/region.length],col=Math.floor(centre[0]/cellWidth),row=Math.floor(centre[1]/cellDepth);
            const centreInRegion=labels[row*cols+col]===label;
            // Slabs can protrude slightly beyond facade strokes. Those long, paper-thin strips
            // are not rooms; require some usable interior width without imposing body clearance.
            if(!(centreInRegion&&canPlace(centre,MIN_ROOM_RADIUS_M))&&!region.some(cell=>canPlace(points[cell],MIN_ROOM_RADIUS_M)))continue;
            if(centreInRegion&&canPlace(centre))positions.push(centre);
            else {
                let nearest=region[0],best=Infinity;
                for(const cell of region) {
                    const p=points[cell],distance=(p[0]-centre[0])**2+(p[1]-centre[1])**2;
                    if(distance<best){best=distance;nearest=cell;}
                }
                positions.push(points[nearest].slice());
            }
        }
        // Railings fence regions but do not identify outdoor space; geometry alone cannot
        // distinguish an enclosed balcony from an indoor room with a railing.
        return positions;
    }
    return {lampPositions};
});
