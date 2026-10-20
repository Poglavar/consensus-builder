// Room-level ceiling lamps retain small rooms and use geometric floor centres.
import {describe,expect,it} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {lampPositions}=require('../../frontend/js/apartment-light-rooms.js');
const rectangle=(x0,y0,x1,y1)=>[[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]];
const apartment=(dimensionsM=[8,6])=>({dimensionsM,slabs:[rectangle(0,0,1,1)],walls:[],openings:[],railings:[]});
const near=(point,expected,tolerance=.1)=>point.forEach((value,i)=>expect(Math.abs(value-expected[i])).toBeLessThan(tolerance));
describe('apartment ceiling-lamp room centres',()=>{
    it.each([[8,6],[8.17,5.93],[1.05,1.13],[210,193]])('centres a rectangular %j metre room without grid overshoot',(width,depth)=>{
        const positions=lampPositions(apartment([width,depth]));
        expect(positions).toHaveLength(1);near(positions[0],[width/2,depth/2],1e-8);
    });
    it.each(['door','window','glazedDoor','slidingDoor'])('separates two room centres across an authored %s',kind=>{
        const a=apartment();a.walls=[rectangle(.49,0,.51,.4),rectangle(.49,.6,.51,1)];
        a.openings=[{kind,a:[.5,.4],b:[.5,.6],depthM:.16}];
        const positions=lampPositions(a).sort((p,q)=>p[0]-q[0]);
        expect(positions).toHaveLength(2);near(positions[0],[1.95,3]);near(positions[1],[6.05,3]);
    });
    it('keeps a small bathroom that cannot fit human walking clearance',()=>{
        const a=apartment([4,3]);a.walls=[rectangle(.15,0,.19,1)];
        const positions=lampPositions(a).sort((p,q)=>p[0]-q[0]);
        expect(positions).toHaveLength(2);near(positions[0],[.3,1.5]);near(positions[1],[2.4,1.5]);
    });
    it('omits a paper-thin slab protrusion beyond a facade wall',()=>{
        const a=apartment([4,3]);a.walls=[rectangle(0,.9,1,.96)];
        const positions=lampPositions(a);expect(positions).toHaveLength(1);
        near(positions[0],[2,1.65]);
    });
    it('retains a narrow closet wider than the sliver threshold',()=>{
        const a=apartment([1,1]);a.walls=[rectangle(.3,0,.34,1)];
        const positions=lampPositions(a).sort((p,q)=>p[0]-q[0]);
        expect(positions).toHaveLength(2);near(positions[0],[.15,.5]);
    });
    it('returns every room when a plan has more than eight rooms',()=>{
        const a=apartment([22,4]);
        for(let i=1;i<11;i++)a.walls.push(rectangle((i*2-.05)/22,0,(i*2+.05)/22,1));
        const positions=lampPositions(a).sort((p,q)=>p[0]-q[0]);
        expect(positions).toHaveLength(11);positions.forEach((p,i)=>near(p,[i*2+1,2]));
    });
    it('moves a centre out of a slab hole to the closest valid part of the room',()=>{
        const a=apartment([6,6]);a.slabs[0].push(rectangle(1/3,1/3,2/3,2/3)[0]);
        const positions=lampPositions(a);expect(positions).toHaveLength(1);
        const [x,y]=positions[0];expect(x<2||x>4||y<2||y>4).toBe(true);
        expect(Math.hypot(x-3,y-3)).toBeLessThan(1.2);
    });
    it('keeps a concave-room lamp on its floor when the area centroid is outside',()=>{
        const a=apartment([6,6]);a.slabs=[[[[0,0],[1,0],[1,1/6],[1/6,1/6],[1/6,1],[0,1]]]];
        const positions=lampPositions(a);expect(positions).toHaveLength(1);
        const [x,y]=positions[0];expect(x<1||y>5).toBe(true);
        expect(x>=0&&x<=6&&y>=0&&y<=6).toBe(true);
    });
    it('uses the y-up metre frame for an asymmetric slab',()=>{
        const a=apartment([8,6]);a.slabs=[rectangle(.1,.1,.9,.4)];
        const positions=lampPositions(a);expect(positions).toHaveLength(1);near(positions[0],[4,4.5]);
    });
    it('joins contiguous slab pieces while preserving genuinely separate floor regions',()=>{
        const a=apartment([8,6]);a.slabs=[rectangle(0,0,.5,1),rectangle(.5,0,1,1)];
        expect(lampPositions(a)).toHaveLength(1);near(lampPositions(a)[0],[4,3]);
        a.slabs=[rectangle(0,0,.4,1),rectangle(.6,0,1,1)];
        const positions=lampPositions(a);expect(positions).toHaveLength(2);
        expect(positions.every(([x])=>x<3.2||x>4.8)).toBe(true);
    });
    it('does not connect across a wall thinner than a raster cell',()=>{
        const a=apartment();a.walls=[rectangle(.4999,0,.5001,1)];
        expect(lampPositions(a)).toHaveLength(2);
    });
    it('is deterministic and does not mutate its architecture',()=>{
        const a=apartment();a.walls=[rectangle(.499,0,.501,1)];
        const before=JSON.stringify(a),first=lampPositions(a);
        expect(lampPositions(a)).toEqual(first);expect(JSON.stringify(a)).toBe(before);
    });
    it.each([undefined,{}, {dimensionsM:[null,6]}, {...apartment(),slabs:[]}, {...apartment(),walls:[[[[NaN,0],[1,0],[1,1]]]]}])('omits unsupported geometry %j',input=>{
        expect(lampPositions(input)).toEqual([]);
    });
});
