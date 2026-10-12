// Sites tab of the floor-plan review: each located site with its location evidence, storey envelope
// and plan fits (site-model.v1, built by `floor-plan-archive.mjs site-models`). Read-only.
(function (global) {
'use strict';
let ctx = null, sites = [], current = null, map = null, layers = null, dispose3d = null, generation = 0, loading = null;
const el = id => document.getElementById(id), geometry = () => global.__siteModelGeometry;
const tr = key => ctx.tr(key);
function textNode(tag, value, className) { const node = document.createElement(tag); node.textContent = value ?? ''; if (className) node.className = className; return node; }
function row(cells) { const tr_ = document.createElement('tr'); for (const cell of cells) tr_.append(cell instanceof Node ? cell : textNode('td', cell)); return tr_; }
function td(node) { const cell = document.createElement('td'); cell.append(node); return cell; }
const fmt = (value, digits = 1) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—');
const statusLabel = status => tr(`fit_${status}`) || status;

function stop3d() { generation++; dispose3d?.(); dispose3d = null; }

function renderSummary(model) {
    const loc = model.location || {}, env = model.envelope || {}, fp = model.footprint || {};
    const items = [
        ['siteLocation', `${tr(`loc_${loc.status}`) || loc.status} · ${fmt(loc.score, 2)} · ${(loc.reasons || []).map(r => r.code).join(', ')}`],
        ['sitePostings', String(model.siblings?.length ?? 0)],
        ['siteFootprint', fp.source ? `${tr(`src_${fp.source}`) || fp.source} · ${fp.areaM2 ?? '—'} m²${fp.caseKind ? ` · ${fp.caseKind}` : ''}` : '—'],
        ['siteStoreys', `${(env.storeys || []).length} · ${fmt(env.heightM)} m${env.storeySource ? ` · ${env.storeySource}` : ''}`],
        ['siteHeights', env.heightBasis || '—'],
    ];
    el('site-summary').replaceChildren(...items.flatMap(([key, value]) => [textNode('dt', tr(key)), textNode('dd', value)]));
    const conflicts = env.conflicts || [];
    el('site-conflicts').hidden = !conflicts.length;
    el('site-conflicts').textContent = conflicts.map(c => `${c.source}: ${c.basis}`).join(' · ');
}

function renderMap(model) {
    const ring = geometry().largestRing(model.envelope?.footprint);
    if (!ring) { el('site-map').replaceChildren(textNode('p', tr('noGeometry'), 'empty')); return; }
    const L = global.L;
    if (!map) {
        map = L.map(el('site-map'), { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
    }
    layers?.remove();
    layers = L.layerGroup().addTo(map);
    const footprint = L.polygon(ring.map(([lng, lat]) => [lat, lng]), { color: '#44505a', weight: 2, fillOpacity: 0.12 }).addTo(layers);
    for (const placement of model.placements || []) {
        if (!placement.best?.outline) continue;
        L.polygon(placement.best.outline.map(([lng, lat]) => [lat, lng]), { color: geometry().statusColour(placement.status), weight: 2, fillOpacity: 0.35 })
            .bindTooltip(`${placement.unitId || '—'} · ${statusLabel(placement.status)}`).addTo(layers);
    }
    map.invalidateSize();
    map.fitBounds(footprint.getBounds(), { padding: [24, 24], animate: false });
}

function buildGroup(THREE, model) {
    const g = geometry(), group = new THREE.Group();
    group.userData.cbFloorPlan = true;
    const shapeOf = ring => { const shape = new THREE.Shape(); ring.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y))); return shape; };
    for (const prism of g.storeyPrisms(model)) {
        const solid = new THREE.ExtrudeGeometry(shapeOf(prism.ring), { depth: prism.z1 - prism.z0, bevelEnabled: false });
        solid.translate(0, 0, prism.z0);
        group.add(new THREE.Mesh(solid, new THREE.MeshLambertMaterial({ color: prism.estimated ? '#c9ced2' : '#b9cbd6', transparent: true, opacity: 0.28, depthWrite: false })));
        group.add(new THREE.LineSegments(new THREE.EdgesGeometry(solid), new THREE.LineBasicMaterial({ color: '#5b6872' })));
    }
    for (const slab of g.placedSlabs(model)) {
        const solid = new THREE.ExtrudeGeometry(shapeOf(slab.ring), { depth: 0.3, bevelEnabled: false });
        solid.translate(0, 0, slab.z + 0.05);
        group.add(new THREE.Mesh(solid, new THREE.MeshLambertMaterial({ color: slab.colour })));
    }
    return group.children.length ? group : null;
}

function render3d(model, token) {
    el('site-3d').replaceChildren(textNode('p', tr('loading'), 'empty'));
    ctx.renderer.preview(el('site-3d'), THREE => buildGroup(THREE, model), () => token === generation)
        .then(dispose => { if (token === generation) dispose3d = dispose; else dispose?.(); })
        .catch(error => { if (token === generation) el('site-3d').replaceChildren(textNode('p', `${tr('renderFailed')}: ${error.message}`, 'empty')); });
}

function renderPlacements(model) {
    const rows = (model.placements || []).map(p => {
        const best = p.best || {};
        const clues = [p.priors?.rotationBasis ? `${tr('clueRotation')}: ${p.priors.rotationBasis}` : null,
            p.priors?.keyPlan ? tr('clueKeyPlan') : null, p.kind === 'reviewed' ? tr('clueReviewed') : null,
            p.priors?.scaleBasis === 'unknown' ? tr('clueScaleInferred') : p.priors?.scaleBasis && p.priors.scaleBasis !== 'reviewed' ? `${tr('clueScale')}: ${p.priors.scaleBasis}` : null].filter(Boolean).join(' · ');
        const status = textNode('span', statusLabel(p.status), 'fit-status');
        status.style.borderColor = geometry().statusColour(p.status);
        return row([p.unitId || '—', p.floor ?? '—', td(status), `${fmt(best.scale, 2)} · ${fmt(best.rotationDeg, 0)}°`,
            `${fmt(best.containment ?? best.iou, 2)} / ${fmt(best.coincidence, 2)}`, `${p.alternatives ?? 0} · ${fmt(p.margin, 3)}`, clues || '—']);
    });
    el('site-placements').replaceChildren(...(rows.length ? rows : [row([tr('noSitePlans'), '', '', '', '', '', ''])]));
}

async function choose(key) {
    const token = ++generation;
    dispose3d?.(); dispose3d = null;
    ctx.setStatus('loading');
    try {
        const model = await ctx.get(`/floor-plan-archive/site?key=${encodeURIComponent(key)}`);
        if (token !== generation) return;
        current = model;
        el('site-name').textContent = model.label || model.siteKey;
        el('site-listing').replaceChildren(ctx.sourceLink(model.listingUrl, tr('source')));
        renderSummary(model); renderMap(model); renderPlacements(model); render3d(model, token);
        ctx.setURL({ site: key });
        ctx.setStatus('ready');
    } catch (error) { if (token === generation) ctx.fail(error); }
}

async function load(preferred) {
    const { sites: rows } = await ctx.get('/floor-plan-archive/sites');
    sites = rows;
    el('site').replaceChildren(...sites.map(site => { const option = textNode('option', `${site.label} · ${site.postings} · ${site.placed}/${site.plans}`); option.value = site.siteKey; return option; }));
    if (!sites.length) { el('site-name').textContent = tr('noSites'); return; }
    el('site').value = sites.some(site => site.siteKey === preferred) ? preferred : sites[0].siteKey;
    await choose(el('site').value);
}

// Called by the archive page whenever the Sites tab becomes visible.
function show(context, preferred) {
    ctx = context;
    if (!loading) {
        el('site').addEventListener('change', () => choose(el('site').value));
        loading = load(preferred).catch(error => ctx.fail(error));
    } else {
        map?.invalidateSize();
        if (current && !dispose3d) render3d(current, ++generation);
    }
    return loading;
}
function hide() { stop3d(); }

global.__floorPlanSites = { show, hide };
})(window);
