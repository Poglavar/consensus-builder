// Second-pass: cluster proposals.js top-level functions into cohesive candidate modules
// by name-keyword + line locality, and report the full window.* global surface.
const fs = require('fs');
const acorn = require('acorn');
const FILE = process.argv[2];
const src = fs.readFileSync(FILE, 'utf8');
const map = JSON.parse(fs.readFileSync('map.json', 'utf8'));
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });

// FULL global surface: every `window.X =` anywhere (top-level + nested in functions).
const globalNames = new Set();
const re = /window\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?!=)/g;
let m; while ((m = re.exec(src))) globalNames.add(m[1]);

// Function inventory sorted by line.
const fns = Object.entries(map.topFns).map(([name, v]) => ({ name, sl: v.sl, el: v.el, len: v.el - v.sl + 1 }))
  .sort((a, b) => a.sl - b.sl);

// Keyword -> category buckets (first match wins, order matters).
const RULES = [
  ['chain/nft',      /chain|nft|mint|onchain|wallet|ethers|solana|evm|contract|token|walrus|ipfs|metadata|attest/i],
  ['execution',      /execut|distribut|acceptance|accept|consent|ownershiptransfer|transfer|sale|sell|settle|reward/i],
  ['create-dialog',  /createproposal|proposaldialog|dialog|modal|facet|pill|wizard|screenshot|preview/i],
  ['details-panel',  /proposaldetails|detailspanel|infopanel|proposalinfo|boost|donate|offerbar/i],
  ['urban-rules',    /urbanrule|typology|contiguity|buildingrule|landuse|zoning|setback|envelope/i],
  ['roads-tracks',   /road|track|corridor|segment|centerline|carriageway|curb/i],
  ['reparcel',       /reparcel|reparcell|split|merge|subdivid|block/i],
  ['geometry',       /geometry|geojson|feature|polygon|bbox|bounds|centroid|area|coord|projection|turf/i],
  ['parcel-id',      /parcelid|normalizeparcel|ancestor|descend|getparcel/i],
  ['layer-render',   /layer|render|draw|highlight|style|color|leaflet|marker|popup|redraw|paint/i],
  ['storage',        /storage|persist|localstorage|save|load|serialize|deserialize|hash|migrat/i],
  ['sharing',        /share|encode|decode|deeplink|url|permalink|compress|pako/i],
  ['list-ui',        /proposallist|list|sidebar|panel|toggle|checkbox|button|tab|accordion/i],
  ['3d',             /3d|three|station3d|cab|walk|gltf|mesh|extrud/i],
  ['notify',         /notif|toast|alert|celebrat|popup|progress|overlay|spinner|status/i],
  ['i18n',           /i18n|translat|locale|lang|t\(/i],
];
function categorize(name) {
  for (const [cat, rx] of RULES) if (rx.test(name)) return cat;
  return 'misc';
}

const byCat = new Map();
for (const f of fns) {
  const c = categorize(f.name);
  if (!byCat.has(c)) byCat.set(c, { fns: [], lines: 0, minL: Infinity, maxL: 0 });
  const b = byCat.get(c); b.fns.push(f); b.lines += f.len; b.minL = Math.min(b.minL, f.sl); b.maxL = Math.max(b.maxL, f.el);
}

console.log('=== FULL GLOBAL SURFACE (window.* anywhere):', globalNames.size, 'names ===');
console.log([...globalNames].sort().join(', '));

console.log('\n=== CANDIDATE MODULES (by concern) — fns / total LOC / line span ===');
const cats = [...byCat.entries()].sort((a, b) => b[1].lines - a[1].lines);
for (const [cat, b] of cats) {
  const span = b.maxL - b.minL + 1;
  const density = (b.lines / span * 100).toFixed(0);
  console.log(`\n## ${cat.toUpperCase()}  —  ${b.fns.length} fns, ${b.lines} LOC, span L${b.minL}-${b.maxL} (${density}% contiguous)`);
  // show the biggest few fns in the category
  b.fns.sort((a,c)=>c.len-a.len).slice(0,6).forEach(f=>console.log(`     ${f.name} (L${f.sl}-${f.el}, ${f.len})`));
}

// shared-state x category: which categories touch each shared mutable var (coupling map)
console.log('\n=== SHARED-STATE COUPLING (which categories read each shared var) ===');
const fnCat = new Map(fns.map(f => [f.name, categorize(f.name)]));
for (const sv of map.sharedMutable) {
  const readers = Object.entries(map.refs).filter(([fn, used]) => used.includes(sv.name)).map(([fn]) => fnCat.get(fn));
  const cats = [...new Set(readers)].filter(Boolean);
  console.log(`  ${sv.name}: ${cats.join(', ')}`);
}
