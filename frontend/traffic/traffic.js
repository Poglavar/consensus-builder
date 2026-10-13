// Leaflet/canvas presentation and controls for the pure traffic simulation.
(async function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const t = (key, params) => window.i18n.t(`traffic.${key}`, params);
    const Engine = window.TrafficSimulation;
    const colors = ['#237e88', '#ce7943', '#e4ae4a', '#5968a0', '#668e69', '#f4f0dc', '#bd6977'];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || new URLSearchParams(location.search).has('reduceMotion');
    const map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 13, maxZoom: 20 });
    L.control.zoom({ position: 'topright' }).addTo(map);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 20, maxNativeZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    const places = { miramarska: [45.80013, 15.97458, 18], center: [45.8078, 15.9776, 18], west: [45.79992, 15.95386, 18] };
    map.setView(places.miramarska.slice(0, 2), places.miramarska[2]);
    const guideCanvas = $('guides'), carCanvas = $('cars');
    const guides = guideCanvas.getContext('2d'), ctx = carCanvas.getContext('2d');
    let network, sim, running = !reduced, rate = 2, seed = 52, selected = null, following = false;
    let signalPopup = null;
    let transform, size = { x: 0, y: 0 }, previousFrame = null, uiTime = 0, frameId = null;
    let screenCars = [], frameCount = 0, tileErrors = 0;
    tiles.on('tileerror', () => { tileErrors++; });

    function resize() {
        size = map.getSize();
        if (signalPopup?.isOpen()) {
            signalPopup.options.maxWidth = Math.max(140, Math.min(280, size.x - 72));
            signalPopup.update();
        }
        const dpr = Math.min(devicePixelRatio || 1, 2);
        for (const canvas of [guideCanvas, carCanvas]) {
            canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
            canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
            canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        updateTransform(); drawGuides(); drawCars();
    }

    function updateTransform() {
        if (!network) return;
        const origin = map.latLngToContainerPoint([network.origin[1], network.origin[0]]);
        const east = network.unproject([100, 0]), north = network.unproject([0, 100]);
        transform = { x: origin.x, y: origin.y,
            sx: (map.latLngToContainerPoint([east[1], east[0]]).x - origin.x) / 100,
            sy: (map.latLngToContainerPoint([north[1], north[0]]).y - origin.y) / 100 };
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

    function drawGuides() {
        guides.clearRect(0, 0, size.x, size.y);
        if (!network || !transform || !$('lanes').checked) return;
        const zoom = map.getZoom();
        guides.strokeStyle = zoom >= 17 ? '#367f784f' : '#367f7828';
        guides.lineWidth = zoom >= 19 ? 1.3 : .8;
        for (const lane of network.lanes.values()) {
            if (lane.highway === 'service' || !routeVisible(lane.path)) continue;
            line(guides, lane.path);
            if (zoom < 18 || lane.path.length < 15) continue;
            const p = Engine.sample(lane.path, lane.path.length * .55), s = screen([p.x, p.y]);
            if (!visible(s)) continue;
            guides.save(); guides.translate(s.x, s.y); guides.rotate(-p.angle);
            guides.beginPath(); guides.moveTo(-3, -2); guides.lineTo(0, 0); guides.lineTo(-3, 2); guides.stroke(); guides.restore();
        }
        if (zoom >= 18) {
            guides.strokeStyle = '#367f7827'; guides.lineWidth = .75;
            for (const connection of network.connections.values()) {
                if (routeVisible(connection.path)) line(guides, connection.path);
            }
        }
    }

    function drawSignals() {
        if (!$('lights').checked || map.getZoom() < 17) return;
        for (const signal of network.signals.values()) {
            const p = screen(network.project(signal.point));
            if (!visible(p)) continue;
            const radius = map.getZoom() >= 19 ? 4 : 3;
            const states = signal.phases.length ? signal.phases.map(phase => Engine.signalAspect(signal, phase, sim.time)) : ['unknown'];
            for (let index = 0; index < states.length; index++) {
                const start = index * Math.PI * 2 / states.length - Math.PI / 2;
                ctx.beginPath(); ctx.moveTo(p.x, p.y);
                ctx.arc(p.x, p.y, radius, start, start + Math.PI * 2 / states.length); ctx.closePath();
                ctx.fillStyle = { green: '#308868', red: '#c26354', amber: '#d7a13a', unknown: '#74827c' }[states[index]];
                ctx.fill();
            }
            ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.strokeStyle = '#ffffffdd'; ctx.lineWidth = 1; ctx.stroke();
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
        for (const car of sim.cars) {
            const pose = sim.pose(car), p = screen([pose.x, pose.y]);
            if (!visible(p)) continue;
            screenCars.push({ id: car.id, x: p.x, y: p.y });
            const length = Math.max(8, Math.min(31, 4.4 * transform.sx));
            const width = Math.max(4.2, Math.min(13, 1.9 * transform.sx));
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(-pose.angle);
            if (selected === car.id) {
                ctx.beginPath(); ctx.arc(0, 0, length * .9, 0, Math.PI * 2);
                ctx.strokeStyle = '#177c6eb0'; ctx.lineWidth = 1.5; ctx.stroke();
            }
            ctx.shadowColor = '#16362644'; ctx.shadowBlur = 2; ctx.shadowOffsetY = 1;
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
        $('crossings').textContent = stats.crossings.toLocaleString(); $('changes').textContent = stats.laneChanges.toLocaleString();
        const seconds = Math.floor(stats.time);
        $('clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        $('play-label').textContent = t(running ? 'pause' : 'play'); $('play-icon').textContent = running ? 'Ⅱ' : '▶';
        $('play').setAttribute('aria-pressed', String(running));
        $('network-label').textContent = t('network', { lanes: network.lanes.size.toLocaleString(), connections: network.connections.size.toLocaleString() });
        $('source-detail').textContent = `${t('solved', { count: network.data.source.savedJunctions.length })}. ${t('snapshot', { date: network.data.source.osmTimestamp.slice(0, 10) })}.`;
        const car = sim.cars.find(item => item.id === selected);
        if (!car) { selected = null; following = false; }
        $('selected-title').textContent = car ? t('selected', { id: car.id }) : t('follow');
        $('follow').textContent = t(following ? 'unfollow' : 'follow');
        if (car) {
            const lane = network.lanes.get(car.laneId);
            $('selected-detail').textContent = `${lane.name || t('unnamed')} · ${t('lane', { number: lane.ordinal + 1 })}\n${t(car.state)} · ${t('exits', { count: lane.outgoing.length })}`;
            document.querySelector('.car-swatch').style.backgroundColor = colors[car.color];
        } else $('selected-detail').textContent = t('selectHint');
    }

    function animate(now) {
        frameId = null;
        if (previousFrame != null && running) sim?.advance(Math.min((now - previousFrame) / 1000, .12) * rate);
        previousFrame = now;
        if (sim && following && selected != null) {
            const car = sim.cars.find(item => item.id === selected);
            if (car) { const p = sim.pose(car), ll = network.unproject([p.x, p.y]); map.panTo([ll[1], ll[0]], { animate: false }); }
        }
        drawCars();
        if (now - uiTime > 250) { updateUI(); uiTime = now; }
        if (running && !document.hidden) frameId = requestAnimationFrame(animate);
    }
    function wake() { previousFrame = null; if (frameId == null && !document.hidden) frameId = requestAnimationFrame(animate); }

    map.on('move zoom resize', () => { updateTransform(); drawGuides(); drawCars(); });
    map.on('dragstart', () => { following = false; updateUI(); });
    map.on('click', event => {
        const nearest = screenCars.map(car => ({ ...car, distance: Math.hypot(car.x - event.containerPoint.x, car.y - event.containerPoint.y) }))
            .sort((a, b) => a.distance - b.distance)[0];
        const mapped = network && $('lights').checked && map.getZoom() >= 17
            ? [...network.signals.values()].map(signal => {
                const p = screen(network.project(signal.point));
                return { signal, distance: Math.hypot(p.x - event.containerPoint.x, p.y - event.containerPoint.y) };
            }).sort((a, b) => a.distance - b.distance)[0] : null;
        if (mapped?.distance < 12 && mapped.distance < (nearest?.distance ?? Infinity)) {
            following = false; updateUI();
            const signal = mapped.signal, id = signal.id.replace('osm-node:', '');
            const content = document.createElement('div');
            const title = document.createElement('strong'); title.textContent = t('signalSource', { id });
            const detail = document.createElement('p'); detail.textContent = t('signalDetails');
            const link = document.createElement('a'); link.textContent = t('signalLink');
            link.href = `https://www.openstreetmap.org/node/${encodeURIComponent(id)}`;
            link.target = '_blank'; link.rel = 'noopener';
            content.append(title, detail, link);
            signalPopup = L.popup({ maxWidth: Math.max(140, Math.min(280, size.x - 72)), autoPanPadding: [16, 16] })
                .setLatLng([signal.point[1], signal.point[0]]).setContent(content).openOn(map);
            return;
        }
        selected = nearest?.distance < 22 ? nearest.id : null;
        following = false; updateUI(); drawCars();
    });
    new ResizeObserver(() => { map.invalidateSize({ animate: false }); resize(); }).observe(document.querySelector('.map-stage'));
    document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(frameId); frameId = null; previousFrame = null; } else wake(); });
    $('play').addEventListener('click', () => {
        running = !running;
        if (!running) { cancelAnimationFrame(frameId); frameId = null; } else wake();
        $('status').hidden = true; updateUI();
    });
    $('reset').addEventListener('click', () => {
        sim = new Engine.Simulation(network, { count: Number($('density').value), seed: ++seed, signals: $('lights').checked });
        selected = null; following = false; updateUI(); drawCars(); wake();
    });
    $('speed').addEventListener('input', () => { rate = Number($('speed').value); $('speed-value').textContent = `${rate}×`; });
    $('density').addEventListener('input', () => { $('density-value').textContent = $('density').value; sim?.setCount(Number($('density').value)); updateUI(); drawCars(); });
    $('lights').addEventListener('change', () => { if (sim) sim.signals = $('lights').checked; drawCars(); });
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
    $('language').value = window.i18n.getLanguage();
    $('language').addEventListener('change', () => window.i18n.setLanguage($('language').value));
    window.i18n.onChange(() => { document.title = `${t('title')} · Lane Lab`; updateUI(); });

    async function load() {
        try {
            const response = await fetch('data/central.json.gz?v=20261014b', { cache: 'no-store' });
            if (!response.ok) throw new Error(`Traffic data: HTTP ${response.status}`);
            const data = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
            network = Engine.createNetwork(data);
            sim = new Engine.Simulation(network, { count: Number($('density').value), seed });
            if (!network.spawnLanes.length) throw new Error('The exported graph has no usable starting lanes.');
            L.rectangle([[data.bbox[1], data.bbox[0]], [data.bbox[3], data.bbox[2]]], {
                color: '#557d68', weight: 1, dashArray: '5 7', fill: false, interactive: false
            }).addTo(map);
            $('play').disabled = false; $('reset').disabled = false; $('follow').disabled = false;
            $('status').hidden = !reduced;
            if (reduced) $('status').textContent = t('reduceMotion');
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
        get simulation() { return sim; }, get network() { return network; }, map,
        inspect: () => ({ ...sim?.stats(), frameCount, tileErrors, visibleCars: screenCars.length,
            running, selected, following, tileCount: document.querySelectorAll('.leaflet-tile-loaded').length })
    };
    await window.i18n.ready;
    await load();
})();
