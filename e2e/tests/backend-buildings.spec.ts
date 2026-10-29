import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles } from '../helpers/runtime';
const geometry={type:'Polygon',coordinates:[[[-73.6267,4.1419],[-73.6266,4.1419],[-73.6266,4.1420],[-73.6267,4.1420],[-73.6267,4.1419]]]};

test('a city without its own survey fills its footprints through backend OSM',async({mockApi:page})=>{
 await stubBasemapTiles(page);
 const asked:any[]=[];const tiles:string[]=[];
 page.on('request',r=>{if(new URL(r.url()).hostname.includes('overturemaps'))tiles.push(r.url());});
 await page.route('**/buildings/cell',route=>{
  asked.push(route.request().postDataJSON());
  return route.fulfill({json:{supported:true,complete:true,source:'osm-footprints',items:[{id:'w24518461',geometry,height_m:21,floors:null}]}});
 });
 await page.goto('/?at=4.1420,-73.6266,18&lang=en&reduceMotion=1',{waitUntil:'domcontentloaded'});await waitForMapReady(page);
 expect(await page.evaluate(()=>(window as any).CityConfigManager.getCurrentCityConfig().buildings.source)).toBe('osm');
 await page.evaluate(()=>(window as any).ensureBuildingFootprintsForBounds((window as any).map.getBounds()));
 await expect.poll(()=>page.evaluate(()=>((window as any).buildingFeaturePool||[]).map((f:any)=>f.properties.id))).toContain('w24518461');
 expect(asked.length).toBeGreaterThan(0);expect(asked[0].city).toBeUndefined();expect(asked[0].source).toBe('osm');expect(tiles).toEqual([]);
});

test('a dedicated cadastral building source is stood in for by backend OSM, cell by cell, where it has nothing',async({mockApi:page})=>{
 await stubBasemapTiles(page);
 const asked:any[]=[];
 await page.route('**/buildings/cell',route=>{
  const body=route.request().postDataJSON();asked.push(body);
  return route.fulfill({json:{supported:true,complete:true,source:body.source==='osm'?'osm-footprints':'custom-footprints',items:body.source==='osm'?[{id:'w1',geometry}]:[]}});
 });
 await page.goto('/?city=bogota&at=4.6105,-74.0822,18&lang=en&reduceMotion=1',{waitUntil:'domcontentloaded'});await waitForMapReady(page);
 // A geometry request reads the city's own survey only: no stand-in is chosen there.
 await page.evaluate(()=>(window as any).BuildingSourceClient.request('/buildings/footprints',{geometry:{type:'Point',coordinates:[-74.0822,4.6105]}}));
 await page.evaluate(()=>(window as any).ensureBuildingFootprintsForBounds((window as any).map.getBounds()));
 await expect.poll(()=>page.evaluate(()=>((window as any).buildingFeaturePool||[]).filter((f:any)=>f.properties.id==='w1').map((f:any)=>f.properties.source))).toEqual(['osm']);
 expect(asked.some(b=>b.source?.startsWith('building.'))).toBe(true);expect(asked.some(b=>b.source==='osm')).toBe(true);
});

test('frontend sends the selected NYC or Zagreb dataset independently of the current view',async({mockApi:page})=>{
 await stubBasemapTiles(page);
 const asked:any[]=[];
 await page.route('**/buildings/near',route=>{
  asked.push(route.request().postDataJSON());return route.fulfill({json:{buildings:[],count:0,source:'fixture'}});
 });
 await page.goto('/?at=45.81305,15.9706,18&lang=en&reduceMotion=1',{waitUntil:'domcontentloaded'});await waitForMapReady(page);
 await page.evaluate(async()=>{
  const client=(window as any).BuildingSourceClient;
  await client.request('/buildings/near',{geometry:{type:'Point',coordinates:[-74.006,40.7128]}});
  await client.request('/buildings/near',{geometry:{type:'Point',coordinates:[15.9706,45.81305]}});
 });
 expect(asked.map(b=>[b.source,b.floorModelNamespace])).toEqual([['nyc-arcgis','new_york'],['gdi-3d','zagreb']]);
 expect(asked.every(b=>b.city===undefined)).toBe(true);
});
