// Browser orchestration: prepared inputs, worker jobs, editable overlays, local drafts and GeoJSON downloads.
import { ImageViewer } from '/shared/viewer.mjs';
import { DEFAULTS, RECIPE } from './core.mjs';
import { text } from './strings.mjs';
const $ = id => document.getElementById(id), NS = 'http://www.w3.org/2000/svg';
const clone = value => structuredClone(value);
const emptyEdits = () => ({ seeds: [], dividers: [] });
const copyValue = path => path === 'pageTitle' ? text.pageTitle
  : path.startsWith('modes.') || path.startsWith('labels.') ? path.split('.').reduce((value, key) => value?.[key], text)
    : text.ui[path.startsWith('ui.') ? path.slice(3) : path];
document.title = text.pageTitle;
for (const element of document.querySelectorAll('[data-text]')) element.textContent = copyValue(element.dataset.text);
for (const element of document.querySelectorAll('[data-label]')) element.setAttribute('aria-label', copyValue(`labels.${element.dataset.label}`));
let bundle, sample, worker, result, settings = { ...DEFAULTS }, edits = emptyEdits(), goodEdits = emptyEdits(), history = [];
let sequence = 0, activeId = 0, loadingId = 0, mode = 'inspect', draftPoint, overlayUrl, edgeUrl, busy = true;
const svgNode = (name, attributes) => { const element = document.createElementNS(NS, name); for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value); return element; };
class PlotViewer extends ImageViewer {
  draw() { super.draw(); if (this.box && result) drawOverlays(this); }
}
const viewer = new PlotViewer($('viewer'), { onTap: tap, onLoad: () => {} });
const storageKey = () => `${RECIPE}:${sample.id}:${sample.image_sha256}:${sample.provenance.osm_cache_sha256}`;
const color = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const rgb = value => { const match = value.replace('#', ''); return [0, 2, 4].map(i => parseInt(match.slice(i, i + 2), 16)); };
function notice(message, tone = 'ready') { $('status').textContent = message; $('status').dataset.tone = tone; }
function controls() {
  for (const id of ['sensitivity', 'rectangularity', 'inspect', 'add-seed', 'divide', 'export', 'reset']) $(id).disabled = busy || !result;
  $('undo').disabled = busy || !history.length;
  for (const [key, id] of [['inspect', 'inspect'], ['seed', 'add-seed'], ['divide', 'divide']]) {
    $(id).setAttribute('aria-pressed', String(mode === key)); $(id).classList.toggle('action-selected', mode === key);
  }
  $('viewer').dataset.mode = mode;
}
function setMode(next) { mode = next; draftPoint = null; $('tool-hint').textContent = text.modes[next]; controls(); viewer.draw(); }
function persist() {
  try { localStorage.setItem(storageKey(), JSON.stringify({ settings, edits })); $('save-state').textContent = text.ui.saved; }
  catch { $('save-state').textContent = text.ui.storageFailed; }
}
function restore() {
  settings = { ...DEFAULTS }; edits = emptyEdits(); history = [];
  try { const saved = JSON.parse(localStorage.getItem(storageKey()));
    const point = p => Array.isArray(p) && p.length === 2 && p.every((v, i) => Number.isFinite(v) && v >= 0 && v < (i ? sample.height : sample.width));
    if (saved && ['sensitivity', 'rectangularity'].every(k => Number.isFinite(saved.settings?.[k]) && saved.settings[k] >= 0 && saved.settings[k] <= 100)
      && Array.isArray(saved.edits?.seeds) && saved.edits.seeds.every(point)
      && Array.isArray(saved.edits?.dividers) && saved.edits.dividers.every(d => Array.isArray(d) && d.length === 2 && d.every(point))) { settings = saved.settings; edits = saved.edits; }
  } catch { $('save-state').textContent = text.ui.savedUnreadable; }
  goodEdits = clone(edits);
  for (const key of ['sensitivity', 'rectangularity']) { $(key).value = settings[key]; $(`${key}-value`).value = settings[key]; }
}
function regenerate() {
  busy = true; activeId = ++sequence; controls(); notice(text.ui.working, 'busy');
  worker.postMessage({ id: activeId, type: 'compute', settings: clone(settings), edits: clone(edits) });
}
function workerMessage({ data }) {
  if (data.id !== activeId) return;
  busy = false;
  if (data.type === 'error') {
    if (JSON.stringify(edits) !== JSON.stringify(goodEdits)) history.pop();
    edits = clone(goodEdits); draftPoint = null;
    notice(data.message, 'error'); controls(); viewer.draw(); return;
  }
  if (data.type === 'export') {
    const blob = new Blob([JSON.stringify(data.collection)], { type: 'application/geo+json' }), url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${sample.id}-${text.ui.exportSuffix}.geojson`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); notice(text.ui.exportPrepared); controls(); return;
  }
  result = data.result; goodEdits = clone(edits); persist(); buildRasters(); viewer.draw(); controls();
  $('plot-count').textContent = result.stats.plots; $('building-count').textContent = result.stats.buildingSeeds;
  $('generated-count').textContent = result.stats.generatedSeeds; $('coverage').textContent = `${Math.round(result.stats.groundCoverage * 100)}%`;
  $('run-time').textContent = text.ui.elapsed((data.elapsedMs / 1000).toFixed(2), result.width);
  $('selection').textContent = text.ui.initialSelection;
  const warnings = result.warnings.length ? ` ${result.warnings.join(' ')}` : '';
  notice(text.ui.ready + warnings);
}
function buildRasters() {
  const canvas = document.createElement('canvas'); canvas.width = result.width; canvas.height = result.height;
  const context = canvas.getContext('2d'), image = context.createImageData(result.width, result.height);
  const palette = Array.from({ length: 10 }, (_, i) => rgb(color(`--plot-${i}`))), boundary = rgb(color('--boundary'));
  const water = rgb(color('--water')), road = rgb(color('--road'));
  for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
    const i = y * result.width + x, label = result.labels[i], hard = result.barrier[i];
    if (label) {
      const edge = (x && label !== result.labels[i - 1]) || (y && label !== result.labels[i - result.width]);
      image.data.set([...(edge ? boundary : palette[label % palette.length]), edge ? 245 : 78], i * 4);
    } else if (hard) image.data.set([...(hard === 2 ? water : road), hard === 3 ? 230 : 90], i * 4);
  }
  context.putImageData(image, 0, 0); overlayUrl = canvas.toDataURL();
  const edgeColor = rgb(color('--edge'));
  for (let i = 0; i < result.edge.length; i++) image.data.set([...edgeColor, Math.round(result.edge[i] ** 2 * 210)], i * 4);
  context.putImageData(image, 0, 0); edgeUrl = canvas.toDataURL();
}
function drawOverlays(view) {
  if ($('show-plots').checked && overlayUrl) view.overlay.append(svgNode('image', { class: 'plot-layer', href: overlayUrl, width: sample.width, height: sample.height }));
  if ($('show-edges').checked && edgeUrl) view.overlay.append(svgNode('image', { class: 'edge-layer', href: edgeUrl, width: sample.width, height: sample.height }));
  if ($('show-features').checked) {
    const group = svgNode('g', { class: 'feature-layer' });
    for (const feature of sample.features.buildings) {
      const d = feature.rings.map(ring => `M${ring.map(p => p.join(',')).join('L')}Z`).join('');
      group.append(svgNode('path', { class: 'building-outline', d }));
    }
    view.overlay.append(group);
  }
  const radius = view.box.w / view.svg.getBoundingClientRect().width * 5;
  for (const [x, y] of edits.seeds) view.overlay.append(svgNode('circle', { class: 'manual-point', cx: x, cy: y, r: radius }));
  if (draftPoint) view.overlay.append(svgNode('circle', { class: 'manual-point', cx: draftPoint[0], cy: draftPoint[1], r: radius }));
}
function tap(point) {
  if (busy || !result) return;
  if (mode === 'inspect') {
    const x = Math.min(result.width - 1, Math.floor(point[0] / sample.width * result.width));
    const y = Math.min(result.height - 1, Math.floor(point[1] / sample.height * result.height));
    const id = result.labels[y * result.width + x], region = result.regions.find(r => r.id === id);
    $('selection').textContent = region ? text.ui.plotSelection(id, Math.round(region.area_m2).toLocaleString(), text.ui.kinds[region.kind]) : text.ui.noPlot;
  } else if (mode === 'seed') {
    history.push(clone(edits)); edits.seeds.push(point); regenerate();
  } else if (!draftPoint) {
    draftPoint = point; $('tool-hint').textContent = text.secondPoint; viewer.draw();
  } else {
    history.push(clone(edits)); edits.dividers.push([draftPoint, point]); draftPoint = null;
    $('tool-hint').textContent = text.modes.divide; regenerate();
  }
}
function sources() {
  const root = $('sources'); root.replaceChildren();
  for (const value of [sample.attribution, sample.license, text.ui.imageryDate(sample.acquired_at?.slice(0, 10)), sample.osm_attribution, sample.osm_license,
    text.ui.osmSnapshot(sample.osm_snapshot_at?.slice(0, 10))]) {
    const p = document.createElement('p'); p.className = 'caption'; p.textContent = value; root.append(p);
  }
  const a = document.createElement('a'); a.href = sample.source_url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text.ui.originalSource; root.append(a);
  if (sample.warnings.length) { const p = document.createElement('p'); p.className = 'caption'; p.textContent = `${text.ui.inputNotes(sample.warnings.length)} ${[...new Set(sample.warnings)].join(' ')}`; root.append(p); }
}
async function selectLocation(id) {
  const load = ++loadingId; worker?.terminate(); result = null; overlayUrl = null; edgeUrl = null; busy = true; controls();
  sample = bundle.samples.find(s => s.id === id); restore(); setMode('inspect'); sources();
  $('region').textContent = sample.region; $('place').textContent = sample.title;
  $('extent').textContent = text.ui.extent(Math.round(sample.bbox[2] - sample.bbox[0]), Math.round(sample.bbox[3] - sample.bbox[1]));
  for (const id of ['plot-count', 'building-count', 'generated-count', 'coverage']) $(id).textContent = '—';
  notice(text.ui.loadingFeatures, 'busy');
  const image = new Image(); image.src = `/data/${sample.image}`;
  try {
    await image.decode(); if (load !== loadingId) return;
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0, 512, 512);
    const rgba = context.getImageData(0, 0, 512, 512).data;
    viewer.show({ ...sample, image: image.src });
    worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = workerMessage; worker.onerror = event => { busy = false; result = null; notice(text.ui.processingFailed(event.message), 'error'); controls(); };
    worker.postMessage({ type: 'prepare', sample, rgba, width: 512, height: 512 }, [rgba.buffer]); regenerate();
  } catch (error) { if (load === loadingId) { busy = false; notice(text.ui.couldNotLoad(error.message), 'error'); controls(); } }
}
for (const key of ['sensitivity', 'rectangularity']) {
  $(key).addEventListener('input', () => { $(`${key}-value`).value = $(key).value; $('export').disabled = true; });
  $(key).addEventListener('change', () => { settings[key] = Number($(key).value); regenerate(); });
}
$('inspect').onclick = () => setMode('inspect'); $('add-seed').onclick = () => setMode('seed'); $('divide').onclick = () => setMode('divide');
$('undo').onclick = () => { if (history.length) { edits = history.pop(); draftPoint = null; regenerate(); } };
$('reset').onclick = () => { history.push(clone(edits)); edits = emptyEdits(); draftPoint = null; regenerate(); };
$('export').onclick = () => { busy = true; activeId = ++sequence; controls(); notice(text.ui.exporting, 'busy'); worker.postMessage({ id: activeId, type: 'export' }); };
$('zoom-in').onclick = () => viewer.zoom(1.5); $('zoom-out').onclick = () => viewer.zoom(1 / 1.5); $('fit').onclick = () => viewer.fit();
for (const id of ['show-plots', 'show-features', 'show-edges']) $(id).onchange = () => viewer.draw();
$('location').onchange = () => selectLocation($('location').value);
document.addEventListener('keydown', event => { if (event.key === 'Escape') setMode('inspect'); });
window.addEventListener('pagehide', () => worker?.terminate());
window.addEventListener('pageshow', event => { if (event.persisted && sample) selectLocation(sample.id); });
try {
  const response = await fetch('/data/bundle.json'); if (!response.ok) throw new Error(text.ui.dataBundleMissing);
  bundle = await response.json();
  if (bundle.schema !== 'heuristic-demo-bundle-v1' || !bundle.samples.length) throw new Error(text.ui.unexpectedBundle);
  $('location').replaceChildren(...bundle.samples.map(sample => { const option = document.createElement('option'); option.value = sample.id; option.textContent = `${sample.region} · ${sample.title}`; return option; }));
  $('location').disabled = false;
  if (matchMedia('(max-width:760px)').matches) for (const details of document.querySelectorAll('.disclosure')) details.open = false;
  await selectLocation(bundle.samples[0].id);
} catch (error) { notice(error.message, 'error'); }
