import {describe,it,expect,vi} from 'vitest';
import {createDguParcelSource} from '../parcels/dgu-source.js';
import {parcelSourceCatalog} from '../parcels/sources.js';
const descriptor=parcelSourceCatalog.sources.find(s=>s.id==='hr-dgu-oss-dkp-cestice');
const geometry={type:'Polygon',coordinates:[[[15.97,45.81],[15.971,45.81],[15.971,45.811],[15.97,45.81]]]};
const raw={type:'Feature',id:'DKP_CESTICE.9',geometry,properties:{CESTICA_ID:9,MATICNI_BROJ_KO:123456,BROJ_CESTICE:'01/2'}};
const response=features=>new Response(JSON.stringify({type:'FeatureCollection',features,totalFeatures:features.length}));
describe('DGU composite cadastral identity',()=>{
 it('preserves municipality/number identity across exact and footprint queries',async()=>{
  const fetchImpl=vi.fn(async()=>response([raw]));const source=createDguParcelSource(descriptor,{fetchImpl,token:'test-token'});
  const bounds=await source.queryBounds([15.97,45.81,15.971,45.811]);expect(bounds.features[0].id).toBe('HR-123456-01/2');expect(bounds.features[0].properties.sourceProperties).not.toHaveProperty('GEOM');
  expect((await source.queryIds(['HR-123456-01/2'])).features).toEqual(bounds.features);
  const url=new URL(fetchImpl.mock.calls.at(-1)[0]);expect(url.searchParams.get('cql_filter')).toBe("(MATICNI_BROJ_KO=123456 AND BROJ_CESTICE='01/2')");expect(url.searchParams.get('sortBy')).toBe('CESTICA_ID');expect(url.searchParams.get('token')).toBe('test-token');
  expect((await source.queryGeometry(geometry)).features).toEqual(bounds.features);
 });
 it('rejects invalid keys before transport',async()=>{
  const fetchImpl=vi.fn();const source=createDguParcelSource(descriptor,{fetchImpl,token:'test-token'});
  await expect(source.queryIds(["HR-123456-1' OR 1=1"])).rejects.toThrow();expect(fetchImpl).not.toHaveBeenCalled();
 });
 it('fails closed for missing credentials, malformed identity/counts and redacts transport errors',async()=>{
  await expect(createDguParcelSource(descriptor,{token:''}).queryBounds([15.97,45.81,15.971,45.811])).rejects.toThrow(/not configured/);
  for(const payload of [{type:'FeatureCollection',features:[raw]},{type:'FeatureCollection',totalFeatures:1,features:[{...raw,properties:{...raw.properties,MATICNI_BROJ_KO:null}}]}]) await expect(createDguParcelSource(descriptor,{token:'secret',fetchImpl:async()=>new Response(JSON.stringify(payload))}).queryBounds([15.97,45.81,15.971,45.811])).rejects.toThrow();
  await expect(createDguParcelSource(descriptor,{token:'secret',fetchImpl:async()=>{throw Error('URL includes secret');}}).queryBounds([15.97,45.81,15.971,45.811])).rejects.toThrow('DGU parcel provider is unavailable.');
 });
});
