// Drawing x is right, y is down. Registered scene x is east, y is north.
export function drawingMatrix({scale,rotationDeg,tx,ty}){
 const angle=rotationDeg*Math.PI/180,c=Math.cos(angle)*scale,s=Math.sin(angle)*scale;
 return [c,s,s,-c,tx,ty];
}
export function registeredPoint([x,y],[a,b,c,d,tx,ty]){return [a*x+c*y+tx,b*x+d*y+ty];}
export function registrationCandidate(registration,id){return registration?.candidates?.find(c=>c.id===id)||null;}
export function previewCandidates(registration){
 return (registration?.candidates||[]).filter(c=>c.iou>=.75&&(c.rank===0||(c.orientationStatus==='ambiguous'&&candidatesBest(c.partId)-c.iou<.03)));
 function candidatesBest(partId){return Math.max(...registration.candidates.filter(c=>c.partId===partId).map(c=>c.iou));}
}
export function boundRegistration(saved,modelSha256,geographicEvidenceSha256){
 if(!saved)return null;
 if(saved.modelSha256!==modelSha256||saved.geographicEvidenceSha256!==geographicEvidenceSha256)return {status:'stale',candidates:[],targets:[],defaultCandidateId:null,reason:'Alignment inputs changed; rerun the private geometry fit.'};
 return saved;
}
