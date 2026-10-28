// A small route editor over the existing model scene: orbit or fly to a view, add it, and see
// every view, hold, look and view change on one timeline. Local drafts and immutable sharing.
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
    // The segment the playhead is inside, for looks between views; null at a view or during a hold.
    function segmentAt(record, time) {
        const times = win.CameraFlight.timeline(record);
        for (let i = 0; i + 1 < record.route.length; i++) {
            if (time > times.departures[i] && time < times.arrivals[i + 1]) {
                return { after: record.route[i].id, fraction: (time - times.departures[i]) / times.travel[i + 1] };
            }
        }
        return null;
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
        const track = element('div', 'flight-timeline-track'), timelineStrip = element('div', 'flight-timeline');
        timelineStrip.setAttribute('role', 'group'); timelineStrip.setAttribute('aria-label', t('timeline')); timelineStrip.append(track);
        const playhead = element('span', 'flight-playhead'); playhead.setAttribute('aria-hidden', 'true');
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
            const input = element(type === 'select' ? 'select' : 'input', 'flight-input'); if (type !== 'select') input.type = type;
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
        function changed(next = edit.record) {
            if (closed) return;
            if (!next.route.some(p => p.id === selected)) selected = next.route[next.route.length - 1].id;
            session.setRecord(next); render(); saveDraft(); link.hidden = true;
        }
        function point() { return edit.record.route.find(p => p.id === selected) || edit.record.route[0]; }
        const index = id => edit.record.route.findIndex(p => p.id === id);
        function selectPoint(id, { seek = true } = {}) {
            selected = id; render();
            if (seek) run(() => session.seek(win.CameraFlight.arrivals(edit.record)[index(id)]));
        }
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
        const locked = () => readOnly || walking || busy;
        const seconds = value => value.toFixed(1) + ' s';
        function marker(kind, id, time, duration, label, text, fn) {
            const node = element('button', 'flight-marker flight-marker--' + kind, text); node.type = 'button';
            node.dataset.flightMarker = kind; node.dataset.flightMarkerId = id; node.title = label; node.setAttribute('aria-label', label);
            node.style.setProperty('--at', (duration ? time / duration * 100 : 0) + '%');
            node.addEventListener('click', event => { event.stopPropagation(); run(fn); }); track.append(node); return node;
        }
        // One strip of time: numbered views, hold bars, looks between views, view changes and the playhead.
        function renderTimeline() {
            const record = edit.record, times = win.CameraFlight.timeline(record), duration = times.duration;
            track.replaceChildren();
            record.route.forEach((item, i) => {
                if (item.holdSeconds > 0 && duration) {
                    const hold = element('span', 'flight-hold' + (item.turn ? ' flight-hold--turn' : '')); hold.setAttribute('aria-hidden', 'true');
                    hold.style.setProperty('--from', times.arrivals[i] / duration * 100 + '%');
                    hold.style.setProperty('--to', times.departures[i] / duration * 100 + '%'); track.append(hold);
                }
            });
            for (const look of times.looks.filter(entry => entry.kind === 'look')) {
                marker('look', look.id, look.time, duration, t('lookAt', { time: look.time.toFixed(1) }), '', () => session.seek(look.time));
            }
            for (const cue of times.cues) {
                marker('cue', cue.id, cue.time, duration, t('viewChangeAt', { number: index(cue.point) + 1 }), '', () => selectPoint(cue.point));
            }
            record.route.forEach((item, i) => {
                const node = marker('view', item.id, times.arrivals[i], duration, t('viewAt', { number: i + 1, time: times.arrivals[i].toFixed(1) }), String(i + 1), () => selectPoint(item.id));
                node.dataset.selected = String(item.id === selected); node.setAttribute('aria-pressed', String(item.id === selected));
            });
            track.append(playhead);
        }
        function renderRoute() {
            const record = edit.record, times = win.CameraFlight.timeline(record); list.replaceChildren();
            record.route.forEach((item, i) => {
                const row = element('li', 'flight-route-point'); row.dataset.flightPoint = item.id; row.dataset.selected = String(item.id === selected);
                const select = element('button', 'flight-route-select'); select.type = 'button'; select.setAttribute('aria-pressed', String(item.id === selected));
                const thumb = thumbnails.get(item.id);
                if (thumb) { const img = element('img', 'flight-thumbnail'); img.src = thumb; img.alt = ''; img.width = 72; img.height = 45; select.append(img); }
                const caption = element('span', 'flight-route-caption'); caption.append(element('strong', '', t('viewNumber', { number: i + 1 })));
                const detail = [seconds(times.arrivals[i])];
                if (item.holdSeconds) detail.push(t('holdSummary', { seconds: item.holdSeconds }));
                if (item.turn) detail.push(t('turnSummary', { turns: item.turn.turns, axis: t(item.turn.axis) }));
                if (record.cues.some(cue => cue.at === item.id)) detail.push(t('cues'));
                caption.append(element('span', 'flight-route-detail', detail.join(' · ')));
                select.append(caption); select.addEventListener('click', () => selectPoint(item.id)); row.append(select);
                const tools = element('div', 'flight-point-actions');
                button(tools, 'up', 'moveUp', () => changed(edit.movePoint(item.id, -1))).disabled = locked() || i === 0;
                button(tools, 'down', 'moveDown', () => changed(edit.movePoint(item.id, 1))).disabled = locked() || i === record.route.length - 1;
                button(tools, 'remove-point', 'remove', () => changed(edit.removePoint(item.id))).disabled = locked() || record.route.length < 2;
                row.append(tools); list.append(row);
            });
            const current = point(), i = index(current.id);
            fields.get('height').value = String(Math.round(current.position[2] * 100) / 100);
            const travel = fields.get('travel'); travel.value = current.travelSeconds === null ? '' : String(current.travelSeconds);
            travel.placeholder = i ? t('autoTravel', { seconds: times.travel[i].toFixed(1) }) : ''; travel.disabled = locked() || i === 0;
            fields.get('hold').value = String(current.holdSeconds);
            fields.get('turn-axis').value = current.turn ? current.turn.axis : 'none';
            fields.get('turns').value = String(current.turn ? current.turn.turns : 1); fields.get('turns').disabled = locked() || !current.turn;
            for (const name of ['height', 'hold', 'turn-axis']) fields.get(name).disabled = locked();
            fields.get('speed').value = String(record.speedMps);
            buttons.get('remove-cue').hidden = !record.cues.some(cue => cue.at === current.id);
        }
        function renderLooks() {
            const times = win.CameraFlight.timeline(edit.record);
            looks.replaceChildren(...times.looks.filter(entry => entry.kind === 'look').map(key => {
                const row = element('li', 'flight-key'); row.dataset.flightLook = key.id;
                button(row, 'seek-look', 'lookAt', () => session.seek(key.time)).textContent = t('lookAt', { time: key.time.toFixed(1) });
                button(row, 'remove-look', 'remove', () => changed(edit.removeLook(key.id))).disabled = locked(); return row;
            }));
        }
        function updateState(state = {}) {
            if (closed) return;
            walking = !!state.walking;
            if (state.playing) previewState = 'playing'; else if (previewState === 'playing') previewState = 'paused';
            panel.dataset.flightState = previewState; panel.dataset.flightMode = session?.mode || 'orbit';
            const duration = win.CameraFlight.duration(edit.record), value = state.time ?? session?.time ?? 0;
            timeline.max = String(duration); timeline.value = String(value); timeline.disabled = walking || duration === 0;
            timeLabel.textContent = value.toFixed(1) + ' / ' + duration.toFixed(1) + ' s';
            playhead.style.setProperty('--at', (duration ? value / duration * 100 : 0) + '%');
            const invalid = !!win.CameraFlight.validate(edit.record);
            for (const node of authoring.querySelectorAll('button, input, select')) node.disabled = locked() || node.disabled;
            for (const action of ['add-view', 'update-view', 'cue', 'undo', 'redo', 'share']) buttons.get(action).disabled = locked();
            buttons.get('undo').disabled ||= !edit.canUndo; buttons.get('redo').disabled ||= !edit.canRedo;
            buttons.get('add-look').disabled = locked() || !segmentAt(edit.record, value);
            buttons.get('play').disabled = busy || walking || invalid;
            buttons.get('pause').disabled = !state.playing; buttons.get('stop').disabled = walking;
            buttons.get('back-to-flight').hidden = !walking;
            buttons.get('fly').disabled = walking || busy; buttons.get('fly').setAttribute('aria-pressed', String(session?.mode === 'fly'));
            buttons.get('frame-route').disabled = walking || busy; buttons.get('level').disabled = walking || busy;
            buttons.get('copy').hidden = !readOnly;
            fields.get('title').disabled = locked();
            const restore = buttons.get('restore-draft'); if (restore) restore.disabled = busy || walking;
        }
        function render() {
            for (const node of authoring.querySelectorAll('button, input, select')) node.disabled = false;
            fields.get('title').value = edit.record.title; renderRoute(); renderLooks(); renderTimeline();
            updateState({ time: session.time, playing: session.playing, walking });
        }
        button(header, 'close', 'close', () => close());
        field(body, 'title', 'name', 'text', record.title, { maxlength: 160 }).addEventListener('change', () => run(() => changed(edit.rename(fields.get('title').value))));
        button(actions, 'add-view', 'addView', async () => {
            session.pause(); changed(edit.addView(session.capture())); selected = edit.record.route.at(-1).id;
            if (pendingEntry) { changed(edit.setCue(selected, win.getThreeInteriorView())); pendingEntry = false; }
            captureThumbnail(selected); render(); if (!draftFailed) message(t('draftSaved'));
        }, true);
        button(actions, 'undo', 'undo', () => changed(edit.undo())); button(actions, 'redo', 'redo', () => changed(edit.redo()));
        button(transport, 'play', 'play', async () => { previewState = 'playing'; await session.play(); updateState({ playing: session.playing }); }, true);
        button(transport, 'pause', 'pause', () => { previewState = 'paused'; session.pause(); updateState(); });
        button(transport, 'stop', 'stop', async () => { previewState = 'stopped'; session.pause(); await session.seek(0); updateState(); });
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
        button(transport, 'back-to-flight', 'backToFlight', () => { apartmentTools?.exit(); walking = false; render(); message(t('ready')); });
        body.append(actions, transport, timelineStrip);
        const scrub = element('div', 'flight-scrub'), timeLabel = element('output', 'flight-time');
        const timeline = element('input', 'flight-range'); timeline.id = 'camera-flight-time'; timeline.type = 'range'; timeline.min = '0'; timeline.step = '.01'; timeline.setAttribute('aria-label', t('lookTime'));
        timeline.addEventListener('input', () => run(() => session.seek(Number(timeline.value)))); scrub.append(timeline, timeLabel);
        body.append(scrub, status, link);
        const restore = button(body, 'restore-draft', 'restoreDraft', () => open({ record: getDraft() })); restore.hidden = !getDraft() || readOnly;
        body.append(element('p', 'flight-hint', t('previewHint')), authoring);
        const modes = element('div', 'flight-actions'); authoring.append(modes);
        const fly = button(modes, 'fly', 'freeCamera', () => session.setMode(fly.getAttribute('aria-pressed') === 'true' ? 'orbit' : 'fly'));
        button(modes, 'frame-route', 'showRoute', () => session.frameRoute());
        button(modes, 'level', 'level', () => session.level());
        authoring.append(element('h3', '', t('route')), list);
        const pointFields = element('div', 'flight-fields'); authoring.append(pointFields);
        field(pointFields, 'height', 'height', 'number', 0, { step: .1 }).addEventListener('change', () => run(() => {
            const position = point().position.slice(); position[2] = Number(fields.get('height').value); changed(edit.updatePoint(selected, { position }));
        }));
        field(pointFields, 'travel', 'travel', 'number', '', { min: .5, max: 600, step: .5 }).addEventListener('change', () => run(() => {
            const value = fields.get('travel').value.trim(); changed(edit.updatePoint(selected, { travelSeconds: value === '' ? null : Number(value) }));
        }));
        field(pointFields, 'hold', 'hold', 'number', 0, { min: 0, max: 600, step: .5 }).addEventListener('change', () => run(() => changed(edit.updatePoint(selected, { holdSeconds: Number(fields.get('hold').value) }))));
        const axis = field(pointFields, 'turn-axis', 'turn', 'select');
        for (const name of ['none', 'yaw', 'pitch', 'roll']) { const option = element('option', '', t(name === 'none' ? 'turnNone' : name)); option.value = name; axis.append(option); }
        const turns = field(pointFields, 'turns', 'turns', 'number', 1, { min: -16, max: 16, step: 1 });
        const setTurn = () => run(() => {
            const count = Math.trunc(Number(turns.value)) || 1;
            changed(edit.updatePoint(selected, { turn: axis.value === 'none' ? null : { axis: axis.value, turns: count } }));
        });
        axis.addEventListener('change', setTurn); turns.addEventListener('change', setTurn);
        const pointActions = element('div', 'flight-actions'); authoring.append(pointActions);
        button(pointActions, 'update-view', 'updateView', () => {
            const pose = session.capture(); changed(edit.updatePoint(selected, { position: pose.position, quaternion: pose.quaternion }));
            captureThumbnail(selected); render();
        });
        button(pointActions, 'cue', 'saveCue', () => changed(edit.setCue(selected, win.getThreeInteriorView())));
        button(pointActions, 'remove-cue', 'removeCue', () => { const cue = edit.record.cues.find(c => c.at === selected); if (cue) changed(edit.removeCue(cue.id)); });
        const speedField = field(authoring, 'speed', 'speed', 'number', record.speedMps, { min: .1, max: 200, step: 1 });
        speedField.addEventListener('change', () => run(() => changed(edit.setSpeed(Number(speedField.value)))));
        const aim = disclosure('looks'); aim.append(element('p', 'flight-hint', t('looksHint')));
        button(aim, 'add-look', 'addLook', () => {
            const segment = segmentAt(edit.record, session.time); if (!segment) throw new Error(t('lookNeedsSegment'));
            changed(edit.setLook(segment.after, segment.fraction, session.capture().quaternion)); if (!draftFailed) message(t('draftSaved'));
        });
        aim.append(looks);
        const camera = disclosure('fineCamera'); camera.append(element('p', 'flight-hint', t('moveHint')));
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
        field(camera, 'fly-speed', 'flySpeed', 'number', 15, { min: .1, max: 200, step: 1 }).addEventListener('change', () => run(() => session.setSpeed(Number(fields.get('fly-speed').value))));
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
        button(interiors, 'enter', 'enter', async () => {
            const choice = chosenUnit(); await apartmentController().enter(choice); pendingEntry = true;
            message(choice.unit.apartmentId === null ? t('floorEntry') : t(choice.unit.suggested ? 'generatedEntry' : 'sourceEntry'));
        });
        button(interiors, 'explore', 'explore', async () => {
            await apartmentController().explore(chosenUnit()); pendingEntry = true;
            walking = true; render(); message(t('walkingHint'));
        });
        panel.append(body); document.body.append(panel); document.body.classList.add('camera-flight-editing');
        function close() {
            if (closed) return closePromise; closed = true;
            apartmentTools?.exit(); closePromise = Promise.resolve(session?.dispose()); panel.remove(); document.body.classList.remove('camera-flight-editing'); if (active?.panel === panel) active = null;
            win.document.getElementById('camera-flight-open')?.focus({ preventScroll: true });
            return closePromise;
        }
        try {
            session = win.CameraFlightSession.create(win, record, {
                onUpdate: updateState, onError: failed, onClose: close, onSelect: id => selectPoint(id, { seek: false }),
                onMove: (id, position) => { if (!locked()) run(() => changed(edit.updatePoint(id, { position }))); },
                onUndo: redo => { if (!locked()) changed(redo ? edit.redo() : edit.undo()); }, onEnd: () => { previewState = 'paused'; updateState(); }
            }, { orbit: !readOnly });
            active = { panel, session, getRecord: () => edit.record, seek: value => session.seek(value), close };
            render(); refreshUnits(); message(readOnly ? t('readonly') : '');
            if (readOnly) await session.seek(0);
            return active;
        } catch (error) { await close(); throw error; }
    }
    win.CameraFlightEditor = { open, get active() { return active; } };
})(window);
