// Build a temporary, same-origin browser maintenance page for the authorized label cleanup.
// It holds the saved-workspace lock, offers a real backup download, and verifies each IDB write.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [output, ...manifests] = process.argv.slice(2);
if (!output || !manifests.length) {
    console.log('Usage: node build-label-cleanup-page.mjs <output.html> <changes.json> [changes.json ...]');
    process.exit(0);
}
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const mappings = {};
for (const file of manifests) Object.assign(mappings, JSON.parse(await fs.readFile(file, 'utf8')).mappings);
const scripts = [
    'vendor/noble-hashes-1.8.0/sha256.js', 'vendor/ipfs-file-cid/ipfs-file-cid.js', 'js/cid.js',
    'js/corridor-profile.js', 'js/corridor-osm-form.js', 'js/proposals/authored-record.js',
    'js/proposals/formation-depth.js', 'js/design-record.js', 'js/plan-record.js',
    'js/agreement-record.js', 'js/publication-label-cleanup.js'
];
const bundled = (await Promise.all(scripts.map(file => fs.readFile(path.join(frontend, file), 'utf8'))))
    .map(source => `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`).join('\n');
const workflow = `
const mappings = ${JSON.stringify(mappings)};
const status = document.querySelector('#status'), download = document.querySelector('#download'), apply = document.querySelector('#apply');
let datasets = [], release;
const lease = new Promise(resolve => { release = resolve; });
const open = name => new Promise((resolve, reject) => {
  const request = indexedDB.open(name);
  request.onupgradeneeded = () => request.transaction.abort();
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
});
const allRows = db => new Promise((resolve, reject) => {
  const request = db.transaction('kv').objectStore('kv').getAll();
  request.onsuccess = () => resolve(request.result.filter(row => /^(proposal|agreement):/.test(row.key)));
  request.onerror = () => reject(request.error);
});
const fail = error => { status.textContent = 'Cleanup is not complete: ' + error.message; apply.disabled = true; };
navigator.locks.request('consensus-builder-saved-workspace', { mode:'exclusive', ifAvailable:true }, async lock => {
  if (!lock) throw new Error('Another map tab is editing this workspace. Close or leave that map tab before retrying.');
  for (const info of await indexedDB.databases()) {
    if (!info.name?.startsWith('consensus-builder-storage')) continue;
    const db = await open(info.name);
    if (!db.objectStoreNames.contains('kv')) { db.close(); continue; }
    const rows = await allRows(db);
    const changes = PublicationLabelCleanup.workspaceChanges(rows, mappings, { DesignRecord, AgreementRecord });
    datasets.push({ name:info.name, db, rows, changes });
  }
  const designs = datasets.reduce((n,d) => n+d.changes.filter(r=>r.key.startsWith('proposal:')).length,0);
  const agreements = datasets.reduce((n,d) => n+d.changes.filter(r=>r.key.startsWith('agreement:')).length,0);
  document.querySelector('#summary').textContent = designs + ' saved designs and ' + agreements + ' plan references across ' + datasets.length + ' geographic workspaces.';
  status.textContent = designs || agreements ? 'Ready. Download the backup, then apply the cleaned labels.' : 'No saved labels need changing.';
  download.disabled = false;
  download.onclick = () => {
    const backup = { savedAt:new Date().toISOString(), origin:location.origin, databases:datasets.map(({name,rows})=>({name,rows})) };
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(backup)],{type:'application/json'}));
    link.download = 'plan-design-labels-backup-' + new Date().toISOString().replace(/[:.]/g,'-') + '.json';
    document.body.append(link); link.click(); link.remove(); apply.disabled = false;
  };
  apply.onclick = async () => {
    apply.disabled = true; download.disabled = true;
    try {
      let written = 0;
      for (const data of datasets) {
        if (!data.changes.length) continue;
        await new Promise((resolve,reject) => {
          const tx = data.db.transaction('kv','readwrite'), store = tx.objectStore('kv'); let reason;
          tx.oncomplete = resolve; tx.onabort = () => reject(reason || tx.error || new Error('Storage transaction aborted.'));
          tx.onerror = () => {};
          for (const change of data.changes) {
            const request = store.get(change.key);
            request.onsuccess = () => {
              const original = data.rows.find(row=>row.key===change.key);
              if (request.result?.value !== original.value) { reason = new Error('A saved record changed during review.'); tx.abort(); return; }
              store.put({...request.result,value:change.value});
            };
          }
        });
        const readBack = await allRows(data.db);
        if (data.changes.some(change=>readBack.find(row=>row.key===change.key)?.value !== change.value)) throw new Error('Saved labels did not match the cleanup.');
        written += data.changes.length;
      }
      status.textContent = 'Complete. ' + written + ' saved records verified. Geometry, applied state and local IDs are preserved.';
      document.body.dataset.complete = 'true'; release();
    } catch(error) { fail(error); }
  };
  await lease;
}).catch(fail);
`;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Clean plan and design labels</title>
<style>body{font:17px/1.6 system-ui,sans-serif;background:#f5f7fa;color:#172033;margin:0}main{max-width:760px;margin:8vh auto;padding:32px;background:white;border:1px solid #d6deea;border-radius:18px}h1{font-size:30px;line-height:1.2}button{font:inherit;padding:12px 18px;border:1px solid #a6b5c9;border-radius:9px;margin:12px 8px 12px 0;background:#fff}#apply{background:#2459d3;color:white}button:disabled{opacity:.45}#status{padding:18px;background:#eaf0fb;border-radius:10px}</style>
<main><h1>Clean plan and design labels</h1><p>Remove “concept only” and “concept” from saved names, descriptions and author labels.</p><p id="summary">Checking saved workspaces…</p><button id="download" disabled>Download backup</button><button id="apply" disabled>Apply cleanup</button><p id="status" role="status">Preparing…</p></main>
${bundled}<script>${workflow.replace(/<\/script/gi, '<\\/script')}</script></html>`;
await fs.writeFile(output, html);
console.log(JSON.stringify({ output: path.basename(output), mappings: Object.keys(mappings).length, bytes: Buffer.byteLength(html) }));
