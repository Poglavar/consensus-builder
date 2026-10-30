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
 expect(await page.evaluate(()=>(window as any).CityConfigManager.getBuildingSources().map((s:any)=>s.id))).toEqual(['osm']);
 await page.evaluate(()=>(window as any).ensureBuildingFootprintsForBounds((window as any).map.getBounds()));
 await expect.poll(()=>page.evaluate(()=>((window as any).buildingFeaturePool||[]).map((f:any)=>f.properties.id))).toContain('w24518461');
 expect(asked.length).toBeGreaterThan(0);expect(asked[0].city).toBeUndefined();expect(asked[0].source).toBe('osm');expect(tiles).toEqual([]);
});

test('a city URL source is read in the browser, with OpenStreetMap from our server standing in where it has nothing',async({mockApi:page})=>{
 await stubBasemapTiles(page);
 const asked:any[]=[];
 await page.route('**/buildings/cell',route=>{
  const body=route.request().postDataJSON();asked.push(body);
  // A building inside the cell asked for: the loader files each building under the cell holding its first vertex.
  const [w,s]=body.bbox;const inCell={type:'Polygon',coordinates:[[[w+1e-5,s+1e-5],[w+5e-5,s+1e-5],[w+5e-5,s+5e-5],[w+1e-5,s+5e-5],[w+1e-5,s+1e-5]]]};
  return route.fulfill({json:{supported:true,complete:true,source:'osm-footprints',items:body.source==='osm'?[{id:'w1',geometry:inCell}]:[]}});
 });
 // Bogotá's cadastre is a public ArcGIS service the adapter worker reads (backend/test/browser-building-cells.test.js);
 // here its reader is stood in for from the first load on, and the cadastre has nothing in any cell.
 await page.addInitScript(()=>{const w=window as any;w.__direct=[];let reader:any;
  Object.defineProperty(w,'BrowserBuildingSources',{configurable:true,get:()=>reader,
   set:value=>{reader={...value,readCell:async(source:string,{kind,bbox}:any)=>{w.__direct.push(source);return {supported:true,kind,bbox,items:[],complete:true};}};}});});
 await page.goto('/?city=bogota&at=4.6105,-74.0822,18&lang=en&reduceMotion=1',{waitUntil:'domcontentloaded'});await waitForMapReady(page);
 await page.evaluate(()=>(window as any).ensureBuildingFootprintsForBounds((window as any).map.getBounds()));
 const direct=await page.evaluate(()=>(window as any).__direct);
 await expect.poll(()=>page.evaluate(()=>((window as any).buildingFeaturePool||[]).filter((f:any)=>f.properties.id==='w1').map((f:any)=>f.properties.source))).toContain('osm');
 expect(direct.length).toBeGreaterThan(0);
 // Our server is asked only for the stand-in: the URL source never reaches it.
 expect(asked.length).toBeGreaterThan(0);expect(asked.every(b=>b.source==='osm')).toBe(true);
});

test('a 3D cell names the evidence namespace of the city it lies in, whatever the view',async({mockApi:page})=>{
 await stubBasemapTiles(page);
 const asked:any[]=[];
 await page.route('**/buildings/cell',route=>{
  asked.push(route.request().postDataJSON());return route.fulfill({json:{supported:true,complete:true,items:[]}});
 });
 await page.goto('/?at=45.81305,15.9706,18&lang=en&reduceMotion=1',{waitUntil:'domcontentloaded'});await waitForMapReady(page);
 await page.evaluate(async()=>{
  const client=(window as any).BuildingSourceClient;
  await client.requestCell({kind:'near',source:'nyc-arcgis',bbox:[-74.007,40.712,-74.005,40.713]});
  await client.requestCell({kind:'near',source:'gdi-3d',bbox:[15.970,45.812,15.972,45.814]});
 });
 expect(asked.map(b=>[b.source,b.floorModelNamespace])).toEqual([['nyc-arcgis','new_york'],['gdi-3d','zagreb']]);
 expect(asked.every(b=>b.city===undefined)).toBe(true);
});
