import { describe, it, expect, vi } from 'vitest';
import { createDdaParcelSource, DDA_VIEWER, DDA_PLOTS } from '../parcels/dda-source.js';
const descriptor = { id:'dda-fixture', endpoint:DDA_PLOTS, idField:'PLOT_NUMBER', idType:'string', objectIdField:'OBJECTID', idPrefix:'DDA-', outFields:['OBJECTID','PLOT_NUMBER'], pageSize:500 };
const bbox = [55.156,25.094,55.157,25.095];
const empty = () => new Response(JSON.stringify({type:'FeatureCollection',features:[],exceededTransferLimit:false}));
const viewer = (token='anonymous-session', endpoint=DDA_PLOTS) => new Response('var AppSettings = '+JSON.stringify({PLOT_LAYER_URL:endpoint,AGSToken:token})+';');
it('gets the anonymous session once for concurrent reads and refreshes its bounded memory cache', async()=>{
 let time=0, viewers=0;
 const fetchImpl=vi.fn(async(input,options)=>{
  if(input===DDA_VIEWER){viewers++;return viewer('session-'+viewers);}
  const url=new URL(input);expect(url.searchParams.get('token')).toBe('session-'+viewers);
  expect(new Headers(options.headers).get('Referer')).toBe(DDA_VIEWER);return empty();
 });
 const source=createDdaParcelSource(descriptor,{fetchImpl,now:()=>time});
 await Promise.all([source.queryBounds(bbox),source.queryBounds(bbox)]);
 expect(viewers).toBe(1);
 time=61000;await source.queryBounds(bbox);expect(viewers).toBe(2);
});
it('renews an expired public session once',async()=>{
 let attempts=0,viewers=0;
 const fetchImpl=vi.fn(async input=>{
  if(input===DDA_VIEWER){viewers++;return viewer('session-'+viewers);}
  attempts++;return attempts===1?new Response(JSON.stringify({error:{code:498}})):empty();
 });
 await expect(createDdaParcelSource(descriptor,{fetchImpl}).queryBounds(bbox)).resolves.toMatchObject({complete:true});
 expect(attempts).toBe(2);expect(viewers).toBe(2);
});
it.each([403,429])('preserves provider HTTP %s without renewing or looping',async status=>{
 const fetchImpl=vi.fn(async input=>input===DDA_VIEWER?viewer():new Response('{}',{status,headers:{'Retry-After':'45'}}));
 await expect(createDdaParcelSource(descriptor,{fetchImpl}).queryBounds(bbox)).rejects.toMatchObject({upstreamStatus:status,...(status===429?{retryAfterSeconds:45}:{})});
 expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it('adds the public session to long form POST requests without altering the fixed exact-ID scope',async()=>{
 const ids=Array.from({length:80},(_,i)=>'DDA-'+('x'.repeat(35)+i));
 const fetchImpl=vi.fn(async(input,options)=>{
  if(input===DDA_VIEWER)return viewer();
  expect(options.method).toBe('POST');expect(new URL(input).searchParams.has('token')).toBe(false);
  const body=new URLSearchParams(options.body);expect(body.get('token')).toBe('anonymous-session');
  expect(body.get('where')).toContain("PLOT_NUMBER IN ('");return empty();
 });
 const result=await createDdaParcelSource(descriptor,{fetchImpl}).queryIds(ids);expect(result.absentIds).toEqual(ids);
});
it('never sends the session to a viewer-supplied alternate endpoint',async()=>{
 const fetchImpl=vi.fn(async()=>viewer('anonymous-session','https://example.com/private'));
 await expect(createDdaParcelSource(descriptor,{fetchImpl}).queryBounds(bbox)).rejects.toThrow(/configuration/);
 expect(fetchImpl).toHaveBeenCalledTimes(1);
 expect(()=>createDdaParcelSource({...descriptor,endpoint:'https://example.com'})).toThrow(/endpoint/);
});
it('fails gracefully when the public viewer no longer supplies a session',async()=>{
 await expect(createDdaParcelSource(descriptor,{fetchImpl:async()=>new Response('<html>changed</html>')}).queryBounds(bbox)).rejects.toThrow(/configuration/);
});
