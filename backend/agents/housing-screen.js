// Bounded OSM evidence for housing research; incomplete upstream replies refuse autonomous publication.
import { createOverpassCellSource, overpassElementsToGeoJSON } from '../buildings/osm-reference.js';
import { overpassRoadsToFeatures } from '../roads/osm-road-overpass.js';
export function housingQuery([w,s,e,n]) {
    const box=`(${s},${w},${n},${e})`;
    return `[out:json][timeout:25];(nwr["building"]${box};way["highway"]${box};way["railway"]${box};nwr["leisure"]${box};nwr["landuse"~"^(cemetery|forest|recreation_ground|military)$"]${box};nwr["natural"~"^(water|wetland|wood)$"]${box};nwr["amenity"~"^(school|hospital|place_of_worship|college|university)$"]${box};nwr["public_transport"]${box};node["highway"="bus_stop"]${box};node["railway"="station"]${box};);out geom;`;
}
export function housingFeatures(elements, cap=10000, response={}) {
    if (response.remark || !Array.isArray(elements)) throw new Error('Incomplete Overpass housing evidence');
    const buildings=overpassElementsToGeoJSON(elements,cap);
    const roads=overpassRoadsToFeatures(elements,cap,{railways:true});
    const features=[...buildings.features.map(f=>({...f,id:`building-${f.id}`,properties:{...f.properties,screen:'building'}})),
        ...roads.features.map(f=>({...f,id:`road-${f.id}`,properties:{...f.properties,screen:'corridor'}}))];
    for (const el of elements || []) {
        const t=el.tags || {};
        if(t.building && Number.isFinite(el.lon) && Number.isFinite(el.lat)) features.push({type:'Feature',id:`building-node-${el.id}`,properties:{screen:'building'},geometry:{type:'Point',coordinates:[el.lon,el.lat]}});
        const transit=t.highway==='bus_stop' || t.railway==='station' || ['platform','station','stop_position'].includes(t.public_transport);
        if(transit && Number.isFinite(el.lon) && Number.isFinite(el.lat)) features.push({type:'Feature',id:`stop-${el.type}-${el.id}`,properties:{screen:'transit'},geometry:{type:'Point',coordinates:[el.lon,el.lat]}});
        const protectedUse=t.leisure || ['cemetery','forest','recreation_ground','military'].includes(t.landuse) || ['water','wetland','wood'].includes(t.natural) || ['school','hospital','place_of_worship','college','university'].includes(t.amenity);
        if (!protectedUse) continue;
        const geometries=el.type==='relation' ? (el.members||[]).filter(m=>m.role==='outer').map(m=>m.geometry) : [el.geometry];
        let made=false;
        for (const geometry of geometries) {
            const ring=(geometry||[]).filter(p=>Number.isFinite(p.lon)&&Number.isFinite(p.lat)).map(p=>[p.lon,p.lat]);
            if (ring.length<4 || ring[0][0]!==ring.at(-1)[0] || ring[0][1]!==ring.at(-1)[1]) continue;
            features.push({type:'Feature',id:`protected-${el.type}-${el.id}-${features.length}`,properties:{screen:'protected'},geometry:{type:'Polygon',coordinates:[ring]}}); made=true;
        }
        if (!made && Number.isFinite(el.lon) && Number.isFinite(el.lat)) features.push({type:'Feature',id:`protected-${el.type}-${el.id}`,properties:{screen:'protected'},geometry:{type:'Point',coordinates:[el.lon,el.lat]}});
    }
    return {features:features.slice(0,cap),truncated:buildings.truncated || roads.truncated || features.length>cap};
}
const fetchEvidence=createOverpassCellSource({label:'affordabot-screen',buildQuery:housingQuery,convert:housingFeatures,featureCap:10000});
export function screenHousingParcels(parcels,evidence,{turf,area,now=new Date()}={}) {
    if (!evidence || evidence.partial || evidence.truncated || !Array.isArray(evidence.features)) throw new Error('Affordabot requires complete OSM screening replies');
    const overlaps=(a,b)=>!(a[2]<b[0] || a[0]>b[2] || a[3]<b[1] || a[1]>b[3]);
    const grounds=parcels.map(p=>{const feature=turf.feature(p.geometry);return {feature,box:turf.bbox(feature)};});
    const obstacles=[];
    for(const feature of evidence.features) {
        if(feature.properties.screen==='transit') continue;
        // Geographic expansion overestimates the metric buffer, then exact geometry decides.
        const width=feature.properties.screen==='corridor' ? Math.max(8,(feature.properties.width_meters||0)/2+3) : feature.geometry.type==='Point' ? 20 : 0;
        const box=turf.bbox(feature), lat=Math.max(Math.abs(box[1]),Math.abs(box[3]));
        const dy=width/110000, dx=dy/Math.max(0.01,Math.cos(lat*Math.PI/180));
        const expanded=[box[0]-dx,box[1]-dy,box[2]+dx,box[3]+dy];
        if(!grounds.some(g=>overlaps(g.box,expanded))) continue;
        const obstacle=width ? turf.buffer(feature,width,{units:'meters'}) : feature;
        if(!obstacle) throw new Error('Invalid housing screening geometry');
        obstacles.push({feature:obstacle,box:turf.bbox(obstacle)});
    }
    const stops=evidence.features.filter(f=>f.properties.screen==='transit');
    return parcels.map((p,index)=>{
        const ground=grounds[index].feature, center=turf.pointOnFeature(ground);
        const excluded=obstacles.some(f=>overlaps(grounds[index].box,f.box) && turf.booleanIntersects(ground,f.feature));
        const distances=stops.map(f=>turf.distance(center,f,{units:'meters'}));
        return {...p,housingArea:area,housingScreen:{complete:true,excluded,
            transitDistanceM:distances.length?Math.min(...distances):null,source:'OpenStreetMap via Overpass (ODbL)',
            observedAt:now.toISOString(),featuresReturned:evidence.features.length,vacancyVerified:false,roadInventoryComplete:false,buildingInventoryComplete:false}};
    });
}
export async function fetchHousingScreen(parcels,bbox,options) {
    return screenHousingParcels(parcels,await fetchEvidence(bbox),options);
}
