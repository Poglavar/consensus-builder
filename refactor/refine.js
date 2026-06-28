// Refine: shared-state coupling + drain the misc bucket with sharper rules.
const fs = require('fs');
const map = JSON.parse(fs.readFileSync('map.json', 'utf8'));
const fns = Object.entries(map.topFns).map(([name, v]) => ({ name, sl: v.sl, el: v.el, len: v.el - v.sl + 1 }));

const RULES = [
  ['chain-nft',     /chain|nft|mint|onchain|wallet|ethers|solana|evm|erc20|contract|token|walrus|ipfs|metadata|attest|balance/i],
  ['execution',     /execut|distribut|acceptance|\baccept|consent|ownership|transfer|\bsale\b|\bsell|settle|reward|reject|claim|recipient/i],
  ['create',        /createproposal|createstructure|submitproposal/i],
  ['dialog-modal',  /dialog|modal|wizard|screenshot|preview|popup|inspector|gate/i],
  ['details-panel', /proposaldetails|detailspanel|infopanel|proposalinfo|showproposalinfo|boost|donate|offerbar|showroadproposalinfo/i],
  ['urban-rules',   /urbanrule|typology|contiguity|buildingrule|landuse|zoning|setback|envelope|structure/i],
  ['roads-tracks',  /road|track|corridor|segment|carriageway|curb|serialise/i],
  ['reparcel',      /reparcel|reparcell|blockify|subdivid/i],
  ['geometry',      /geometry|geojson|\bfeature|polygon|bbox|bounds|centroid|\barea|coord|projection|turf|lake|zone|thumb/i],
  ['parcel-id',     /parcelid|normalizeparcel|ancestor|descend|getparcel|parcelrecord|parcelnumber|parceldisplay/i],
  ['layer-render',  /layer|render|draw|highlight|style|\bpane|leaflet|marker|popup|redraw|paint|group|center|focus|map\b/i],
  ['storage',       /storage|persist|localstorage|\bsave|\bload|serialize|deserialize|\bhash|migrat|payload|import|export|download|cache/i],
  ['sharing',       /share|encode|decode|deeplink|\burl|permalink|compress|pako|link|route/i],
  ['lifecycle',     /expir|decay|countdown|lifecycle|status|offer|value|format|parse/i],
  ['list-ui',       /proposallist|\blist|sidebar|panel|toggle|checkbox|button|\btab\b|accordion|item|multiselect|multiparcel|selection/i],
  ['i18n',          /translat|locale|\blang|ensure.*translation/i],
];
const cat = (n) => { for (const [c, rx] of RULES) if (rx.test(n)) return c; return 'misc'; };

const byCat = new Map();
for (const f of fns) { const c = cat(f.name); if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(f); }

console.log('=== REFINED CATEGORIES ===');
for (const [c, arr] of [...byCat.entries()].sort((a,b)=>b[1].reduce((s,f)=>s+f.len,0)-a[1].reduce((s,f)=>s+f.len,0))) {
  const loc = arr.reduce((s,f)=>s+f.len,0);
  console.log(`${c.padEnd(14)} ${String(arr.length).padStart(3)} fns  ${String(loc).padStart(5)} LOC`);
}
console.log('\n=== REMAINING MISC (need manual placement) ===');
(byCat.get('misc')||[]).sort((a,b)=>b.len-a.len).forEach(f=>console.log(`  ${f.name} (L${f.sl}, ${f.len} LOC)`));

console.log('\n=== SHARED-STATE COUPLING: which categories read each shared var ===');
const fnCat = new Map(fns.map(f => [f.name, cat(f.name)]));
for (const sv of map.sharedMutable.sort((a,b)=>b.readers-a.readers)) {
  const cats = [...new Set(Object.entries(map.refs).filter(([fn, used]) => used.includes(sv.name)).map(([fn]) => fnCat.get(fn)).filter(Boolean))];
  console.log(`  ${sv.name.padEnd(34)} <- ${cats.join(', ')}`);
}
