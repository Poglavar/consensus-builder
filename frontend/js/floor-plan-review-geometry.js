// Pure coordinate and triangle conversion for the archive's georeferenced building preview.
(function(global){
'use strict';
function locationValid(location){return location && Number.isFinite(location.longitude)&&Number.isFinite(location.latitude)&&Math.abs(location.longitude)<=180&&Math.abs(location.latitude)<=90;}
function projectAt(location){
 if(!locationValid(location))throw new Error('A finite WGS84 location is required');
 const scaleX=111320*Math.cos(location.latitude*Math.PI/180);
 return (longitude,latitude)=>[(longitude-location.longitude)*scaleX,(latitude-location.latitude)*111320];
}
function trianglePositions(geometry,project,groundZ){
 if(!Number.isFinite(groundZ))throw new Error('Missing vertical datum');
 const polygons=geometry?.type==='MultiPolygon'?geometry.coordinates:geometry?.type==='Polygon'?[geometry.coordinates]:[];
 const positions=[];
 for(const polygon of polygons){
  if(polygon.length!==1)throw new Error('Landmark face with holes needs triangulation');
  const ring=polygon[0];
  if(!Array.isArray(ring)||ring.some(p=>p.length<3||!p.slice(0,3).every(Number.isFinite)))throw new Error('Invalid landmark face');
  const vertices=ring.length>1&&ring[0].slice(0,3).every((v,i)=>v===ring.at(-1)[i])?ring.slice(0,-1):ring;
  if(vertices.length!==3)throw new Error('Expected triangulated landmark faces');
  for(const p of vertices)positions.push(...project(p[0],p[1]),p[2]-groundZ);
 }
 return positions;
}
const api={locationValid,projectAt,trianglePositions};global.__floorPlanReviewGeometry=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
