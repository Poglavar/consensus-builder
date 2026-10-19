// Proposing from the Schelling plan: an on-map tool (OnMapEditor) where the author paints the
// blocks of the intervention. The plan is the same for everyone; where it applies is the proposal.
// It opens in the spot of the plan's panel, as that panel's next step; Cancel or Escape goes back
// to it, and the painted blocks wait there until they are proposed or the page is left.
// Every street that bounds a painted block becomes a road proposal through the corridor import
// (schelling-streets.js, corridor-import.js createRoadRecords), so the edge of an intervention is
// always a street (schelling-parcels.md, "Plan of record").
(function (win) {
    'use strict';
    if (!win?.document) return;

    const doc = win.document;
    // One superblock's worth until a large road record has been measured (schelling-parcels.md).
    const MAX_BLOCKS = 64;
    // Painting needs blocks large enough to hit; below this the tool asks for a closer view.
    const MIN_ZOOM = 15;
    const MAX_DRAWN_CELLS = 3000;
    // `selected` and the code of the plan it was painted on outlive the tool, so leaving and coming
    // back keeps the blocks; another plan (other settings or another band) starts afresh.
    const state = { session: null, plan: null, selected: new Map(), selectedOn: null, cells: null, streets: null, layers: null,
        renderer: null, stroke: null, proposing: false, limitHit: false };
    const key = cell => `${cell.i}:${cell.j}`;

    function t(name, fallback, params) {
        const text = win.i18n?.t?.(`schellingPlan.${name}`, params);
        if (text && text !== `schellingPlan.${name}`) return text;
        // A count reference ({ key, count }) without i18n loaded reads as its number.
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, item) => {
            const value = params?.[item];
            return String(value && typeof value === 'object' ? value.count : value ?? '');
        });
    }
    // A count that i18n words in the right plural form for the language (Croatian has three).
    const counted = (name, count) => ({ key: `schellingPlan.propose.${name}`, count });
    const number = (value, digits = 0) => win.CbFormat?.formatNumber(value, { maxFractionDigits: digits })
        ?? new Intl.NumberFormat(doc.documentElement.lang || 'en', { maximumFractionDigits: digits }).format(value);
    const el = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (action, className) => {
        const node = el('button', className);
        node.type = 'button';
        node.dataset.action = action;
        return node;
    };

    function buildPanel() {
        const content = el('div', 'schelling-propose__content');
        content.append(
            el('p', 'schelling-propose__hint'),
            el('p', 'schelling-propose__code'),
            el('p', 'schelling-propose__summary'),
            el('p', 'schelling-propose__status')
        );
        content.querySelector('.schelling-propose__status').setAttribute('role', 'status');
        content.querySelector('.schelling-propose__status').setAttribute('aria-live', 'polite');
        const actions = el('div', 'schelling-propose__actions');
        actions.append(button('superblock', 'btn'), button('clear', 'btn'));
        content.append(actions);
        const footer = el('div', 'schelling-propose__footer');
        footer.append(el('p', 'schelling-propose__disclaimer'), button('propose', 'btn btn-primary'));
        return { content, footer };
    }

    function localize() {
        const root = state.session.root;
        root.querySelector('.schelling-propose__hint').textContent = t('propose.hint', 'Click or drag over blocks to add or remove them. Every street around a chosen block is proposed.');
        root.querySelector('.schelling-propose__code').textContent = t('code', 'Plan {{code}}', { code: state.plan.code });
        root.querySelector('[data-action="superblock"]').textContent = t('propose.superblock', 'This superblock');
        root.querySelector('[data-action="clear"]').textContent = t('propose.clear', 'Clear');
        root.querySelector('[data-action="propose"]').textContent = t('propose.proposeRoads', 'Propose roads');
        root.querySelector('.schelling-propose__disclaimer').textContent = t('propose.disclaimer', 'Roads only for now; the blocks and plots between them come next. What the roads take from existing parcels is shown when they land.');
        renderSummary();
    }

    function setStatus(message) {
        if (state.session) state.session.root.querySelector('.schelling-propose__status').textContent = message || '';
    }

    function renderSummary() {
        const root = state.session.root;
        const cells = [...state.selected.values()];
        const summary = win.SchellingStreets.summary(state.plan, cells);
        root.querySelector('.schelling-propose__summary').textContent = cells.length
            ? t('propose.summary', '{{blocks}} · {{streets}} ({{arterial}} km arterial, {{local}} km local) · {{roads}}', {
                blocks: counted('blockCount', summary.blocks), streets: counted('streetCount', summary.streets), roads: counted('roadCount', summary.roads),
                arterial: number(summary.lengthM.arterial / 1000, 2), local: number(summary.lengthM.local / 1000, 2)
            })
            : t('propose.empty', 'No blocks chosen.');
        root.querySelector('[data-action="propose"]').disabled = state.proposing || !cells.length;
        root.querySelector('[data-action="clear"]').disabled = !cells.length;
    }

    // ---- the map -------------------------------------------------------------------------------

    const latLngOf = ([lng, lat]) => [lat, lng];

    // The land of each street to be proposed, as a strip around its centre line.
    function streetStrip(street) {
        const grid = win.SchellingGrid;
        const plan = state.plan;
        const first = street.nodes[0];
        const last = street.nodes[street.nodes.length - 1];
        const widthM = street.roadClass === 'arterial' ? plan.arterialWidthM : plan.streetWidthM;
        if (street.axis === 'EW') {
            const half = widthM / 2 / (plan.metersPerArcsecond.lat * 3600);
            const lat = grid.latOfLine(plan, street.line);
            return [[lat - half, grid.lonOfLine(plan, first.i)], [lat + half, grid.lonOfLine(plan, last.i)]];
        }
        const half = widthM / 2 / (plan.metersPerArcsecond.lon * 3600);
        const lng = grid.lonOfLine(plan, street.line);
        return [[grid.latOfLine(plan, first.j), lng - half], [grid.latOfLine(plan, last.j), lng + half]];
    }

    function draw() {
        if (!state.session) return;
        const L = win.L;
        const map = state.session.map;
        if (!state.layers) {
            state.renderer = L.svg({ pane: state.session.pane });
            state.layers = { cells: L.layerGroup().addTo(map), streets: L.layerGroup().addTo(map) };
        }
        state.layers.cells.clearLayers();
        state.layers.streets.clearLayers();
        const options = className => ({ pane: state.session.pane, renderer: state.renderer, className, bubblingMouseEvents: false });
        win.SchellingStreets.streetsOf(state.plan, [...state.selected.values()]).forEach(street => {
            state.layers.streets.addLayer(L.rectangle(streetStrip(street), { ...options(`schelling-propose__street is-${street.roadClass}`), interactive: false }));
        });
        if (map.getZoom() < MIN_ZOOM) {
            state.session.setHint(t('propose.zoomIn', 'Zoom in to paint blocks.'));
            return;
        }
        state.session.setHint(null);
        const bounds = map.getBounds().pad(0.05);
        let cells;
        try {
            cells = win.SchellingGrid.cellsInBbox(state.plan, [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], MAX_DRAWN_CELLS);
        } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            state.session.setHint(t('propose.zoomIn', 'Zoom in to paint blocks.'));
            return;
        }
        cells.forEach(cell => {
            const ring = win.SchellingGrid.blockOf(state.plan, cell.i, cell.j).geometry.coordinates[0];
            const rectangle = L.rectangle([latLngOf(ring[0]), latLngOf(ring[2])],
                options(`schelling-propose__cell${state.selected.has(key(cell)) ? ' is-selected' : ''}`));
            rectangle.on('add', () => { rectangle.getElement()?.setAttribute('data-schelling-cell', key(cell)); });
            state.layers.cells.addLayer(rectangle);
        });
    }

    // Painting: a press on a block sets the stroke's value (add if it was out, remove if it was in)
    // and every block the pointer then passes over takes the same value, mouse and touch alike.
    function cellUnder(event) {
        const target = doc.elementFromPoint(event.clientX, event.clientY);
        const value = target?.closest?.('[data-schelling-cell]')?.getAttribute('data-schelling-cell');
        if (!value) return null;
        const [i, j] = value.split(':').map(Number);
        return { i, j };
    }

    function paint(cell) {
        const id = key(cell);
        if (state.stroke.add) {
            if (state.selected.has(id)) return;
            if (state.selected.size >= MAX_BLOCKS) {
                state.limitHit = true;
                setStatus(t('propose.limit', 'At most {{max}} blocks per proposal for now.', { max: number(MAX_BLOCKS) }));
                return;
            }
            state.selected.set(id, cell);
        } else if (!state.selected.delete(id)) return;
        state.stroke.changed = true;
        const node = state.session.map.getContainer().querySelector(`[data-schelling-cell="${id}"]`);
        node?.classList.toggle('is-selected', state.stroke.add);
    }

    function onPointerDown(event) {
        if (!state.session || state.proposing || event.button > 0) return;
        const cell = cellUnder(event);
        if (!cell) return;
        event.preventDefault();
        event.stopPropagation();
        state.stroke = { add: !state.selected.has(key(cell)), changed: false };
        state.limitHit = false;
        setStatus('');
        state.session.map.dragging.disable();
        paint(cell);
    }

    function onPointerMove(event) {
        if (!state.stroke) return;
        const cell = cellUnder(event);
        if (cell) paint(cell);
    }

    function onPointerUp() {
        if (!state.stroke) return;
        const changed = state.stroke.changed;
        state.stroke = null;
        state.session?.map.dragging.enable();
        if (changed) { draw(); renderSummary(); }
    }

    // ---- selection actions -----------------------------------------------------------------------

    function selectSuperblockAtCentre() {
        const centre = state.session.map.getCenter();
        const { i, j } = win.SchellingGrid.cellAt(state.plan, centre.lat, centre.lng);
        state.selected = new Map(win.SchellingGrid.superblockOf(state.plan, i, j).cells.slice(0, MAX_BLOCKS).map(cell => [key(cell), cell]));
        state.selectedOn = state.plan.code;
    }

    // The box around the chosen cells, to frame them.
    function outlineOf(cells) {
        const grid = win.SchellingGrid;
        const is = cells.map(cell => cell.i);
        const js = cells.map(cell => cell.j);
        const west = grid.lonOfLine(state.plan, Math.min(...is));
        const east = grid.lonOfLine(state.plan, Math.max(...is) + 1);
        const south = grid.latOfLine(state.plan, Math.min(...js));
        const north = grid.latOfLine(state.plan, Math.max(...js) + 1);
        return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] } };
    }

    async function propose() {
        if (state.proposing || !state.selected.size) return;
        state.proposing = true;
        renderSummary();
        try {
            const plan = state.plan;
            const cells = [...state.selected.values()];
            const parsed = win.SchellingStreets.importForm(plan, cells, { laneTags: win.corridorProfileToOsmTags });
            parsed.roads.forEach((road, index) => {
                road.name = parsed.roads.length > 1
                    ? t('propose.roadNameNumbered', 'Schelling roads {{code}} ({{number}})', { code: plan.code, number: number(index + 1) })
                    : t('propose.roadName', 'Schelling roads {{code}}', { code: plan.code });
            });
            const records = win.__corridorImport.recordsFromImport(parsed, {
                author: win.getProposalAuthorValue?.() || 'schelling-point',
                source: 'schelling-point',
                fallbackTitle: t('propose.roadName', 'Schelling roads {{code}}', { code: plan.code }),
                description: t('propose.description', 'Streets of the Schelling plan {{code}} (meridians and parallels) around {{blocks}}.', { code: plan.code, blocks: counted('blockCount', cells.length) })
            });
            const { created, failed } = await win.__corridorImport.createRoadRecords(records);
            if (failed.length) console.warn(`[${new Date().toISOString()}] [schelling-propose] ${failed.length} of ${records.length} road proposals failed:`, failed);
            if (!created.length) {
                setStatus(t('propose.failed', 'Could not propose these roads: {{reason}}', { reason: failed.filter(Boolean).join(' ') || '?' }));
                return;
            }
            // Proposed blocks are done with: the next visit starts from the superblock again.
            state.selected = new Map();
            close();
            win.updateStatus?.(t('propose.done', 'Proposed {{count}} of {{total}} Schelling road networks. Share them as a plan to publish them together.',
                { count: number(created.length), total: number(records.length) }));
        } finally {
            state.proposing = false;
            if (state.session) renderSummary();
        }
    }

    function wire(root, map) {
        root.querySelector('[data-action="superblock"]').addEventListener('click', () => { selectSuperblockAtCentre(); setStatus(''); draw(); renderSummary(); });
        root.querySelector('[data-action="clear"]').addEventListener('click', () => { state.selected.clear(); setStatus(''); draw(); renderSummary(); });
        root.querySelector('[data-action="propose"]').addEventListener('click', event => win.BusyControl.track(event.currentTarget, propose));
        const container = map.getContainer();
        container.addEventListener('pointerdown', onPointerDown, true);
        doc.addEventListener('pointermove', onPointerMove);
        doc.addEventListener('pointerup', onPointerUp);
        doc.addEventListener('pointercancel', onPointerUp);
        map.on('moveend', draw);
        state.unwire = () => {
            container.removeEventListener('pointerdown', onPointerDown, true);
            doc.removeEventListener('pointermove', onPointerMove);
            doc.removeEventListener('pointerup', onPointerUp);
            doc.removeEventListener('pointercancel', onPointerUp);
            map.off('moveend', draw);
        };
    }

    function close() {
        const session = state.session;
        if (!session) return;
        state.session = null;
        state.stroke = null;
        state.unwire?.();
        state.unwire = null;
        session.map.dragging.enable();
        Object.values(state.layers || {}).forEach(layer => layer.remove());
        state.layers = null;
        session.close();
    }

    function open() {
        if (state.session || !win.map) return false;
        const plan = win.SchellingLayer.planHere();
        const { content, footer } = buildPanel();
        const session = win.OnMapEditor?.open({
            owner: 'schelling-propose', id: 'schelling-propose', modes: ['2d'],
            title: t('propose.title', 'Schelling roads'), content, footer, onCancel: close
        });
        // Another map tool holds the map; it says so itself.
        if (!session) return false;
        session.root.classList.add('schelling-propose');
        state.session = session;
        state.plan = plan;
        state.proposing = false;
        // Blocks painted on this plan before are taken up again; otherwise the superblock here.
        if (state.selectedOn !== plan.code || !state.selected.size) selectSuperblockAtCentre();
        wire(session.root, session.map);
        localize();
        session.fitFeature(outlineOf([...state.selected.values()]));
        draw();
        session.root.querySelector('[data-action="propose"]').focus({ preventScroll: true });
        return true;
    }

    win.SchellingPropose = Object.freeze({ open, close, isOpen: () => !!state.session });
})(typeof window !== 'undefined' ? window : null);
