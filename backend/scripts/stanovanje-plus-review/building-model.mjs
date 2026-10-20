// Local-metre outline stack for private review, independent of map registration.
const count=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
export function buildingOutline(evidence,architecture){
 if(!evidence||!count(evidence.aboveGroundCount,1,100)||!count(evidence.belowGroundCount,0,10))return null;
 const dimensions=architecture?.dimensionsM;
 if(!Array.isArray(dimensions)||dimensions.length!==2||!dimensions.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0))return null;
 const outlines=(architecture.slabs||[]).map(p=>p[0]?.map(q=>[q[0]*dimensions[0],q[1]*dimensions[1]]));
 if(!outlines.length||outlines.some(r=>!r||r.length<3||r.some(p=>!p.every(Number.isFinite))))return null;
 const levels=Array.from({length:evidence.aboveGroundCount+evidence.belowGroundCount},(_,i)=>i-evidence.belowGroundCount);
 const measured=new Map((evidence.storeyHeights||[]).filter(s=>levels.includes(s.level)&&typeof s.heightM==='number'&&Number.isFinite(s.heightM)&&s.heightM>0&&typeof s.basis==='string'&&s.basis.trim()&&typeof s.sourceUrl==='string'&&s.sourceUrl.trim()).map(s=>[s.level,s]));
 const heightAt=level=>measured.get(level)?.heightM??3;
 let elevationM=-levels.filter(l=>l<0).reduce((total,level)=>total+heightAt(level),0);
 const storeys=levels.map(level=>{
  const heightM=heightAt(level),source=measured.get(level);
  const floor={level,label:level<0?`Basement ${-level}`:level===0?'Ground floor':`Floor ${level}`,elevationM,heightM,heightBasis:source?'source':'estimated',heightEvidence:source||null,outlines};
  elevationM+=heightM;return floor;
 });
 const characteristicLevels=(evidence.characteristicLevels||[]).filter(level=>Number.isInteger(level)&&levels.includes(level));
 return {
  schema:'stanovanje-plus.private-building-outline.v1',code:evidence.code,
  aboveGroundCount:evidence.aboveGroundCount,belowGroundCount:evidence.belowGroundCount,
  source:evidence.source,drawings:evidence.drawings||[],dimensionsM:dimensions,sectionMeasurements:evidence.sectionMeasurements||null,
  assumedStoreyHeightM:3,heightBasis:measured.size===levels.length?'source':measured.size?'mixed':'estimated',
  characteristicLevels,
  outlineBasis:'Representative floor silhouette repeated schematically; individual storey outlines are not established.',
  limitations:[...(evidence.limitations||[]),'Basement, ground-floor, roof and setback outlines may differ from the representative floor.','Only the selected representative floor has reconstructed interiors; other floors are outlines.'],
  storeys
 };
}
export function floorPreview(model,level){
 if(!model)return {storeys:[],placement:null};
 if(level===null)return {storeys:model.storeys,placement:null};
 const floor=model.storeys.find(s=>s.level===level);
 if(!floor)return {storeys:[],placement:null};
 return {storeys:model.storeys.filter(s=>s.level<=level),placement:{level,elevationM:floor.elevationM,verified:model.characteristicLevels.includes(level)}};
}
