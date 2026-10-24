// A small route-and-look editor over the existing model scene, with local drafts and immutable sharing.
(function (win) {
    'use strict';
    let active = null;
    const t = (key, params = {}) => win.i18n.t('cameraFlight.' + key, params);
    const clone = value => JSON.parse(JSON.stringify(value));
    function element(tag, className, text) {
        const node = document.createElement(tag); if (className) node.className = className;
        if (text !== undefined) node.textContent = text; return node;
    }
    function appliedDesigns() {
        const proposals = typeof proposalStorage !== 'undefined' ? proposalStorage.getAllProposals().filter(p => win.isApplied?.(p)) : [];
        const ids = proposals.map(p => win.DesignSync.publishedCid(p));
        return { cids: [...new Set(ids.filter(Boolean))].sort(), unpublished: ids.some(id => !id) };
    }
    function currentInteriors(internals) {
        return (internals.scene.getObjectByName('FloorPlans')?.children || [])
            .filter(group => group.visible !== false && group.userData.interiorFeature)
            .map((group, index) => ({ id: 'interior-' + index, feature: clone(group.userData.interiorFeature) }));
    }
    function initialRecord() {
        const internals = win.getThreeModeInternals(), view = win.MapShare.capture(win);
        view.mode = 'model'; delete view.backend;
        const center = internals.originLatLng(), anchor = win.__metricFrame.canonicalAnchor([center.lng, center.lat]);
        const frame = { lat: anchor[1], lng: anchor[0], datum: 'model-ground' };
        const adapter = win.CameraFlightCamera.createAdapter({ THREE: win.THREE, internals, frame, metricFrame: win.__metricFrame });
        const record = win.CameraFlight.create({ title: t('newFlight'), designCids: appliedDesigns().cids, view, frame, pose: adapter.capture() });
        record.interiors = currentInteriors(internals); return record;
    }
    async function open(options = {}) {
        await active?.close();
        const record = options.record ? clone(options.record) : initialRecord();
        const invalid = win.CameraFlight.validate(record, { draft: true }); if (invalid) throw new Error(invalid);
        const edit = win.CameraFlightEdit.create(record);
        let readOnly = !!options.readOnly, selected = record.route[0].id, session, closed = false, busy = false, walking = false;
        let apartmentTools = null, closePromise = Promise.resolve();
        let units = [], pendingEntry = false, previewState = 'stopped', draftFailed = false;
        const thumbnails = new Map(), buttons = new Map(), fields = new Map();
        const panel = element('section', 'flight-panel'); panel.id = 'camera-flight-panel'; panel.setAttribute('role', 'region');
        panel.setAttribute('aria-labelledby', 'camera-flight-heading');
        const header = element('header', 'flight-header'), heading = element('h2', '', t('title')); heading.id = 'camera-flight-heading';
        header.append(heading); panel.append(header);
        const status = element('p', 'flight-notice'); status.dataset.flightStatus = ''; status.setAttribute('aria-live', 'polite');
        const body = element('div', 'flight-body'), authoring = element('div', 'flight-authoring');
        const actions = element('div', 'flight-actions'), transport = element('div', 'flight-actions');
        const list = element('ol', 'flight-route-list'); list.setAttribute('aria-label', t('route'));
        const looks = element('ul', 'flight-key-list'); looks.setAttribute('aria-label', t('looks'));
        const cues = element('ul', 'flight-key-list'); cues.setAttribute('aria-label', t('cues'));
        const link = element('a', 'flight-link'); link.dataset.flightLink = ''; link.hidden = true; link.target = '_blank'; link.rel = 'noopener';
        const draftKey = 'cb_camera_flight_draft:' + (record.view.city || 'world');
        const getDraft = () => {
            try { const value = JSON.parse(win.PersistentStorage.getItem(draftKey) || 'null'); return value && !win.CameraFlight.validate(value, { draft: true }) ? value : null; }
            catch { return null; }
        };
        function message(text, error = false) { status.textContent = text; status.classList.toggle('flight-notice--error', error); }
        function failed(error) { message(error.message || t('shareFailed'), true); console.error('[camera-flight]', error); }
        const run = fn => Promise.resolve().then(fn).catch(failed);
        function button(parent, action, key, fn, primary = false) {
            const node = element('button', 'btn' + (primary ? ' btn-primary' : ''), t(key)); node.type = 'button'; node.dataset.flightAction = action;
            node.addEventListener('click', event => { event.stopPropagation(); run(fn); }); parent.append(node);
            if (!buttons.has(action)) buttons.set(action, node); return node;
        }
        function field(parent, name, key, type, value, attributes = {}) {
            const label = element('label', 'flight-field'), text = element('span', '', t(key));
            const input = element(type === 'select' ? 'select' : 'input', 'flight-input');
            if (type !== 'select') input.type = type;
            input.dataset.flightField = name;
            for (const [key, value] of Object.entries(attributes)) input.setAttribute(key, String(value));
            if (value !== undefined) input.value = value;
            label.append(text, input); parent.append(label); fields.set(name, input); return input;
        }
        function disclosure(key) { const node = element('details', 'flight-disclosure'); node.append(element('summary', '', t(key))); authoring.append(node); return node; }
        function saveDraft() {
            if (readOnly) return;
            try {
                const data = JSON.stringify(edit.record); win.PersistentStorage.setItem(draftKey, data);
                if (win.PersistentStorage.getItem(draftKey) !== data) throw new Error(t('draftFailed'));
                draftFailed = false;
            } catch { if (!draftFailed) message(t('draftFailed'), true); draftFailed = true; }
        }
        function setSelected(id) { selected = id; renderRoute(); }
        function changed(next = edit.record) {
            if (closed) return;
            if (!next.route.some(p => p.id === selected)) selected = next.route[next.route.length - 1].id;
            session.setRecord(next); render(); saveDraft(); link.hidden = true;
        }
        function selectPoint(id) { selected = id; renderRoute(); }
        function point() { return edit.record.route.find(p => p.id === selected) || edit.record.route[0]; }
        function captureThumbnail(id) {
            try {
                const { renderer, scene, camera } = session.internals;
                const path = scene.getObjectByName('CameraFlightPath'), visible = path?.visible;
                if (path) path.visible = false;
                try {
                    renderer.render(scene, camera);
                    const thumb = document.createElement('canvas'); thumb.width = 144; thumb.height = 90;
                    thumb.getContext('2d').drawImage(renderer.domElement, 0, 0, 144, 90); thumbnails.set(id, thumb.toDataURL('image/jpeg', .6));
                } finally { if (path) path.visible = visible; win.invalidateThreeView(); }
            } catch (error) { console.warn('[camera-flight] Thumbnail unavailable', error); }
        }
        function renderRoute() {
            const record = edit.record; list.replaceChildren();
            record.route.forEach((item, index) => {
                const row = element('li', 'flight-route-point'); row.dataset.flightPoint = item.id; row.dataset.selected = String(item.id === selected);
                const select = element('button', 'flight-route-select'); select.type = 'button'; select.setAttribute('aria-pressed', String(item.id === selected));
                const thumb = thumbnails.get(item.id);
                if (thumb) { const img = element('img', 'flight-thumbnail'); img.src = thumb; img.alt = ''; img.width = 72; img.height = 45; select.append(img); }
                select.append(element('span', '', t('viewNumber', { number: index + 1 })));
                select.addEventListener('click', () => selectPoint(item.id)); row.append(select);
                const tools = element('div', 'flight-point-actions');
                const up = button(tools, 'up', 'moveUp', () => { changed(edit.movePoint(item.id, -1)); }); up.disabled = readOnly || walking || busy || index === 0;
                const down = button(tools, 'down', 'moveDown', () => { changed(edit.movePoint(item.id, 1)); }); down.disabled = readOnly || walking || busy || index === record.route.length - 1;
                const remove = button(tools, 'remove-point', 'remove', () => { changed(edit.removePoint(item.id)); }); remove.disabled = readOnly || walking || busy || record.route.length < 2;
                row.append(tools); list.append(row);
            });
            const current = point();
            fields.get('height').value = String(Math.round(current.position[2] * 100) / 100);
            fields.get('travel').value = current.travelSeconds; fields.get('travel').disabled = readOnly || walking || current.id === record.route[0].id;
            fields.get('hold').value = current.holdSeconds;
            for (const name of ['height', 'hold']) fields.get(name).disabled = readOnly || walking;
        }
        function renderKeys() {
            const record = edit.record;
            looks.replaceChildren(...record.looks.map(key => {
                const row = element('li', 'flight-key'); row.dataset.flightLook = key.id;
                button(row, 'seek-look', 'lookNumber', () => session.seek(key.time)).textContent = t('lookNumber', { time: key.time.toFixed(1) });
                const remove = button(row, 'remove-look', 'remove', () => changed(edit.removeLook(key.id)));
                remove.disabled = readOnly || walking || busy || record.looks.length < 2; return row;
            }));
            cues.replaceChildren(...record.cues.map(cue => {
                const row = element('li', 'flight-key'); row.dataset.flightCue = cue.id;
                button(row, 'seek-cue', 'cueNumber', () => session.seek(cue.time)).textContent = t('cueNumber', { time: cue.time.toFixed(1) });
                const remove = button(row, 'remove-cue', 'remove', () => changed(edit.transact(r => { r.cues = r.cues.filter(c => c.id !== cue.id); })));
                remove.disabled = readOnly || walking; return row;
            }));
        }
        function updateState(state = {}) {
            if (closed) return;
            walking = !!state.walking;
            if (state.playing) previewState = 'playing'; else if (previewState === 'playing') previewState = 'paused';
            panel.dataset.flightState = previewState;
            const duration = win.CameraFlight.duration(edit.record), value = state.time ?? session?.time ?? 0;
            timeline.max = String(duration); timeline.value = String(value); timeline.disabled = walking || duration === 0;
            timeField.max = String(duration); timeField.value = value.toFixed(2); timeField.disabled = walking || duration === 0;
            timeLabel.textContent = value.toFixed(1) + ' / ' + duration.toFixed(1) + ' s';
            const invalid = !!win.CameraFlight.validate(edit.record);
            for (const action of ['add-view', 'add-look', 'update-view', 'spin', 'cue', 'undo', 'redo', 'share']) {
                const button = buttons.get(action); if (button) button.disabled = readOnly || walking || busy;
            }
            buttons.get('undo').disabled ||= !edit.canUndo; buttons.get('redo').disabled ||= !edit.canRedo;
            buttons.get('play').disabled = busy || walking || invalid;
            buttons.get('pause').disabled = !state.playing; buttons.get('stop').disabled = walking;
            buttons.get('back-to-flight').hidden = !walking;
            buttons.get('overview').disabled = walking;
            buttons.get('overview').setAttribute('aria-pressed', String(state.inspection ?? session?.inspection ?? false));
            buttons.get('copy').hidden = !readOnly;
            if (fields.has('title')) fields.get('title').disabled = readOnly || walking || busy;
            for (const node of authoring.querySelectorAll('button, input, select')) {
                if (busy || walking || readOnly) node.disabled = true;
            }
            const restore = buttons.get('restore-draft'); if (restore) restore.disabled = busy || walking;
        }
        function render() { for (const node of authoring.querySelectorAll('button, input, select')) node.disabled = false; fields.get('title').value = edit.record.title; renderRoute(); renderKeys(); updateState({ time: session.time, playing: session.playing, inspection: session.inspection, walking }); }
        button(header, 'close', 'close', () => close());
        field(body, 'title', 'name', 'text', record.title, { maxlength: 160 }).addEventListener('change', () => run(() => changed(edit.rename(fields.get('title').value))));
        button(actions, 'add-view', 'addView', async () => {
            session.pause(); changed(edit.addView(session.capture())); selected = edit.record.route.at(-1).id;
            if (pendingEntry) { changed(edit.setCue(win.CameraFlight.arrivals(edit.record).at(-1), win.getThreeInteriorView())); pendingEntry = false; }
            captureThumbnail(selected); renderRoute(); if (!draftFailed) message(t('draftSaved'));
        }, true);
        button(actions, 'add-look', 'addLook', () => { changed(edit.setLook(session.time, session.capture().quaternion)); if (!draftFailed) message(t('draftSaved')); });
        button(actions, 'undo', 'undo', () => changed(edit.undo())); button(actions, 'redo', 'redo', () => changed(edit.redo()));
        button(transport, 'play', 'play', async () => { previewState = 'playing'; await session.play(); updateState({ playing: session.playing }); }, true);
        button(transport, 'pause', 'pause', () => { previewState = 'paused'; session.pause(); updateState(); });
        button(transport, 'stop', 'stop', async () => { previewState = 'stopped'; session.pause(); await session.seek(0); updateState(); });
        button(transport, 'overview', 'overview', () => session.inspect(!session.inspection));
        button(transport, 'share', 'share', async () => {
            session.pause(); busy = true; render(); link.hidden = true;
            try {
                const designs = appliedDesigns(); if (designs.unpublished) throw new Error(t('publishDesignsFirst'));
                const next = edit.transact(r => { r.designCids = designs.cids; r.interiors = session.snapshotFeatures({ live: !r.interiors.length }); });
                changed(next); const saved = await win.CameraFlightSharing.save(next);
                link.href = saved.link; link.textContent = saved.link; link.hidden = false; message(t('shareSaved'));
            } finally { busy = false; render(); }
        });
        button(transport, 'copy', 'editorCopy', () => { readOnly = false; render(); message(t('ready')); });
        body.append(actions, transport);
        const scrub = element('div', 'flight-scrub'), timeLabel = element('output', 'flight-time');
        const timeline = element('input', 'flight-range'); timeline.id = 'camera-flight-time'; timeline.type = 'range'; timeline.min = '0'; timeline.step = '.01'; timeline.setAttribute('aria-label', t('lookTime'));
        const timeField = field(scrub, 'time', 'lookTime', 'number', 0, { min: 0, step: .1 });
        timeField.addEventListener('change', () => run(() => session.seek(Number(timeField.value))));
        timeline.addEventListener('input', () => run(() => session.seek(Number(timeline.value)))); scrub.append(timeLabel, timeline);
        body.append(scrub, status, link);
        const restore = button(body, 'restore-draft', 'restoreDraft', () => open({ record: getDraft() })); restore.hidden = !getDraft() || readOnly;
        const hint = element('p', 'flight-hint', t('previewHint')); body.append(hint, authoring);
        authoring.append(element('h3', '', t('route')), list);
        const pointFields = element('div', 'flight-fields'); authoring.append(pointFields);
        field(pointFields, 'height', 'height', 'number', 0, { step: .1 }).addEventListener('change', () => run(() => {
            const position = point().position.slice(); position[2] = Number(fields.get('height').value); changed(edit.updatePoint(selected, { position }));
        }));
        field(pointFields, 'travel', 'travel', 'number', 5, { min: .1, max: 600, step: .5 }).addEventListener('change', () => run(() => changed(edit.updatePoint(selected, { travelSeconds: Number(fields.get('travel').value) }))));
        field(pointFields, 'hold', 'hold', 'number', 0, { min: 0, max: 600, step: .5 }).addEventListener('change', () => run(() => changed(edit.updatePoint(selected, { holdSeconds: Number(fields.get('hold').value) }))));
        button(pointFields, 'update-view', 'updateView', () => {
            const pose = session.capture(); changed(edit.updatePoint(selected, { position: pose.position }));
            const index = edit.record.route.findIndex(p => p.id === selected); changed(edit.setLook(win.CameraFlight.arrivals(edit.record)[index], pose.quaternion));
            captureThumbnail(selected); renderRoute();
        });
        const aim = disclosure('looks'); aim.append(looks);
        const spinFields = element('div', 'flight-fields'); aim.append(spinFields);
        const axis = field(spinFields, 'spin-axis', 'spinAxis', 'select');
        for (const name of ['yaw', 'pitch', 'roll']) { const option = element('option', '', t(name)); option.value = name; axis.append(option); }
        field(spinFields, 'turns', 'turns', 'number', 1, { min: -16, max: 16, step: 1 });
        button(spinFields, 'spin', 'spin', () => {
            const length = Math.min(4, win.CameraFlight.duration(edit.record) - session.time);
            changed(edit.spin(session.time, length, axis.value, Number(fields.get('turns').value)));
        });
        const cue = disclosure('cues'); button(cue, 'cue', 'saveCue', () => changed(edit.setCue(session.time, win.getThreeInteriorView()))); cue.append(cues);
        const camera = disclosure('freeCamera'); camera.append(element('p', 'flight-hint', t('moveHint')));
        const moves = element('div', 'flight-move-pad'); camera.append(moves);
        const stepField = field(camera, 'step', 'step', 'number', 1, { min: .1, max: 100, step: .1 });
        for (const [name, vector] of [['forward', [0, 0, -1]], ['backward', [0, 0, 1]], ['left', [-1, 0, 0]], ['right', [1, 0, 0]], ['up', [0, 1, 0]], ['down', [0, -1, 0]]]) {
            button(moves, 'move-' + name, name, () => session.nudge(vector, Number(stepField.value)));
        }
        const rotations = element('div', 'flight-fields'); camera.append(rotations);
        for (const name of ['yaw', 'pitch', 'roll']) field(rotations, name, name, 'number', 0, { step: 15 });
        button(rotations, 'aim', 'aim', () => {
            const pose = session.capture(), q = new win.THREE.Quaternion().fromArray(pose.quaternion);
            q.premultiply(new win.THREE.Quaternion().setFromAxisAngle(new win.THREE.Vector3(0, 0, 1), Number(fields.get('yaw').value) * Math.PI / 180));
            q.multiply(new win.THREE.Quaternion().setFromAxisAngle(new win.THREE.Vector3(1, 0, 0), Number(fields.get('pitch').value) * Math.PI / 180));
            q.multiply(new win.THREE.Quaternion().setFromAxisAngle(new win.THREE.Vector3(0, 0, -1), Number(fields.get('roll').value) * Math.PI / 180));
            session.apply({ ...pose, quaternion: q.normalize().toArray() });
        });
        button(camera, 'level', 'level', () => session.level());
        field(camera, 'speed', 'speed', 'number', 15, { min: .1, max: 200, step: 1 }).addEventListener('change', () => run(() => session.setSpeed(Number(fields.get('speed').value))));
        const interiors = disclosure('apartment'); interiors.open = true;
        const apartment = field(interiors, 'apartment', 'apartment', 'select');
        button(interiors, 'find-interiors', 'findInteriors', async () => {
            await session.setView({ ...win.getThreeInteriorView(), xray: '1', suggested: '1' });
            changed(edit.transact(r => { r.interiors = session.snapshotFeatures({ live: true }); })); refreshUnits();
            message(units.length ? t('ready') : t('interiorsEmpty'));
        });
        function refreshUnits() {
            const previous = apartment.value; units = [];
            const sources = session.snapshotFeatures();
            for (const [building, entry] of sources.entries()) {
                for (const unit of win.CameraFlightInteriors.listUnits(entry.feature, { geometry: win.__buildingFloorPlans, turf: win.turf })) units.push({ unit, feature: entry.feature, building: building + 1 });
            }
            apartment.replaceChildren(); const placeholder = element('option', '', t('chooseApartment')); placeholder.value = ''; apartment.append(placeholder);
            units.forEach(({ unit, building }, i) => {
                const option = element('option', '', unit.apartmentId ? t('buildingUnit', { building, floor: unit.level, unit: unit.name || unit.apartmentId }) : t('floorUnit', { building, floor: unit.level }));
                option.value = String(i); apartment.append(option);
            });
            if (previous && Number(previous) < units.length) apartment.value = previous;
        }
        const chosenUnit = () => { const choice = apartment.value; if (choice === '' || !units[Number(choice)]) throw new Error(t('noApartment')); return units[Number(choice)]; };
        function apartmentController() {
            apartmentTools ||= win.CameraFlightApartment.browser(win, session, { host: panel, labels: win.cameraFlightWalkingLabels() });
            return apartmentTools;
        }
        async function enterUnit() {
            const choice = chosenUnit(); await apartmentController().enter(choice); pendingEntry = true;
            message(choice.unit.apartmentId === null ? t('floorEntry') : t(choice.unit.suggested ? 'generatedEntry' : 'sourceEntry'));
        }
        button(interiors, 'enter', 'enter', enterUnit);
        button(interiors, 'explore', 'explore', async () => {
            await apartmentController().explore(chosenUnit()); pendingEntry = true;
            walking = true; render(); message(t('walkingHint'));
        });
        button(transport, 'back-to-flight', 'backToFlight', () => { apartmentTools?.exit(); walking = false; render(); message(t('ready')); });
        panel.append(body); document.body.append(panel); document.body.classList.add('camera-flight-editing');
        function close() {
            if (closed) return closePromise; closed = true;
            apartmentTools?.exit(); closePromise = Promise.resolve(session?.dispose()); panel.remove(); document.body.classList.remove('camera-flight-editing'); if (active?.panel === panel) active = null;
            win.document.getElementById('camera-flight-open')?.focus({ preventScroll: true });
            return closePromise;
        }
        try {
            session = win.CameraFlightSession.create(win, record, {
                onUpdate: updateState, onError: failed, onClose: close, onSelect: setSelected,
                onMove: (id, position) => { if (!readOnly && !busy && !walking) run(() => changed(edit.updatePoint(id, { position }))); },
                onUndo: redo => { if (!readOnly && !busy && !walking) changed(redo ? edit.redo() : edit.undo()); }, onEnd: () => { previewState = 'paused'; updateState(); }
            });
            active = { panel, session, getRecord: () => edit.record, seek: value => session.seek(value), close };
            render(); refreshUnits(); message(readOnly ? t('readonly') : t('previewHint'));
            if (readOnly) await session.seek(0);
            return active;
        } catch (error) { await close(); throw error; }
    }
    win.CameraFlightEditor = { open, get active() { return active; } };
})(window);
