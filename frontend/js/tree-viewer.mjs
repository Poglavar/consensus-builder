// Live tree locations from the local Zrinjevac proxy, displayed over OpenStreetMap.
import { HOME, HOME_ZOOM, parseBbox, readTrees } from './tree-viewer-data.mjs';

const params = new URLSearchParams(location.search);
const backend = new URL(params.get('backend') || '/tree-api', location.href).href.replace(/\/$/, '');
window.getBackendBase = () => backend;
const at = (params.get('at') || HOME.join(',')).split(',').map(Number);
const center = at.length === 2 && at.every(Number.isFinite) && Math.abs(at[0]) <= 85 && Math.abs(at[1]) <= 180 ? at : HOME;
const zoom = Number(params.get('zoom') || HOME_ZOOM);
const map = L.map('map', { zoomControl: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false })
  .setView(center, Number.isFinite(zoom) ? Math.max(10, Math.min(20, zoom)) : HOME_ZOOM);
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxNativeZoom: 19, maxZoom: 20,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
}).addTo(map);
map.attributionControl.addAttribution('Trees: <a href="https://gis.zrinjevac.hr/">Zrinjevac</a>');
const trees = L.layerGroup().addTo(map);
const status = document.querySelector('#status');
const toggle = document.querySelector('#show-trees');
const refresh = document.querySelector('#refresh');
const reset = document.querySelector('#reset');
let currentRequest;

function setStatus(message, state = 'ready') {
  status.textContent = message;
  status.dataset.state = state;
}

function popup(tree) {
  const box = document.createElement('section');
  box.className = 'tree-popup';
  const heading = document.createElement('h2');
  heading.textContent = `Tree #${tree.id}`;
  const position = document.createElement('p');
  position.textContent = `${tree.lat.toFixed(7)}, ${tree.lon.toFixed(7)}`;
  const link = document.createElement('a');
  link.href = 'https://gis.zrinjevac.hr/';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Open Zrinjevac map ↗';
  box.append(heading, position, link);
  return box;
}

async function fetchTrees() {
  currentRequest?.abort();
  const controller = new AbortController();
  currentRequest = controller;
  trees.clearLayers();
  if (!toggle.checked) { setStatus('Tree layer hidden.'); return; }
  if (map.getZoom() < 16) { setStatus('Zoom in to see individual trees.'); return; }
  const bounds = map.getBounds();
  const bbox = bounds.toBBoxString();
  try { parseBbox(bbox); } catch (error) { setStatus(error.message); return; }
  setStatus('Loading trees…', 'loading');
  const timeout = setTimeout(() => controller.abort(new Error('The tree service timed out. Try Refresh trees.')), 30000);
  try {
    const response = await fetch(`${backend}/trees?bbox=${encodeURIComponent(bbox)}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Tree service error (${response.status}).`);
    const records = readTrees(data);
    if (currentRequest !== controller) return;
    const visible = records.filter(tree => bounds.contains([tree.lat, tree.lon]));
    for (const tree of visible) {
      const marker = L.circleMarker([tree.lat, tree.lon], { radius: 5, className: 'tree-marker' }).addTo(trees);
      const openRecord = () => L.popup().setLatLng([tree.lat, tree.lon]).setContent(popup(tree)).openOn(map);
      marker.on('click', openRecord);
      const element = marker.getElement();
      element.setAttribute('tabindex', '0');
      element.setAttribute('role', 'button');
      element.setAttribute('aria-label', `Tree ${tree.id}`);
      element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openRecord(); }
      });
    }
    setStatus(visible.length ? `${visible.length.toLocaleString()} ${visible.length === 1 ? 'tree' : 'trees'} in this view` : 'No inventoried trees in this view.');
  } catch (error) {
    if (currentRequest !== controller || error.name === 'AbortError') return;
    setStatus(`${error.message} Use Refresh trees to retry.`, 'error');
  } finally { clearTimeout(timeout); }
}

const loadTrees = () => BusyControl.track(refresh, fetchTrees);
map.on('moveend', loadTrees);
refresh.addEventListener('click', loadTrees);
toggle.addEventListener('change', () => {
  if (toggle.checked) trees.addTo(map); else map.removeLayer(trees);
  loadTrees();
});
reset.addEventListener('click', () => BusyControl.track(reset, () => {
  map.setView(HOME, HOME_ZOOM, { animate: false });
  return loadTrees();
}));
loadTrees();
