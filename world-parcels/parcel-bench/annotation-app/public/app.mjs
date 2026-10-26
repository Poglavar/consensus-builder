import { validateBatch, makeState, saveLocal, acceptRemote, acknowledge, resolveConflict, taskList, exportLocal } from './model.mjs';
import { readState, updateState } from './storage.mjs';
import { ImageViewer } from './viewer.mjs';
import { t } from './strings.mjs';

const $ = id => document.getElementById(id);
document.querySelectorAll('[data-text]').forEach(node => { node.textContent = t(node.dataset.text); });
document.querySelectorAll('[data-placeholder]').forEach(node => { node.placeholder = t(node.dataset.placeholder); });
let state, draft, task, mode = 'review', anchorStep = 0, imageReady = false, syncRunning = false, saving = false;
let operations = Promise.resolve(), networkMessage = '', registration;
const uuid = () => crypto.randomUUID();
const imageCacheName = `autokatastar-images:${new URL('./', location.href).pathname}`;
const notice = message => { $('notice').textContent = message; };
async function api(path, options = {}) {
  const response = await fetch(`api/${path}`, { ...options, redirect: 'manual', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(15000) });
  if (response.type === 'opaqueredirect' || response.status === 401 || /text\/html/i.test(response.headers.get('content-type') || '')) throw Object.assign(new Error(t('loginNeeded')), { status: 401 });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status, body });
  return body;
}
function change(transform) {
  const run = operations.catch(() => {}).then(async () => { state = await updateState(transform); return state; });
  operations = run;
  return run;
}
function activeTask() { return taskList(state)[state.index || 0]; }
function updateStatus() {
  if (!state) return;
  const entries = Object.values(state.entries), pending = entries.filter(e => e.dirty).length;
  const status = !navigator.onLine ? t('offline') : networkMessage || (pending ? t('pending', { n: pending }) : t('synced'));
  $('save-status').textContent = saving ? t('saving') : status;
  $('sync-status').textContent = status;
  $('progress').textContent = t('reviewed', { n: entries.length, total: taskList(state).length });
}
const viewer = new ImageViewer($('viewer'), {
  onTap: point => {
    if (!draft || !imageReady) return;
    if (mode === 'anchors') {
      draft[anchorStep === 0 ? 'a' : 'b'] = point;
      if (anchorStep === 0) anchorStep = 1;
      else { mode = 'review'; anchorStep = 0; }
    } else if (mode === 'trace' && draft.trace.length < 400) draft.trace.push(point);
    else return;
    void persistDraft(); renderEditor();
  },
  onLoad: loaded => {
    imageReady = loaded === true;
    $('image-message').hidden = loaded === true;
    $('image-message').textContent = loaded === false ? t('imageError') : t('imageLoading');
    renderEditor();
  },
});
function renderEditor() {
  if (!draft) return;
  viewer.annotate(draft);
  $('gesture-hint').textContent = mode === 'anchors' ? t(anchorStep ? 'placeB' : 'placeA') : mode === 'trace' ? t('traceHint') : t('gestures');
  $('anchors').setAttribute('aria-pressed', mode === 'anchors');
  $('trace').setAttribute('aria-pressed', mode === 'trace');
  $('undo').hidden = mode !== 'trace'; $('done').hidden = mode === 'review';
  $('undo').disabled = !draft.trace.length;
  $('clear-trace').disabled = !draft.trace.length;
  document.querySelectorAll('[data-relation]').forEach(button => {
    button.disabled = saving || !imageReady || !draft.a || !draft.b || draft.trace.length === 1 || mode !== 'review';
    button.setAttribute('aria-pressed', state.entries[task.id]?.value.relation === button.dataset.relation);
  });
}
function renderTask() {
  if (!state) return;
  const tasks = taskList(state);
  task = activeTask() || tasks[0];
  const sample = state.batch.samples.find(s => s.id === task.sample_id);
  const entry = state.entries[task.id];
  draft = structuredClone(state.drafts?.[task.id] || entry?.value || { id: task.id, sample_id: task.sample_id, a: task.a, b: task.b, trace: [], note: '' });
  mode = draft.a && draft.b ? 'review' : 'anchors'; anchorStep = draft.a ? 1 : 0;
  $('review').hidden = false;
  $('position').textContent = t('position', { n: tasks.indexOf(task) + 1, total: tasks.length });
  $('task-select').replaceChildren(...tasks.map((item, index) => {
    const option = document.createElement('option'), source = state.batch.samples.find(s => s.id === item.sample_id);
    option.value = index; option.textContent = `${state.entries[item.id] ? '✓ ' : ''}${source.title} · ${index + 1}`;
    option.selected = item.id === task.id; return option;
  }));
  $('note').value = draft.note;
  $('current-answer').textContent = entry ? t('currentAnswer', { answer: t(entry.value.relation) }) : '';
  $('previous').disabled = tasks.indexOf(task) === 0;
  $('source').replaceChildren(document.createTextNode(`${sample.attribution} · ${sample.license}${sample.acquisition_start ? ` · ${sample.acquisition_start.slice(0, 10)}` : ''}`));
  if (sample.source_url && /^https:\/\//.test(sample.source_url)) {
    const link = document.createElement('a'); link.href = sample.source_url; link.textContent = ` · ${t('source')}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; $('source').append(link);
  }
  renderConflict(); viewer.show(sample); renderEditor(); updateStatus();
}
function renderConflict() {
  const conflict = state?.entries[task?.id]?.conflict;
  $('conflict').hidden = !conflict;
  if (conflict) $('remote-review').textContent = `${t('serverReview')}: ${t(conflict.value.relation)}\nA: ${conflict.value.a.join(', ')} · B: ${conflict.value.b.join(', ')}\n${conflict.value.note}`;
}
async function persistDraft() {
  const copy = structuredClone(draft), id = task.id;
  try { await change(current => ({ ...current, drafts: { ...current.drafts, [id]: copy } })); }
  catch { notice(t('saveError')); throw new Error(t('saveError')); }
}
async function navigate(index) {
  await persistDraft();
  await change(current => ({ ...current, index: Math.max(0, Math.min(index, taskList(current).length - 1)) }));
  renderTask();
}
async function answer(relation) {
  if (saving) return;
  saving = true; renderEditor(); updateStatus();
  const value = { ...structuredClone(draft), relation }, mutation = uuid();
  try {
    await change(current => {
      const next = saveLocal(current, value, mutation);
      const drafts = { ...next.drafts }; delete drafts[value.id];
      const tasks = taskList(next), start = tasks.findIndex(item => item.id === value.id);
      const following = tasks.findIndex((item, i) => i > start && !next.entries[item.id]);
      const remaining = tasks.findIndex(item => !next.entries[item.id]);
      return { ...next, drafts, index: following >= 0 ? following : remaining >= 0 ? remaining : start };
    });
    notice(Object.keys(state.entries).length === taskList(state).length ? t('finished') : t('saved'));
    renderTask(); void sync();
  } catch (error) { notice(error.message); }
  finally { saving = false; renderEditor(); updateStatus(); }
}
async function sync() {
  if (!state || syncRunning || !navigator.onLine) return updateStatus();
  syncRunning = true; $('sync').disabled = true;
  try {
    const remote = await api('reviews');
    if (remote.batch_hash !== state.batch.batch_hash) { networkMessage = t('newBatch'); notice(networkMessage); return; }
    await change(current => acceptRemote(current, remote.reviews));
    // Requests and disk updates are sequential; edits may continue while requests are in flight.
    for (const id of Object.keys(state.entries)) {
      const entry = structuredClone(state.entries[id]);
      if (!entry.dirty || entry.conflict) continue;
      try {
        const record = await api(`reviews/${id}`, { method: 'PUT', body: JSON.stringify({ batch_hash: state.batch.batch_hash,
          base_revision: entry.revision, mutation_id: entry.mutationId, value: entry.value }) });
        await change(current => acknowledge(current, entry, record));
      } catch (error) {
        if (error.status === 409 && error.body.current) await change(current => ({ ...current, entries: { ...current.entries, [id]: { ...current.entries[id], conflict: error.body.current } } }));
        else throw error;
      }
    }
    networkMessage = ''; $('unlock').hidden = true;
  } catch (error) {
    networkMessage = t(error.status === 401 ? 'loginNeeded' : 'noConnection');
    if (error.status === 401) $('unlock').hidden = false;
  } finally {
    syncRunning = false; $('sync').disabled = false; updateStatus(); renderConflict();
    // Show newly discovered reviews in navigation without replacing a pair being edited.
    if (!networkMessage && Object.values(state.entries).some(entry => entry.dirty && !entry.conflict)) setTimeout(() => void sync(), 500);
  }
}
async function offlineStatus() {
  if (!state) return;
  if (!('serviceWorker' in navigator) || !isSecureContext) { $('offline-status').textContent = t('noOffline'); return; }
  const cache = await caches.open(imageCacheName);
  let count = 0;
  for (const sample of state.batch.samples) if (await cache.match(new URL(`${sample.image}?v=${sample.image_sha256}`, location.href).href)) count++;
  $('offline-status').textContent = t(count === state.batch.samples.length && navigator.serviceWorker.controller ? 'offlineReady' : 'partial', { n: count, total: state.batch.samples.length });
}
async function download() {
  if (!state || !registration) { notice(t('noOffline')); return; }
  $('download').disabled = true;
  try {
    await navigator.serviceWorker.ready;
    if (navigator.storage?.persist) await navigator.storage.persist();
    const cache = await caches.open(imageCacheName);
    for (let i = 0; i < state.batch.samples.length; i++) {
      const sample = state.batch.samples[i], url = new URL(`${sample.image}?v=${sample.image_sha256}`, location.href).href;
      $('offline-status').textContent = t('downloadProgress', { n: i + 1, total: state.batch.samples.length });
      let response = await cache.match(url);
      if (!response) response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(t('downloadError'));
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('');
      if (digest !== sample.image_sha256) { await cache.delete(url); throw new Error(t('downloadError')); }
      await cache.put(url, response);
    }
    await offlineStatus();
  } catch { $('offline-status').textContent = t('downloadError'); }
  finally { $('download').disabled = false; }
}
function backup() {
  if (!state) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ ...exportLocal(state), drafts: state.drafts || {} }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `autokatastar-${state.batch.id}-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function connect() {
  const batch = validateBatch(await api('batch'));
  if (state && state.batch.batch_hash !== batch.batch_hash) { notice(t('newBatch')); return; }
  if (!state) await change(() => makeState(batch));
  await sync(); renderTask(); await offlineStatus();
}
document.querySelectorAll('[data-relation]').forEach(button => button.addEventListener('click', () => void answer(button.dataset.relation)));
$('anchors').onclick = () => { mode = mode === 'anchors' ? 'review' : 'anchors'; anchorStep = 0; renderEditor(); };
$('trace').onclick = () => { mode = mode === 'trace' ? 'review' : 'trace'; renderEditor(); };
$('done').onclick = () => { mode = 'review'; renderEditor(); };
$('undo').onclick = () => { draft.trace.pop(); void persistDraft(); renderEditor(); };
$('clear-trace').onclick = () => { draft.trace = []; void persistDraft(); renderEditor(); };
$('note').oninput = () => { draft.note = $('note').value; void persistDraft(); };
$('previous').onclick = () => void navigate(state.index - 1);
$('next').onclick = () => void navigate((state.index + 1) % taskList(state).length);
$('task-select').onchange = () => void navigate(Number($('task-select').value));
$('fit').onclick = () => viewer.fit(); $('zoom-in').onclick = () => viewer.zoom(1.7); $('zoom-out').onclick = () => viewer.zoom(1 / 1.7);
$('add-pair').onclick = async () => {
  await persistDraft();
  const sampleId = task.sample_id, id = `custom_${uuid()}`;
  await change(current => {
    const next = { ...current, customTasks: [...current.customTasks, { id, sample_id: sampleId, a: null, b: null }] };
    return { ...next, index: taskList(next).findIndex(item => item.id === id) };
  });
  renderTask();
};
for (const [id, keepLocal] of [['keep-local', true], ['keep-remote', false]]) $(id).onclick = async () => {
  const reviewId = task.id;
  await change(current => {
    const next = resolveConflict(current, reviewId, keepLocal, uuid()), drafts = { ...current.drafts };
    delete drafts[reviewId]; return { ...next, drafts };
  });
  renderTask(); void sync();
};
$('open-pack').onclick = () => { $('pack-dialog').showModal(); void offlineStatus(); };
$('close-pack').onclick = () => $('pack-dialog').close();
$('sync').onclick = () => void sync(); $('download').onclick = () => void download(); $('backup').onclick = backup;
window.addEventListener('online', () => void sync()); window.addEventListener('offline', updateStatus);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void sync(); });
try {
  state = await readState();
  if (state) renderTask();
  if ('serviceWorker' in navigator && isSecureContext) {
    registration = await navigator.serviceWorker.register('sw.js');
    navigator.serviceWorker.addEventListener('controllerchange', () => void offlineStatus());
  }
  try { await connect(); }
  catch (error) {
    if (!state || error.status === 401) $('unlock').hidden = false;
    notice(t(state ? (error.status === 401 ? 'loginNeeded' : navigator.onLine ? 'noConnection' : 'offline') : 'unlockHint'));
    if (state) await offlineStatus();
  }
} catch { notice(t('saveError')); }
