// Pointer-based normalized annotations over a scrollable source image.
(function (root, factory) {
    const api = factory(root.NovogradnjePlanAnnotations);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NovogradnjeAnnotationEditor = api;
})(typeof self !== 'undefined' ? self : this, function (A) {
    'use strict';
    const LABELS = { select: 'Select', wall: 'Missing wall', opening: 'Door / window', remove: 'Wrong wall', note: 'Note pin' };
    const COLORS = { wall: '#16834a', opening: '#1677d2', remove: '#d34747', note: '#a45ac2' };
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const clone = value => JSON.parse(JSON.stringify(value));
    function mount(host, image, metadata, options = {}) {
        if (!A) throw new Error('Annotation helpers are unavailable.');
        const base = options.apiBase || '/api/annotations', expected = { unitId: metadata.unitId,
            sourceSha256: metadata.sourceSha256, page: metadata.page ?? 1, draftId: metadata.draftId };
        if (typeof metadata.unitId !== 'string' || metadata.unitId.length > 128
            || (metadata.draftId !== undefined && (typeof metadata.draftId !== 'string' || metadata.draftId.length > 128))) throw new TypeError('Invalid draft identity.');
        const ui = el('section', 'annotation-editor'); ui.setAttribute('aria-label', `Annotations for ${metadata.unitId}`);
        const heading = el('div', 'annotation-heading'), title = el('h3', '', 'Source drawing annotations'), status = el('p', 'annotation-status', 'Loading saved annotations…');
        heading.append(title, status);
        const toolbar = el('div', 'annotation-toolbar');
        const toolButtons = new Map(); let tool = 'select';
        for (const [key, label] of Object.entries(LABELS)) {
            const b = el('button', 'annotation-tool', label); b.type = 'button'; b.dataset.tool = key; b.setAttribute('aria-pressed', String(key === tool));
            b.addEventListener('click', () => { tool = key; for (const [name, button] of toolButtons) button.setAttribute('aria-pressed', String(name === tool)); });
            toolButtons.set(key, b); toolbar.append(b);
        }
        const zoomLabel = el('div', 'annotation-zoom'), zoomOut = el('button', '', '−'), zoomIn = el('button', '', '+'), fit = el('button', '', 'Fit'), zoomValue = el('span', '', '100%');
        zoomOut.type = zoomIn.type = fit.type = 'button'; zoomLabel.append('Zoom ', zoomOut, zoomValue, zoomIn, fit);
        zoomOut.setAttribute('aria-label', 'Zoom out'); zoomIn.setAttribute('aria-label', 'Zoom in'); fit.setAttribute('aria-label', 'Fit drawing');
        const undo = el('button', '', 'Undo'), remove = el('button', '', 'Delete selected'); undo.type = remove.type = 'button';
        const save = el('button', 'annotation-save', 'Save now'); save.type = 'button';
        const download = el('button', '', 'Download JSON'); download.type = 'button';
        const reload = el('button', '', 'Reload server version'); reload.type = 'button'; reload.hidden = true;
        toolbar.append(zoomLabel, undo, remove, save, download, reload);
        const noteRow = el('div', 'annotation-note-row'), noteLabel = el('label', '', 'Selected shape note'), noteInput = el('input');
        noteInput.type = 'text'; noteInput.maxLength = A.MAX_SHAPE_NOTE; noteInput.placeholder = 'Optional, up to 500 characters'; noteLabel.append(noteInput);
        const globalLabel = el('label', 'annotation-global-note', 'General note'), globalInput = el('textarea'); globalInput.maxLength = A.MAX_NOTE; globalInput.rows = 2; globalInput.placeholder = 'Optional context, up to 2,000 characters'; globalLabel.append(globalInput); noteRow.append(noteLabel, globalLabel);
        const viewport = el('div', 'annotation-scroll'); viewport.setAttribute('aria-label', 'Zoomable source drawing; drag to annotate');
        const stage = el('div', 'annotation-stage'), source = el('img', 'annotation-source'); source.alt = image.alt || `Original drawing for ${metadata.unitId}`; source.draggable = false;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('annotation-overlay'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Drawing annotations');
        stage.append(source, svg); viewport.append(stage);
        const instructions = el('p', 'annotation-help', 'Choose a tool, then drag on the drawing. Tap to place a note pin. Select a mark to edit its note; drag empty space in Select mode to pan. Changes save automatically.');
        ui.append(heading, toolbar, instructions, viewport, noteRow, globalLabel); host.replaceChildren(ui);
        let documentValue = null, selectedId = null, start = null, live = null, pan = null, timer = null, busy = false, conflict = false, destroyed = false, dirty = false;
        const undoStack = [];
        const setStatus = value => { status.textContent = value; };
        const setDirty = before => { if (documentValue) { if (before) { undoStack.push(before); if (undoStack.length > 40) undoStack.shift(); } dirty = true; setStatus(`Unsaved changes · revision ${documentValue.revision}`); clearTimeout(timer); timer = setTimeout(() => persist(), 350); } };
        const rect = () => stage.getBoundingClientRect();
        let showGeometry = false;
        function draw() {
            if (!documentValue) return;
            svg.replaceChildren();
            const geometryGroup = document.createElementNS(svg.namespaceURI, 'g'); geometryGroup.classList.add('annotation-geometry'); geometryGroup.toggleAttribute('hidden', !showGeometry); geometryGroup.setAttribute('aria-hidden', 'true');
            const geometry = options.geometryOverlay || {}, toPath = rings => rings.map(ring => ring.map((p, i) => `${i ? 'L' : 'M'}${p[0] * source.naturalWidth} ${p[1] * source.naturalHeight}`).join(' ') + ' Z').join(' ');
            for (const [kind, polygons] of [['slab', geometry.slabs || []], ['wall', geometry.walls || []]]) for (const rings of polygons) {
                const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', toPath(rings)); path.setAttribute('fill', kind === 'wall' ? '#0987d844' : '#e3497d11'); path.setAttribute('stroke', kind === 'wall' ? '#0987d8' : '#e3497d'); path.setAttribute('stroke-width', '3'); path.setAttribute('fill-rule', 'evenodd'); geometryGroup.append(path);
            }
            svg.append(geometryGroup);
            const shapes = live ? [...documentValue.shapes.filter(shape => shape.id !== live.id), live] : documentValue.shapes;
            for (const shape of shapes) {
                const color = COLORS[shape.type], group = document.createElementNS(svg.namespaceURI, 'g'); group.dataset.shapeId = shape.id; group.classList.toggle('is-selected', shape.id === selectedId);
                if (shape.type === 'note') {
                    const c = document.createElementNS(svg.namespaceURI, 'circle'); c.setAttribute('cx', String(shape.points[0][0] * source.naturalWidth)); c.setAttribute('cy', String(shape.points[0][1] * source.naturalHeight)); c.setAttribute('r', '14'); c.setAttribute('fill', color); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '4'); group.append(c);
                    const t = document.createElementNS(svg.namespaceURI, 'text'); t.textContent = 'N'; t.setAttribute('x', String(shape.points[0][0] * source.naturalWidth)); t.setAttribute('y', String(shape.points[0][1] * source.naturalHeight + 5)); t.setAttribute('text-anchor', 'middle'); t.setAttribute('fill', 'white'); t.setAttribute('font-size', '15'); t.setAttribute('font-weight', '700'); group.append(t);
                } else {
                    const line = document.createElementNS(svg.namespaceURI, 'line'); line.setAttribute('x1', String(shape.points[0][0] * source.naturalWidth)); line.setAttribute('y1', String(shape.points[0][1] * source.naturalHeight)); line.setAttribute('x2', String(shape.points[1][0] * source.naturalWidth)); line.setAttribute('y2', String(shape.points[1][1] * source.naturalHeight)); line.setAttribute('stroke', color); line.setAttribute('stroke-width', shape.id === selectedId ? '12' : '8'); line.setAttribute('stroke-linecap', 'round'); group.append(line);
                }
                group.addEventListener('pointerdown', event => { if (tool !== 'select') return; event.stopPropagation(); selectedId = shape.id; noteInput.value = shape.note; draw(); });
                svg.append(group);
            }
            svg.setAttribute('viewBox', `0 0 ${source.naturalWidth || 1} ${source.naturalHeight || 1}`);
        }
        function syncSize() { if (!source.naturalWidth || !source.naturalHeight) return; const scale = Number(stage.dataset.zoom || 1); stage.style.width = `${source.naturalWidth * scale}px`; stage.style.height = `${source.naturalHeight * scale}px`; draw(); }
        function setZoom(value, anchor = null) {
            const next = Math.max(.1, Math.min(4, value)), old = Number(stage.dataset.zoom || 1); if (next === old) return;
            const before = anchor ? { x: (anchor.x + viewport.scrollLeft) / old, y: (anchor.y + viewport.scrollTop) / old } : null;
            stage.dataset.zoom = String(next); zoomValue.textContent = `${Math.round(next * 100)}%`; syncSize();
            if (before) { viewport.scrollLeft = before.x * next - anchor.x; viewport.scrollTop = before.y * next - anchor.y; }
        }
        zoomOut.addEventListener('click', () => setZoom(Number(stage.dataset.zoom || 1) / 1.25)); zoomIn.addEventListener('click', () => setZoom(Number(stage.dataset.zoom || 1) * 1.25));
        fit.addEventListener('click', () => { if (source.naturalWidth) setZoom(Math.min(1, (viewport.clientWidth || 600) / source.naturalWidth)); });
        viewport.addEventListener('wheel', event => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); const bounds = viewport.getBoundingClientRect(); setZoom(Number(stage.dataset.zoom || 1) * (event.deltaY < 0 ? 1.12 : 1 / 1.12), { x: event.clientX - bounds.left, y: event.clientY - bounds.top }); }, { passive: false });
        const imageReady = () => { if (!source.naturalWidth || !source.naturalHeight) return; stage.dataset.zoom = String(Math.min(1, (viewport.clientWidth || 600) / source.naturalWidth)); zoomValue.textContent = `${Math.round(Number(stage.dataset.zoom) * 100)}%`; syncSize(); };
        source.addEventListener('load', imageReady); source.addEventListener('error', () => setStatus('Could not load the source drawing.'));
        source.src = typeof image === 'string' ? image : image?.src || '';
        if (source.complete && source.naturalWidth) imageReady();
        function select(id) { selectedId = id; const shape = documentValue.shapes.find(item => item.id === id); noteInput.value = shape?.note || ''; draw(); }
        svg.addEventListener('pointerdown', event => {
            if (!documentValue) return;
            const existingShape = event.target.closest('[data-shape-id]');
            if (tool === 'select') {
                if (existingShape) return;
                selectedId = null; noteInput.value = ''; draw(); event.preventDefault();
                pan = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; svg.setPointerCapture(event.pointerId); viewport.classList.add('is-panning'); return;
            }
            if (existingShape) return;
            const point = A.pointFromClient(event.clientX, event.clientY, rect()); if (!point) return;
            event.preventDefault(); svg.setPointerCapture(event.pointerId);
            if (tool === 'note') { if (documentValue.shapes.length >= A.MAX_SHAPES) { setStatus(`Maximum ${A.MAX_SHAPES} annotations reached.`); return; } const before = clone(documentValue), shape = { id: crypto.randomUUID(), type: 'note', points: [point], note: '' }; documentValue.shapes.push(shape); select(shape.id); setDirty(before); return; }
            start = point; live = { id: 'preview', type: tool, points: [point, point], note: '' }; draw();
        });
        svg.addEventListener('pointermove', event => { if (pan) { viewport.scrollLeft = pan.left - (event.clientX - pan.x); viewport.scrollTop = pan.top - (event.clientY - pan.y); return; } if (!start || !live) return; const point = A.pointFromClient(event.clientX, event.clientY, rect()); if (!point) return; live.points[1] = point; draw(); });
        svg.addEventListener('pointerup', event => {
            if (pan) { pan = null; viewport.classList.remove('is-panning'); return; }
            if (!start || !live) return; const point = A.pointFromClient(event.clientX, event.clientY, rect());
            if (point) live.points[1] = point;
            const dist = Math.hypot(live.points[0][0] - live.points[1][0], live.points[0][1] - live.points[1][1]);
            const before = point && dist > .001 && documentValue.shapes.length < A.MAX_SHAPES ? clone(documentValue) : null;
            if (before) { live.id = crypto.randomUUID(); documentValue.shapes.push(live); selectedId = live.id; }
            else if (point && dist > .001 && documentValue.shapes.length >= A.MAX_SHAPES) setStatus(`Maximum ${A.MAX_SHAPES} annotations reached.`);
            start = null; live = null; draw(); if (selectedId) noteInput.value = documentValue.shapes.find(item => item.id === selectedId)?.note || ''; if (before) setDirty(before);
        });
        svg.addEventListener('pointercancel', () => { start = null; live = null; pan = null; viewport.classList.remove('is-panning'); draw(); });
        noteInput.addEventListener('input', () => { const shape = documentValue?.shapes.find(item => item.id === selectedId); if (shape) { const before = clone(documentValue); shape.note = noteInput.value.slice(0, A.MAX_SHAPE_NOTE); setDirty(before); draw(); } });
        globalInput.addEventListener('input', () => { if (documentValue) { const before = clone(documentValue); documentValue.note = globalInput.value.slice(0, A.MAX_NOTE); setDirty(before); } });
        remove.addEventListener('click', () => { if (!selectedId || !documentValue) return; const before = clone(documentValue); documentValue.shapes = documentValue.shapes.filter(shape => shape.id !== selectedId); selectedId = null; noteInput.value = ''; draw(); setDirty(before); });
        undo.addEventListener('click', () => { if (!undoStack.length || !documentValue) return; documentValue = A.restoreContent(documentValue, undoStack.pop()); dirty = true; globalInput.value = documentValue.note; const selected = documentValue.shapes.find(shape => shape.id === selectedId); if (!selected) selectedId = null; noteInput.value = selected?.note || ''; draw(); setStatus(`Unsaved changes · revision ${documentValue.revision}`); clearTimeout(timer); timer = setTimeout(() => persist(), 350); });
        function doDownload() { if (!documentValue) return; const blob = new Blob([A.exportDocument(documentValue)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = `novogradnje-plan-annotations-${metadata.unitId}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
        download.addEventListener('click', doDownload);
        async function load({ replace = false } = {}) {
            try { const response = await fetch(`${base}/${encodeURIComponent(metadata.unitId)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(`Load failed (${response.status})`); const saved = await response.json(); A.validateDocument(saved, expected);
                if (replace) { clearTimeout(timer); undoStack.length = 0; selectedId = null; noteInput.value = ''; dirty = false; conflict = false; }
                documentValue = saved; globalInput.value = saved.note; draw(); setStatus(`Saved · revision ${saved.revision}`); return true; }
            catch (error) { setStatus(`Could not load annotations: ${error.message}`); if (!documentValue) save.disabled = true; return false; }
        }
        async function persist() {
            clearTimeout(timer); if (!documentValue || busy || conflict || destroyed) return false;
            try { A.validateDocument(documentValue, expected); }
            catch (error) { setStatus(`Cannot save: ${error.message}`); return false; }
            busy = true; save.disabled = true; const sending = clone(documentValue); setStatus('Saving…');
            try {
                const response = await fetch(`${base}/${encodeURIComponent(metadata.unitId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sending), signal: AbortSignal.timeout(15000) });
                if (response.status === 409) { conflict = true; reload.hidden = false; setStatus('Save conflict. Download this draft or reload the server version; no changes were overwritten.'); return false; }
                if (!response.ok) throw new Error(`Save failed (${response.status})`);
                const saved = await response.json(); A.validateDocument(saved, expected);
                let confirmed;
                try {
                    const readback = await fetch(`${base}/${encodeURIComponent(metadata.unitId)}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
                    if (!readback.ok) throw new Error(`Readback failed (${readback.status})`);
                    confirmed = await readback.json(); A.validateDocument(confirmed, expected);
                    const sameContent = ['schema', 'unitId', 'sourceSha256', 'page', 'draftId', 'note', 'shapes'].every(key => JSON.stringify(confirmed[key]) === JSON.stringify(saved[key]));
                    if (confirmed.revision !== saved.revision || !sameContent) throw new Error('Saved document did not match its server readback.');
                } catch (readbackError) { conflict = true; reload.hidden = false; documentValue.revision = saved.revision; dirty = true; setStatus(`Server accepted the save, but readback could not confirm it: ${readbackError.message}. Download or reload before saving again.`); return false; }
                if (JSON.stringify(documentValue) === JSON.stringify(sending)) { documentValue = confirmed; dirty = false; }
                else documentValue.revision = confirmed.revision;
                setStatus(`Saved · revision ${saved.revision}${dirty ? ' · newer edits pending' : ''}`);
                if (dirty) { clearTimeout(timer); timer = setTimeout(() => persist(), 350); }
                return true;
            } catch (error) { setStatus(`${error.message}. Changes remain in this page and can be downloaded.`); return false; }
            finally { busy = false; save.disabled = false; }
        }
        save.addEventListener('click', persist);
        reload.addEventListener('click', async () => { if (await load({ replace: true })) reload.hidden = true; });
        const onNavigation = event => { const link = event.target.closest('a'); if (!link || link.download || !documentValue || (!dirty && !busy)) return; event.preventDefault(); event.stopImmediatePropagation(); (async () => {
            const ok = await A.flushChanges({ isBusy: () => busy, isDirty: () => dirty,
                persist, wait: () => new Promise(resolve => setTimeout(resolve, 50)) });
            if (ok && !destroyed) location.href = link.href;
        })(); };
        document.addEventListener('click', onNavigation, true);
        const beforeUnload = event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
        addEventListener('beforeunload', beforeUnload);
        if (!metadata.draftId || !metadata.sourceSha256) { setStatus('Annotations need sourceSha256 and draftId in draft metadata.'); save.disabled = true; }
        else load();
        return { destroy() { destroyed = true; clearTimeout(timer); removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', onNavigation, true); }, save: persist, getDocument: () => documentValue && clone(documentValue), setGeometryVisible(value) { showGeometry = Boolean(value); draw(); } };
    }
    return { mount };
});
