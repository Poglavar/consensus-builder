// Leaflet/canvas presentation and controls for the pure traffic simulation.
(async function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const t = (key, params) => window.TrafficCopy.t(key, params);
    for (const element of document.querySelectorAll('[data-i18n-key]')) {
        const text = t(element.dataset.i18nKey);
        if (element.dataset.i18nAttr) element.setAttribute(element.dataset.i18nAttr, text);
        else element.textContent = text;
    }
    const Engine = window.TrafficSimulation, G = window.TrafficGeometry;
    const Scenario = window.TrafficScenario, Meters = window.TrafficMeters;
    const counters = new Meters.Counters();
    const audio = new window.TrafficAudio.Sound();
    const colors = ['#237e88', '#ce7943', '#e4ae4a', '#5968a0', '#668e69', '#f4f0dc', '#bd6977'];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || new URLSearchParams(location.search).has('reduceMotion');
    const map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 13, maxZoom: 20 });
    L.control.zoom({ position: 'topright', zoomInTitle: t('zoomInButton'), zoomOutTitle: t('zoomOutButton') }).addTo(map);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 20, maxNativeZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">suradnici OpenStreetMapa</a>'
    }).addTo(map);
    const places = { miramarska: [45.80013, 15.97458, 18], split: [45.7975692, 15.9705577, 20], center: [45.8078, 15.9776, 18], west: [45.79992, 15.95386, 18] };
    const initialPlace = new URLSearchParams(location.search).get('view');
    const initialView = Object.hasOwn(places, initialPlace) ? places[initialPlace] : places.miramarska;
    map.setView(initialView.slice(0, 2), initialView[2]);
    if (Object.hasOwn(places, initialPlace)) document.querySelectorAll('[data-place]').forEach(button =>
        button.classList.toggle('active', button.dataset.place === initialPlace));
    const guideCanvas = $('guides'), carCanvas = $('cars');
    const guides = guideCanvas.getContext('2d'), ctx = carCanvas.getContext('2d');
    let baseNetwork, editor, laneIndex, hover = null, meterHover = null, selectedMeter = null, tool = 'inspect', roadEdges, transitionEdges, surface;
    let network, sim, running = !reduced, rate = 2, seed = 52, selected = null, following = false;
    let selectedInfo = null;
    let signalPopup = null;
    let transform, size = { x: 0, y: 0 }, previousFrame = null, uiTime = 0, frameId = null;
    let screenCars = [], frameCount = 0, tileErrors = 0;
    tiles.on('tileerror', () => { tileErrors++; });

    const scene = new window.TrafficSceneLayer([guideCanvas, carCanvas], () => {
        size = scene.size; updateTransform(); drawGuides(); drawCars();
    });
    scene.addTo(map);
    function resize() {
        if (signalPopup?.isOpen()) {
            signalPopup.options.maxWidth = Math.max(140, Math.min(280, map.getSize().x - 72)); signalPopup.update();
        }
        scene.reset();
    }
    function updateTransform() {
        if (!network) return;
        const origin = scene.project([network.origin[1], network.origin[0]]);
        const east = network.unproject([100, 0]), north = network.unproject([0, 100]);
        transform = { x: origin.x, y: origin.y,
            sx: (scene.project([east[1], east[0]]).x - origin.x) / 100,
            sy: (scene.project([north[1], north[0]]).y - origin.y) / 100 };
    }
    const screen = point => ({ x: transform.x + point[0] * transform.sx, y: transform.y + point[1] * transform.sy });
    const visible = p => p.x > -40 && p.x < size.x + 40 && p.y > -40 && p.y < size.y + 40;
    const routeVisible = route => transform.x + route.bounds[0] * transform.sx < size.x + 40
        && transform.x + route.bounds[2] * transform.sx > -40
        && transform.y + route.bounds[3] * transform.sy < size.y + 40
        && transform.y + route.bounds[1] * transform.sy > -40;

    function line(context, route) {
        if (!route.points.length) return;
        context.beginPath();
        route.points.forEach((point, index) => { const p = screen(point); if (!index) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y); });
        context.stroke();
    }

    function buildRoadEdges() {
        roadEdges = new Map();
        const sections = new Map();
        for (const lane of baseNetwork.lanes.values()) {
            const key = `${lane.sectionId}:${lane.direction}`;
            if (!sections.has(key)) sections.set(key, []);
            sections.get(key).push(lane);
        }
        for (const lane of baseNetwork.lanes.values()) {
            const siblings = sections.get(`${lane.sectionId}:${lane.direction}`);
            roadEdges.set(lane.id, [-1, 1].map(side => {
                const adjacent = siblings.some(other => other.ordinal === lane.ordinal - side && Math.abs(other.stripIndex - lane.stripIndex) === 1);
                const points = offsetPolylinePlanar(lane.path.points, side * (lane.width || 3) / 2);
                return { route: G.path(points || lane.path.points), dashed: adjacent };
            }));
        }
        transitionEdges = [];
        for (const connection of baseNetwork.connections.values()) {
            if (connection.path.length < 1) continue;
            const from = baseNetwork.lanes.get(connection.fromLaneId), to = baseNetwork.lanes.get(connection.toLaneId);
            if (!from || !to) continue;
            for (const [index, side] of [-1, 1].entries()) {
                const width = ((from.width || 3) + (to.width || 3)) / 2;
                const points = offsetPolylinePlanar(connection.path.points, side * width / 2);
                transitionEdges.push({ route: G.path(points || connection.path.points),
                    dashed: !connection.geometryKind
                        || roadEdges.get(from.id)[index].dashed || roadEdges.get(to.id)[index].dashed });
            }
        }
    }
    function drawGuides() {
        guides.clearRect(0, 0, size.x, size.y);
        if (!network || !transform) return;
        const zoom = scene.zoom, metres = Math.abs(transform.sx);
        guides.lineCap = 'butt'; guides.lineJoin = 'round'; guides.setLineDash([]);
        if ($('lanes').checked) {
            const visibleLanes = [...baseNetwork.lanes.values()].filter(lane => routeVisible(lane.path));
            // Paint all road surfaces first; then markings, so overlapping joins are continuous.
            guides.strokeStyle = '#555f61';
            guides.fillStyle = '#555f61';
            for (const junction of surface.junctions) {
                const points = junction.points.map(screen);
                if (!points.some(visible)) continue;
                guides.beginPath(); guides.moveTo(points[0].x, points[0].y);
                for (const p of points.slice(1)) guides.lineTo(p.x, p.y);
                guides.closePath(); guides.fill();
            }
            for (const lane of surface.lanes) if (routeVisible(lane.path)) { guides.lineWidth = (lane.width || 3) * metres; line(guides, lane.path); }
            for (const c of baseNetwork.connections.values()) if (routeVisible(c.path)) {
                guides.lineWidth = (baseNetwork.lanes.get(c.fromLaneId).width || 3) * metres; line(guides, c.path);
            }
            if (zoom >= 17) for (const lane of visibleLanes) {
                for (const edge of roadEdges.get(lane.id)) {
                    guides.strokeStyle = edge.dashed ? '#e6e8dfaa' : '#e6e8dfd0';
                    guides.lineWidth = Math.max(.65, .1 * metres);
                    guides.setLineDash(edge.dashed ? [3 * metres, 5 * metres] : []); line(guides, edge.route);
                }
                guides.setLineDash([]);
                if (zoom < 18 || lane.path.length < 12) continue;
                for (let station = Math.min(18, lane.path.length / 2); station < lane.path.length; station += 55) {
                    const p = G.sample(lane.path, station), q = screen([p.x, p.y]);
                    guides.save(); guides.translate(q.x, q.y); guides.rotate(-p.angle); guides.scale(metres, metres);
                    guides.strokeStyle = '#e6e8df95'; guides.lineWidth = .13;
                    guides.beginPath(); guides.moveTo(-1.4, 0); guides.lineTo(1.4, 0); guides.moveTo(.4, -.65); guides.lineTo(1.4, 0); guides.lineTo(.4, .65); guides.stroke(); guides.restore();
                }
            }
            if (zoom >= 17) for (const edge of transitionEdges) if (routeVisible(edge.route)) {
                guides.strokeStyle = edge.dashed ? '#e6e8dfaa' : '#e6e8dfd0';
                guides.lineWidth = Math.max(.65, .1 * metres);
                guides.setLineDash(edge.dashed ? [3 * metres, 5 * metres] : []); line(guides, edge.route);
            }
            guides.setLineDash([]);
        }
        if (hover && zoom >= 17) {
            guides.strokeStyle = tool === 'close' ? '#f5ad4a88' : '#68dcda66';
            guides.lineWidth = (hover.lane.width || 3) * metres;
            const selection = Scenario.chunk(hover.lane, hover.s, Number($('chunk-size').value));
            line(guides, tool === 'close' ? G.slice(hover.lane.path, selection.start, selection.end) : hover.lane.path);
        }
        for (const closure of editor?.closures || []) {
            const lane = baseNetwork.lanes.get(closure.laneId), route = G.slice(lane.path, closure.start, closure.end);
            if (!routeVisible(route)) continue;
            const pending = closure.status === 'pending';
            guides.lineWidth = (lane.width || 3) * metres; guides.strokeStyle = pending ? '#f3b754ad' : '#453d36'; line(guides, route);
            guides.lineWidth = .3 * metres; guides.strokeStyle = pending ? '#ffd686' : '#f9b349';
            for (let s = closure.start; s <= closure.end + .01; s += 1.1) {
                const p = G.sample(lane.path, s), half = (lane.width || 3) / 2;
                line(guides, G.path([[-Math.sin(p.angle) * half + p.x - Math.cos(p.angle) * .4, Math.cos(p.angle) * half + p.y - Math.sin(p.angle) * .4],
                    [Math.sin(p.angle) * half + p.x + Math.cos(p.angle) * .4, -Math.cos(p.angle) * half + p.y + Math.sin(p.angle) * .4]]));
            }
            for (const station of [closure.start, closure.end]) {
                const p = G.sample(lane.path, station), half = (lane.width || 3) / 2;
                const edge = G.path([[p.x - Math.sin(p.angle) * half, p.y + Math.cos(p.angle) * half], [p.x + Math.sin(p.angle) * half, p.y - Math.cos(p.angle) * half]]);
                guides.lineWidth = .65 * metres; guides.strokeStyle = '#fff4d8'; line(guides, edge);
                guides.setLineDash([.5 * metres, .5 * metres]); guides.strokeStyle = '#d66c33'; line(guides, edge); guides.setLineDash([]);
            }
        }
        guides.setLineDash([]);
        for (const meter of [...counters.meters, ...(meterHover ? [meterHover] : [])]) {
            guides.strokeStyle = meter.id === selectedMeter ? '#4dd9dc' : '#98eeee'; guides.lineWidth = 2;
            line(guides, G.path(meter.ends));
            for (const point of meter.ends) { const p = screen(point); guides.beginPath(); guides.arc(p.x, p.y, 3.5, 0, Math.PI * 2); guides.fillStyle = '#e5ffff'; guides.fill(); }
            if (meter.id) { const p = screen(meter.center); guides.fillStyle = '#0c656c'; guides.fillRect(p.x - 12, p.y - 10, 24, 20); guides.fillStyle = '#fff'; guides.font = '11px system-ui'; guides.textAlign = 'center'; guides.fillText(String(meter.id), p.x, p.y + 4); }
        }
    }

    function drawSignals() {
        if (!$('lights').checked || map.getZoom() < 17) return;
        for (const signal of network.signals.values()) {
            const p = screen(network.project(signal.point));
            if (!visible(p)) continue;
            const radius = map.getZoom() >= 19 ? 8 : 6;
            const aspect = Engine.signalAspect(signal, signal.phase, sim.time);
            ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = { green: '#308868', red: '#c26354', amber: '#d7a13a', unknown: '#74827c' }[aspect];
            ctx.fill();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        }
    }

    function drawCars() {
        ctx.clearRect(0, 0, size.x, size.y);
        if (!sim || !transform) return;
        screenCars = [];
        const chosen = sim.cars.find(car => car.id === selected);
        if (chosen) {
            const lane = network.lanes.get(chosen.laneId);
            ctx.lineWidth = 3; ctx.strokeStyle = '#17a58b99'; line(ctx, lane.path);
            ctx.setLineDash([4, 4]);
            for (const id of lane.outgoing) { ctx.strokeStyle = id === chosen.next ? '#14665be6' : '#17a58b80'; line(ctx, network.connections.get(id).path); }
            ctx.setLineDash([]);
        }
        drawSignals();
        if (chosen) {
            const signal = sim.signalAhead(chosen, selectedInfo?.kind === 'signal');
            if (signal) {
                const pose = sim.pose(chosen), from = screen([pose.x, pose.y]), stop = screen([signal.stop.x, signal.stop.y]);
                const target = screen(network.project(signal.point));
                const color = { red: '#b64432', amber: '#ba881d', green: '#238261' }[signal.aspect];
                ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
                ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(stop.x, stop.y); ctx.lineTo(target.x, target.y); ctx.stroke();
                ctx.setLineDash([]); ctx.beginPath(); ctx.arc(target.x, target.y, 11, 0, Math.PI * 2); ctx.stroke();
                ctx.beginPath(); ctx.arc(target.x, target.y, 5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
            }
        }
        for (const car of sim.cars) {
            const pose = running ? sim.renderPose(car) : sim.pose(car), p = screen([pose.x, pose.y]);
            if (!visible(p)) continue;
            screenCars.push({ id: car.id, x: p.x, y: p.y });
            const length = 4.4 * transform.sx;
            const width = 1.8 * transform.sx;
            if (scene.zoom < 17) { ctx.beginPath(); ctx.arc(p.x, p.y, 1.25, 0, Math.PI * 2); ctx.fillStyle = colors[car.color]; ctx.fill(); continue; }
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(-pose.angle);
            if (selected === car.id) {
                ctx.beginPath(); ctx.arc(0, 0, length * .9, 0, Math.PI * 2);
                ctx.strokeStyle = '#177c6eb0'; ctx.lineWidth = 1.5; ctx.stroke();
            } else if (selectedInfo?.carId === car.id) {
                ctx.beginPath(); ctx.arc(0, 0, length * .9, 0, Math.PI * 2);
                ctx.strokeStyle = '#bb7926'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
            }
            ctx.shadowColor = '#16362644'; ctx.shadowBlur = .8; ctx.shadowOffsetY = 1;
            ctx.fillStyle = colors[car.color]; ctx.strokeStyle = '#243e465c'; ctx.lineWidth = .6;
            ctx.beginPath(); ctx.roundRect(-length / 2, -width / 2, length, width, Math.min(2, width * .24)); ctx.fill(); ctx.stroke();
            ctx.shadowColor = 'transparent'; ctx.shadowOffsetY = 0;
            ctx.fillStyle = '#143e4ec9'; ctx.fillRect(length * .12, -width * .34, length * .17, width * .68);
            ctx.fillStyle = '#143e4e70'; ctx.fillRect(-length * .28, -width * .3, length * .11, width * .6);
            ctx.fillStyle = car.braking ? '#ff5742' : '#a95445';
            ctx.fillRect(-length / 2, -width * .38, 1.5, width * .22); ctx.fillRect(-length / 2, width * .16, 1.5, width * .22);
            if (car.change && Math.floor(sim.time * 3) % 2 === 0) {
                const from = network.lanes.get(car.laneId), to = network.lanes.get(car.change.to);
                ctx.fillStyle = '#ffc653'; ctx.fillRect(length * .25, to.ordinal < from.ordinal ? -width / 2 - 1 : width / 2 - 1, 3, 2);
            }
            ctx.restore();
        }
        frameCount++;
    }

    function updateUI() {
        if (!sim) return;
        const stats = sim.stats();
        $('moving').textContent = stats.moving; $('waiting').textContent = stats.waiting;
        $('crossings').textContent = stats.crossings.toLocaleString('hr-HR'); $('changes').textContent = stats.laneChanges.toLocaleString('hr-HR');
        const seconds = Math.floor(stats.time);
        $('clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        $('play-label').textContent = t(running ? 'pause' : 'play'); $('play-icon').textContent = running ? 'Ⅱ' : '▶';
        $('play').setAttribute('aria-pressed', String(running));
        const counts = network.data.source.counts;
        $('source-detail').textContent = `${t('solved', { count: counts.savedJunctions })}. ${t('coverage', { unresolved: counts.unresolvedNodes, partial: counts.partialJunctions })}. ${t('snapshot', { date: network.data.source.osmTimestamp.slice(0, 10) })}.`;
        const car = sim.cars.find(item => item.id === selected);
        if (!car) { selected = null; following = false; }
        document.querySelector('.inspector').hidden = !car;
        selectedInfo = car ? sim.inspectCar(car) : null;
        $('selected-title').textContent = car ? t('selected', { id: car.id }) : t('follow');
        $('follow').textContent = t(following ? 'unfollow' : 'follow');
        $('selected-status').hidden = !car;
        if (car) {
            const lane = network.lanes.get(car.laneId);
            $('selected-detail').textContent = `${lane.name || t('unnamed')} · ${t('lane', { number: lane.ordinal + 1 })}\n${t('exits', { count: lane.outgoing.length })}`;
            document.querySelector('.car-swatch').style.backgroundColor = colors[car.color];
            const reason = !running && ['starting', 'moving'].includes(selectedInfo.kind) ? 'paused' : selectedInfo.kind;
            $('selected-reason-label').textContent = t(reason === 'moving' ? 'moving' : 'stopReason');
            $('selected-reason').textContent = t(`reason${reason[0].toUpperCase()}${reason.slice(1)}`, {
                id: selectedInfo.carId, speed: selectedInfo.speed?.toFixed(1),
                aspect: selectedInfo.signal ? t(`aspect${selectedInfo.signal.aspect[0].toUpperCase()}${selectedInfo.signal.aspect.slice(1)}`) : ''
            });
            $('selected-blocker').hidden = selectedInfo.kind !== 'exit' || selectedInfo.carId == null;
            $('selected-blocker').textContent = t('blockingCar', { id: selectedInfo.carId });
            const signal = selectedInfo.signal;
            $('selected-signal').dataset.aspect = signal?.aspect || '';
            $('selected-signal').textContent = signal ? t('signalApproach', {
                road: signal.name || t('unnamed'), direction: t(`direction${signal.direction}`), distance: signal.distance.toFixed(1),
                aspect: t(`aspect${signal.aspect[0].toUpperCase()}${signal.aspect.slice(1)}`)
            }) : t(sim.signals ? 'signalNone' : 'signalDisabled');
            $('show-signal').hidden = !signal;
        } else $('selected-detail').textContent = '';
        updateTools();
    }

    function attachCounters() { sim.listeners.add((car, before, after, time) => counters.observe(car, before, after, time)); }
    function updateTools() {
        const active = editor.closures.filter(c => c.status === 'active').length;
        document.querySelector('.closure-status').hidden = !editor.closures.length;
        $('closure-count').textContent = t('closureCount', { active, pending: editor.closures.length - active });
        $('clear-closures').disabled = !editor.closures.length;
        $('chunk-size').disabled = tool !== 'close';
        document.querySelector('.chunk-control').hidden = tool !== 'close';
        $('meter-panel').hidden = !counters.meters.length;
        const select = $('meter-select');
        if (select.options.length !== counters.meters.length || [...select.options].some((o, i) => o.value !== String(counters.meters[i].id))) {
            select.replaceChildren(...counters.meters.map(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = t('meterName', { id: m.id }); return o; }));
        }
        selectedMeter ||= counters.meters[0]?.id;
        select.value = selectedMeter;
        const meter = counters.meters.find(m => m.id === selectedMeter);
        if (!meter) return;
        for (const option of select.options) option.textContent = t('meterName', { id: option.value });
        $('meter-road').textContent = meter.name || t('unnamed');
        $('meter-rows').replaceChildren(...counters.rows(meter, sim.time).map(row => {
            const tr = document.createElement('tr');
            const before = meter.baseline?.rates.find(r => r.laneId === row.laneId)?.rate;
            for (const value of [`${row.ordinal + 1} · ${t(`direction${row.direction}`)}`, row.count, row.rate.toFixed(1), before == null ? '—' : before.toFixed(1)]) {
                const td = document.createElement('td'); td.textContent = value; tr.append(td);
            }
            return tr;
        }));
        $('meter-window').textContent = t('meterWindow', { seconds: Math.min(60, Math.floor(sim.time - meter.since)) })
            + (meter.baseline ? ` ${t('baselineWindow', { seconds: Math.floor(meter.baseline.duration) })}` : '');
    }
    function hitAt(event) {
        if (!laneIndex || scene.zoom < 17) return null;
        return laneIndex.hit(baseNetwork.project([event.latlng.lng, event.latlng.lat]), 2 / Math.abs(transform.sx));
    }
    function handleToolClick(event) {
        if (!sim) return false;
        const hit = hitAt(event);
        if (tool === 'close') {
            if (hit) {
                counters.markIntervention(sim.time);
                editor.toggle(Scenario.chunk(hit.lane, hit.s, Number($('chunk-size').value)));
                network = sim.network; updateUI(); drawGuides(); drawCars(); wake();
            }
            return true;
        }
        if (tool === 'meter') {
            const shape = Meters.profile(laneIndex, hit);
            if (shape) { selectedMeter = counters.add(shape, sim.time).id; updateUI(); drawGuides(); }
            return true;
        }
        const point = baseNetwork.project([event.latlng.lng, event.latlng.lat]);
        const nearest = counters.meters.map(m => ({ m, distance: G.nearest(G.path(m.ends), point).distance }))
            .sort((a, b) => a.distance - b.distance)[0];
        if (nearest && nearest.distance < 5 / Math.abs(transform.sx)) {
            selectedMeter = nearest.m.id; updateUI(); drawGuides(); return true;
        }
        return false;
    }
    let hoverFrame = null, pointerEvent = null;
    map.on('mousemove', event => {
        pointerEvent = event;
        if (hoverFrame) return;
        hoverFrame = requestAnimationFrame(() => {
            hoverFrame = null;
            if (scene.zooming) return;
            hover = hitAt(pointerEvent); meterHover = tool === 'meter' ? Meters.profile(laneIndex, hover) : null;
            const tooltip = $('lane-tooltip'); tooltip.hidden = !hover;
            if (hover) {
                tooltip.textContent = t('laneHover', { road: hover.lane.name || t('unnamed'), number: hover.lane.ordinal + 1 });
                if (tool === 'close') {
                    const chunk = Scenario.chunk(hover.lane, hover.s, Number($('chunk-size').value));
                    const closed = editor.closures.some(c => c.laneId === chunk.laneId && c.start < chunk.end && c.end > chunk.start);
                    tooltip.textContent += ` · ${t(closed ? 'closedHover' : 'openHover', { length: Math.round(chunk.end - chunk.start) })}`;
                }
                const p = pointerEvent.containerPoint;
                tooltip.style.left = `${Math.max(8, Math.min(map.getSize().x - tooltip.offsetWidth - 8, p.x + 15))}px`;
                tooltip.style.top = `${Math.max(8, p.y - tooltip.offsetHeight - 12)}px`;
            }
            drawGuides();
        });
    });
    map.on('mouseout dragstart zoomstart', () => { hover = meterHover = null; $('lane-tooltip').hidden = true; drawGuides(); });
    function setTool(value) {
        tool = value; following = false; meterHover = null;
        document.querySelectorAll('[data-tool]').forEach(button => {
            const active = button.dataset.tool === tool; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
        });
        map.getContainer().classList.toggle('editing-road', tool !== 'inspect');
        if (sim) { updateUI(); drawGuides(); }
    }
    document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
    document.addEventListener('keydown', event => { if (event.key === 'Escape') setTool('inspect'); });
    $('chunk-size').addEventListener('change', drawGuides);
    $('clear-closures').addEventListener('click', () => { counters.markIntervention(sim.time); editor.clear(); network = sim.network; updateUI(); drawGuides(); drawCars(); wake(); });
    $('meter-select').addEventListener('change', () => { selectedMeter = Number($('meter-select').value); updateUI(); drawGuides(); });
    $('reset-meter').addEventListener('click', () => { counters.reset(selectedMeter, sim.time); updateUI(); });
    $('remove-meter').addEventListener('click', () => { counters.remove(selectedMeter); selectedMeter = counters.meters[0]?.id; updateUI(); drawGuides(); });

    function updateAudio() {
        if (!sim || !transform) return;
        const bounds = map.getBounds();
        const southwest = network.project([bounds.getWest(), bounds.getSouth()]);
        const northeast = network.project([bounds.getEast(), bounds.getNorth()]);
        const center = network.project([map.getCenter().lng, map.getCenter().lat]);
        audio.update(window.TrafficAudio.mix(sim.cars.map(car => ({ pose: sim.pose(car), speed: car.speed })), {
            center: { x: center[0], y: center[1] },
            extent: { minX: southwest[0], minY: southwest[1], maxX: northeast[0], maxY: northeast[1] }
        }, running && !document.hidden && $('sound').checked));
    }
    function soundError(error) {
        $('sound').checked = false;
        console.error(`[${new Date().toISOString()}] Traffic sound:`, error);
    }
    function syncSound(gesture = false) {
        if (running && !document.hidden && $('sound').checked && (gesture || audio.context)) {
            if (!audio.active) audio.start().then(updateAudio).catch(soundError);
        } else if (audio.active) audio.stop().catch(soundError);
    }
    document.addEventListener('pointerdown', () => syncSound(true), { passive: true });
    $('sound').addEventListener('change', () => { syncSound(true); updateAudio(); });
    document.addEventListener('visibilitychange', () => syncSound());
    window.addEventListener('pagehide', () => { audio.dispose().catch(soundError); });

    function animate(now) {
        frameId = null;
        if (previousFrame != null && running) sim?.advance(Math.min((now - previousFrame) / 1000, .12) * rate);
        previousFrame = now;
        if (sim && following && selected != null) {
            const car = sim.cars.find(item => item.id === selected);
            if (car) { const p = sim.pose(car), ll = network.unproject([p.x, p.y]); map.panTo([ll[1], ll[0]], { animate: false }); }
        }
        drawCars();
        if (editor?.update()) { network = sim.network; drawGuides(); }
        if (now - uiTime > 250) { updateUI(); updateAudio(); uiTime = now; }
        if (running && !document.hidden) frameId = requestAnimationFrame(animate);
    }
    function wake() { previousFrame = null; if (frameId == null && !document.hidden) frameId = requestAnimationFrame(animate); }


    map.on('dragstart', () => { following = false; updateUI(); });
    map.on('click', event => {
        if (handleToolClick(event)) return;
        const pointer = scene.point(event.containerPoint);
        const nearest = screenCars.map(car => ({ ...car, distance: Math.hypot(car.x - pointer.x, car.y - pointer.y) }))
            .sort((a, b) => a.distance - b.distance)[0];
        const mapped = network && $('lights').checked && map.getZoom() >= 17
            ? [...network.signals.values()].map(signal => {
                const p = screen(network.project(signal.point));
                return { signal, distance: Math.hypot(p.x - pointer.x, p.y - pointer.y) };
            }).sort((a, b) => a.distance - b.distance)[0] : null;
        if (mapped?.distance < 12 && mapped.distance < (nearest?.distance ?? Infinity)) {
            following = false; updateUI(); openSignal(mapped.signal);
            return;
        }
        selected = nearest?.distance < 22 ? nearest.id : null;
        following = false; updateUI(); drawCars();
        if (selected != null) document.querySelector('.inspector').scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    });
    function openSignal(signal) {
        $('status').hidden = true;
        const content = document.createElement('div');
        const title = document.createElement('strong'); title.textContent = t('signalSource', { road: signal.name || t('unnamed'), direction: t(`direction${signal.direction}`) });
        const detail = document.createElement('p'); detail.textContent = t('signalDetails');
        content.append(title, detail);
        for (const source of signal.sourceIds) {
            const id = source.replace('osm-node:', ''), link = document.createElement('a');
            link.textContent = `${t('signalLink')} · ${id}`;
            link.href = `https://www.openstreetmap.org/node/${encodeURIComponent(id)}`;
            link.target = '_blank'; link.rel = 'noopener'; content.append(link, document.createElement('br'));
        }
        signalPopup = L.popup({ maxWidth: Math.max(140, Math.min(280, map.getSize().x - 72)), autoPanPadding: [16, 16] })
            .setLatLng([signal.point[1], signal.point[0]]).setContent(content).openOn(map);
        const close = signalPopup.getElement().querySelector('.leaflet-popup-close-button');
        if (close) { close.setAttribute('aria-label', t('closePopup')); close.title = t('closePopup'); }
    }
    $('show-signal').addEventListener('click', () => {
        const car = sim.cars.find(item => item.id === selected);
        const signal = car && sim.signalAhead(car, selectedInfo?.kind === 'signal');
        if (!signal) return;
        following = false;
        map.setView([signal.point[1], signal.point[0]], Math.max(19, map.getZoom()), { animate: !reduced });
        document.querySelector('.map-stage').scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
        openSignal(network.signals.get(signal.id)); updateUI(); drawCars();
    });
    new ResizeObserver(() => { map.invalidateSize({ animate: false }); resize(); }).observe(document.querySelector('.map-stage'));
    document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(frameId); frameId = null; previousFrame = null; } else wake(); });
    $('play').addEventListener('click', () => {
        running = !running; syncSound(true);
        if (!running) { cancelAnimationFrame(frameId); frameId = null; } else wake();
        $('status').hidden = true; updateUI();
    });
    $('reset').addEventListener('click', () => {
        sim = new Engine.Simulation(network, { count: Number($('density').value), seed: ++seed, signals: $('lights').checked });
        editor.setSimulation(sim); attachCounters();
        for (const meter of counters.meters) counters.reset(meter.id, 0);
        selected = null; following = false; updateUI(); drawCars(); wake();
    });
    $('speed').addEventListener('input', () => { rate = Number($('speed').value); $('speed-value').textContent = `${rate}×`; });
    $('density').addEventListener('input', () => { $('density-value').textContent = $('density').value; sim?.setCount(Number($('density').value)); updateUI(); drawCars(); });
    $('lights').addEventListener('change', () => { if (sim) sim.signals = $('lights').checked; updateUI(); drawCars(); });
    $('lanes').addEventListener('change', drawGuides);
    $('follow').addEventListener('click', () => {
        if (following) following = false;
        else {
            selected ||= screenCars[0]?.id || sim.cars[0]?.id;
            following = selected != null;
        }
        updateUI(); wake();
    });
    document.querySelectorAll('[data-place]').forEach(button => button.addEventListener('click', () => {
        following = false;
        const place = places[button.dataset.place];
        if (place) map.setView(place.slice(0, 2), place[2], { animate: false });
        else map.fitBounds([[network.data.bbox[1], network.data.bbox[0]], [network.data.bbox[3], network.data.bbox[2]]], { padding: [35, 35], animate: false });
        document.querySelectorAll('[data-place]').forEach(item => item.classList.toggle('active', item === button));
        updateUI();
    }));
    document.querySelector('a[href="#o-simulatoru"]').addEventListener('click', () => { $('o-simulatoru').open = true; });

    async function load() {
        try {
            const response = await fetch('/api/promet/simulator/network', { cache: 'no-store' });
            if (!response.ok) throw new Error(`Traffic data: HTTP ${response.status}`);
            const data = await response.json();
            network = baseNetwork = Engine.createNetwork(data);
            laneIndex = new Meters.LaneIndex(baseNetwork); buildRoadEdges();
            surface = window.TrafficSurface.build(baseNetwork, data.surfaceLanes);
            sim = new Engine.Simulation(network, { count: Number($('density').value), seed });
            editor = new Scenario.Editor(baseNetwork, sim); attachCounters();
            if (!network.spawnLanes.length) throw new Error('The exported graph has no usable starting lanes.');
            L.rectangle([[data.bbox[1], data.bbox[0]], [data.bbox[3], data.bbox[2]]], {
                color: '#557d68', weight: 1, dashArray: '5 7', fill: false, interactive: false
            }).addTo(map);
            $('play').disabled = false; $('reset').disabled = false; $('follow').disabled = false;
            $('status').hidden = true;
            resize(); updateUI(); wake();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Traffic preview:`, error);
            $('status').replaceChildren(document.createTextNode(t('error')));
            const button = document.createElement('button'); button.textContent = t('retry');
            button.addEventListener('click', load, { once: true }); $('status').append(button);
            $('status').hidden = false;
        }
    }
    // Read-only diagnostics expose the rendered artifact for manual browser verification.
    window.trafficPreview = {
        get simulation() { return sim; }, get network() { return network; }, get baseNetwork() { return baseNetwork; }, get editor() { return editor; }, counters, laneIndex: () => laneIndex, scene, map,
        get audio() { return audio; },
        inspect: () => ({ ...sim?.stats(), frameCount, tileErrors, visibleCars: screenCars.length,
            running, selected, following, tileCount: document.querySelectorAll('.leaflet-tile-loaded').length })
    };
    await load();
})();
