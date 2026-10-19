// Official HMLR partition discovery and immutable archive revision checks.
import { load } from 'cheerio';
import { officialArchiveFetch, boundedBytes } from './gml-snapshot-source.js';

export const HMLR_CATALOGUE='https://use-land-property-data.service.gov.uk/datasets/inspire/download';
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];

export function parseHmlrCatalogue(html){
 const $=load(html),text=$('body').text(),date=/This dataset was published on\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text);
 if(!date||!MONTHS.includes(date[2]))throw new Error('Official HMLR catalogue has no verified publication date.');
 const sourceDate=`${date[3]}-${String(MONTHS.indexOf(date[2])+1).padStart(2,'0')}-${date[1].padStart(2,'0')}`;
 if(new Date(sourceDate).toISOString().slice(0,10)!==sourceDate)throw new Error('Invalid HMLR publication date.');
 const byName=new Map();$('a[href]').each((_i,a)=>{const u=new URL($(a).attr('href'),HMLR_CATALOGUE);if(!u.pathname.endsWith('.zip'))return;
  if(u.origin!==new URL(HMLR_CATALOGUE).origin||u.search||u.hash||!/^\/datasets\/inspire\/download\/[A-Za-z_-]+\.zip$/.test(u.pathname))throw new Error('Unexpected official HMLR authority archive link.');
  const name=u.pathname.split('/').at(-1).slice(0,-4);if(byName.has(name))throw new Error('Duplicate HMLR authority partition.');byName.set(name,{name,endpoint:u.href});});
 const authorities=[...byName.values()].sort((a,b)=>a.name<b.name?-1:1);
 if(authorities.length<250||authorities.length>500||!['Oxford_City_Council','Cherwell_District_Council','City_of_London_Corporation','Manchester_City_Council','Cardiff_Council'].every(n=>byName.has(n)))throw new Error('Official national HMLR partition catalogue is incomplete or changed.');
 return {sourceDate,authorities};
}
export async function fetchHmlrCatalogue({fetchArchive=officialArchiveFetch}={}){
 const signal=AbortSignal.timeout(60000),response=await fetchArchive(HMLR_CATALOGUE,{signal});
 try{if(response.status!==200||!response.ok)throw new Error(`HMLR catalogue request failed (HTTP ${response.status}).`);
  const bytes=await boundedBytes(response,1024*1024,signal);return parseHmlrCatalogue(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
}
async function retryFetch(endpoint,options){
 for(let attempt=1;attempt<=3;attempt++)try{const response=await officialArchiveFetch(endpoint,options);if([500,502,503,504].includes(response.status)&&attempt<3){await response.body?.cancel().catch(()=>{});continue;}return response;}
 catch(error){if(attempt===3||options.signal?.aborted||!['TypeError','AbortError','TimeoutError'].includes(error.name))throw error;}
}
export async function pinHmlrAuthority(authority,{fetchArchive=retryFetch}={}){
 const response=await fetchArchive(authority.endpoint,{signal:AbortSignal.timeout(60000)});
 try{const etag=response.headers.get('etag'),bytes=response.headers.get('content-length');
  if(response.status!==200||!response.ok||!/^"[\x21\x23-\x7e]{1,200}"$/.test(etag||'')||!/^[0-9]+$/.test(bytes||'')||!Number.isSafeInteger(Number(bytes))||Number(bytes)<22||Number(bytes)>128*1024*1024)throw new Error('HMLR authority has no bounded strong content revision.');
  return {...authority,expectedEtag:etag,expectedBytes:Number(bytes)};
 }finally{await response.body?.cancel().catch(()=>{});}
}
