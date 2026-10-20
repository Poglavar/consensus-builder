// Explicit private geometry pass: no network, database, model calls or publication.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {alignFloor} from './stanovanje-plus-review/align-floor.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../logs/stanovanje-plus-ten-20261019');
const selection=JSON.parse(fs.readFileSync(path.join(root,'selection.json'))),codes=process.argv.slice(2);
if(!codes.length){console.log('Usage: node stanovanje-plus-align.mjs <original-code> ...');process.exit(0);}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const code of codes){
 if(!selection.some(s=>s.code===code))throw Error('Outside original trial: '+code);
 const dir=path.join(root,code),filename=fs.existsSync(path.join(dir,'model.refined.json'))?'model.refined.json':'model.json';
 const bytes=fs.readFileSync(path.join(dir,filename)),evidenceBytes=fs.readFileSync(path.join(dir,'geographic-evidence.json'));
 const model=JSON.parse(bytes),evidence=JSON.parse(evidenceBytes);
 if(evidence.code!==code)throw Error('Geographic evidence identity mismatch');
 const result=alignFloor({code,architecture:model.architecture,evidence,modelSha256:hash(bytes)});
 result.geographicEvidenceSha256=hash(evidenceBytes);
 fs.writeFileSync(path.join(dir,'alignment.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({code,status:result.status,bestIou:result.bestIou,partMargin:result.partMargin,defaultCandidateId:result.defaultCandidateId}));
}
