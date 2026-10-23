import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles } from '../helpers/runtime';
const geometry={type:'Polygon',coordinates:[[[-73.6267,4.1419],[-73.6266,4.1419],[-73.6266,4.1420],[-73.6267,4.1420],[-73.6267,4.1419]]]};

test('a city without its own survey fills its footprints through backend OSM',async({mockApi:page})=>{
 await stubBasemapTiles(page);
 const asked:any[]=[];const tiles:string[]=[];
 page.on('request',r=>{if(new URL(r.url()).hostname.includes('overturemaps'))tiles.push(r.url());});
 await page.route('**/buildings/footprints',route=>{
  asked.push(route.request().postDataJSON());
  return route.fulfill({json:{supported:true,truncated:false,source:'osm-footprints',footprints:[{id:'w24518461',geometry,height_m:21,floors:null}]}});
 });
 await page.goto('/?at=4.1420,-73.6266,18&lang=en&reduceMotion=1',{waitUntil:'domcontentloaded'});await waitForMapReady(page);
 expect(await page.evaluate(()=>(window as any).CityConfigManager.getCurrentCityConfig().buildings.source)).toBe('osm');
 await page.evaluate(()=>(window as any).ensureBuildingFootprintsForBounds((window as any).map.getBounds()));
 await expect.poll(()=>page.evaluate(()=>((window as any).buildingFeaturePool||[]).map((f:any)=>f.properties.id))).toContain('w24518461');
 expect(asked.length).toBeGreaterThan(0);expect(asked[0].city).toBeUndefined();expect(tiles).toEqual([]);
});

test('a dedicated cadastral building source falls back to backend OSM',async({mockApi:page})=>{
 await stubBasemapTiles(page);
 const asked:any[]=[];
 await page.route('**/buildings/footprints',route=>{
  const body=route.request().postDataJSON();asked.push(body);
  return route.fulfill({json:{supported:true,truncated:false,source:body.source==='osm'?'osm-footprints':'custom-footprints',footprints:body.source==='osm'?[{id:'w1',geometry}]:[]}});
 });
 await page.goto('/?city=bogota&at=4.6105,-74.0822,18&lang=en&reduceMotion=1',{waitUntil:'domcontentloaded'});await waitForMapReady(page);
 const result=await page.evaluate(()=>(window as any).BuildingSourceClient.request('/buildings/footprints',{geometry:{type:'Point',coordinates:[-74.0822,4.6105]}}));
 expect(result.source).toBe('osm-footprints');expect(asked.some(b=>b.source?.startsWith('building.'))).toBe(true);expect(asked.some(b=>b.source==='osm')).toBe(true);
});
