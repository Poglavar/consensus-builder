// World view: a full-viewport three.js globe for choosing a place. Land is painted by parcel-data
// coverage tier (world-coverage.js), clicking anywhere shows what is available there, a search box
// flies to a place, and flyTo() dives the camera to a point for the handoff into the 2D map.
// Browser only; depends on window.whenThreeReady() (index.html import map), window.GlobeMath and
// window.WorldCoverage. Nothing here touches the app's map or city config: every action is a callback.
//
// API (window.WorldView)
//   open(opts) -> Promise<void>   builds #world-view and resolves after the first frame.
//     opts.onOpenCity(cityId, point)   tier 'live' action ("Open <city>")
//     opts.chooseCity(place) -> cityId  which live city a 'live' place opens (default place.cityId)
//     opts.onExplore(point)            "Explore anyway" (non-live tiers)
//     opts.onRequestCity(place)        "Ask for this city" (tier 'source'); may return a Promise —
//                                      resolved shows a thank-you, rejected shows an error line
//     opts.onClose()                   after the view closed through its own close button / Escape
//     opts.closable (default true)     show the close button (false on a first visit)
//     opts.initialView {lat, lon, altitudeKm}   starting camera
//     opts.coverageUrl                 default 'data/world-coverage.json'
//   close()                          removes the overlay and frees every GPU resource
//   isOpen() -> boolean
//   flyTo(point, { altitudeKm = 120, onDone }) -> Promise<cameraState>
//     dives to point {lat, lon}; ≈1.5-2.5 s eased, instant under reduced motion. cameraState is
//     { lat, lon, altitudeKm, leafletZoom } (leafletZoom from GlobeMath.altitudeToLeafletZoom).
//   captureHandoffFrame({ maxWidth = 960, quality = 0.82 }) -> JPEG data URL of the current frame
//   getCamera() -> { lat, lon, altitudeKm }
//   selectPlace(lat, lon) -> Promise  turns the globe to a point and opens its popup
//   project(lat, lon) -> { x, y } | null   viewport pixels of a point (null on the far side)
// `point` passed to callbacks: { lat, lon, place } where place is a WorldCoverage Place.
(function (global) {
    'use strict';

    const GM = global.GlobeMath;
    const R_KM = GM.EARTH_RADIUS_KM;
    const FOV = 40;
    const MIN_USER_ALT_KM = 1500;
    const MAX_ALT_KM = 42000;
    const IDLE_SPIN_DEG_PER_S = 3.2;
    const IDLE_DELAY_MS = 3500;
    const TAP_MAX_PX = 7;
    const TAP_MAX_MS = 600;
    // Legend palette: each tier must read on the deep-blue ocean and against its neighbours.
    const TIER_COLORS = { live: '#43e6a6', source: '#ffc24b', none: '#f2766e', unknown: '#cfc7b3' };
    const LIVE_LABEL_ORDER = ['new_york', 'zagreb', 'buenos_aires', 'belgrade', 'ljubljana', 'colorado', 'split', 'sibenik'];

    let coveragePromise = null;
    let view = null;

    function t(key, fallback, params) {
        let text = fallback;
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const translated = global.i18n.t(key, params || {});
                if (translated && translated !== key) return translated;
            }
        } catch (_) { /* fall back to English */ }
        if (params) Object.keys(params).forEach(name => { text = text.replace(new RegExp('\\{\\{\\s*' + name + '\\s*\\}\\}', 'g'), params[name]); });
        return text;
    }

    function reducedMotion() {
        try {
            if (typeof global.prefersReducedMotion === 'function') return !!global.prefersReducedMotion();
            if (global.__reducedMotion) return true;
            if (new URLSearchParams(global.location.search).has('reduceMotion')) return true;
            return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (_) { return false; }
    }

    const log = message => console.log('[' + new Date().toISOString() + '] [world] ' + message);

    function el(tag, className, attrs) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (attrs) Object.keys(attrs).forEach(k => {
            if (k === 'text') node.textContent = attrs[k];
            else node.setAttribute(k, attrs[k]);
        });
        return node;
    }

    function formatLatLon(lat, lon) {
        const ns = lat >= 0 ? 'N' : 'S'; const ew = lon >= 0 ? 'E' : 'W';
        return Math.abs(lat).toFixed(2) + '°' + ns + ' ' + Math.abs(lon).toFixed(2) + '°' + ew;
    }

    // ---- texture painting --------------------------------------------------------------------

    function project(lon, lat, W, H) { return [((lon + 180) / 360) * W, ((90 - lat) / 180) * H]; }

    function traceRings(ctx, rings, W, H) {
        ctx.beginPath();
        for (const ring of rings) {
            for (let i = 0; i < ring.length; i += 2) {
                const [x, y] = project(ring[i], ring[i + 1], W, H);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
        }
    }

    function noiseTile(size, alpha) {
        const c = document.createElement('canvas'); c.width = c.height = size;
        const g = c.getContext('2d'); const img = g.createImageData(size, size);
        let seed = 1234567;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        for (let i = 0; i < img.data.length; i += 4) {
            const v = rnd() < 0.5 ? 0 : 255;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
            img.data[i + 3] = Math.floor(rnd() * alpha);
        }
        g.putImageData(img, 0, 0);
        return c;
    }

    // Returns { color: canvas W×H, mask: canvas (ocean = white) } painted from the coverage outlines.
    function paintEarth(coverage, W, H) {
        const color = document.createElement('canvas'); color.width = W; color.height = H;
        const ctx = color.getContext('2d');
        const s = W / 4096;

        // Ocean: deep at the poles, brighter toward the tropics.
        const ocean = ctx.createLinearGradient(0, 0, 0, H);
        ocean.addColorStop(0, '#081a3d'); ocean.addColorStop(0.28, '#0d3170');
        ocean.addColorStop(0.5, '#124596'); ocean.addColorStop(0.72, '#0d3170'); ocean.addColorStop(1, '#081a3d');
        ctx.fillStyle = ocean; ctx.fillRect(0, 0, W, H);

        const countries = coverage.countries.filter(c => c.rings.length);

        // Continental shelf: a soft cyan halo hugging every coast.
        ctx.save();
        ctx.fillStyle = 'rgba(64, 170, 235, 0.55)';
        ctx.shadowColor = 'rgba(90, 200, 255, 0.9)';
        ctx.shadowBlur = 26 * s;
        for (const c of countries) { traceRings(ctx, c.rings, W, H); ctx.fill('evenodd'); }
        ctx.restore();

        // Graticule every 15°, faint, with the equator a touch stronger.
        ctx.save();
        ctx.lineWidth = Math.max(1, 1.6 * s);
        for (let lon = -180; lon <= 180; lon += 15) {
            ctx.strokeStyle = 'rgba(170, 210, 255, 0.10)';
            const [x] = project(lon, 0, W, H);
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }
        for (let lat = -75; lat <= 75; lat += 15) {
            ctx.strokeStyle = lat === 0 ? 'rgba(170, 210, 255, 0.2)' : 'rgba(170, 210, 255, 0.10)';
            const [, y] = project(0, lat, W, H);
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        ctx.restore();

        // Land on its own layer so grain and inner shading stay on land.
        const land = document.createElement('canvas'); land.width = W; land.height = H;
        const lctx = land.getContext('2d');
        for (const c of countries) {
            lctx.fillStyle = TIER_COLORS[c.tier] || TIER_COLORS.unknown;
            traceRings(lctx, c.rings, W, H); lctx.fill('evenodd');
        }
        lctx.save();
        lctx.globalCompositeOperation = 'source-atop';
        lctx.fillStyle = lctx.createPattern(noiseTile(256, 12), 'repeat');
        lctx.fillRect(0, 0, W, H);
        // Latitude shading: land darkens slightly toward the poles.
        const shade = lctx.createLinearGradient(0, 0, 0, H);
        shade.addColorStop(0, 'rgba(10, 25, 60, 0.28)'); shade.addColorStop(0.35, 'rgba(10, 25, 60, 0)');
        shade.addColorStop(0.65, 'rgba(10, 25, 60, 0)'); shade.addColorStop(1, 'rgba(10, 25, 60, 0.28)');
        lctx.fillStyle = shade; lctx.fillRect(0, 0, W, H);
        lctx.restore();
        // Country borders: thin, darker, so neighbours of the same tier still read as countries.
        lctx.lineJoin = 'round';
        lctx.strokeStyle = 'rgba(12, 30, 62, 0.45)';
        lctx.lineWidth = Math.max(1, 1.8 * s);
        for (const c of countries) { traceRings(lctx, c.rings, W, H); lctx.stroke(); }
        ctx.drawImage(land, 0, 0);
        // Coastline highlight.
        ctx.strokeStyle = 'rgba(225, 245, 255, 0.35)';
        ctx.lineWidth = Math.max(1, 1.2 * s);
        for (const c of countries) { traceRings(ctx, c.rings, W, H); ctx.stroke(); }

        const mask = document.createElement('canvas'); mask.width = 1024; mask.height = 512;
        const mctx = mask.getContext('2d');
        mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, 1024, 512);
        mctx.fillStyle = '#000';
        for (const c of countries) { traceRings(mctx, c.rings, 1024, 512); mctx.fill('evenodd'); }
        return { color, mask };
    }

    // ---- shaders -----------------------------------------------------------------------------

    const EARTH_VERT = `
        varying vec2 vUv; varying vec3 vNormal; varying vec3 vView;
        void main() {
            vUv = uv;
            vNormal = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = -mv.xyz;
            gl_Position = projectionMatrix * mv;
        }`;
    const EARTH_FRAG = `
        uniform sampler2D map; uniform sampler2D oceanMask; uniform vec3 lightDir; uniform float haze;
        varying vec2 vUv; varying vec3 vNormal; varying vec3 vView;
        void main() {
            vec3 base = texture2D(map, vUv).rgb;
            float ocean = texture2D(oceanMask, vUv).r;
            vec3 n = normalize(vNormal); vec3 v = normalize(vView); vec3 l = normalize(lightDir);
            float diff = max(dot(n, l), 0.0);
            vec3 col = base * (0.5 + 0.7 * diff);
            vec3 h = normalize(l + v);
            col += vec3(0.7, 0.86, 1.0) * pow(max(dot(n, h), 0.0), 70.0) * 0.5 * ocean;
            float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
            col = mix(col, vec3(0.42, 0.7, 1.0), fres * 0.45);
            // Descending through the atmosphere: below a few thousand km the coarse texture would
            // blur, so a sky haze takes over; it is what the handoff frame dissolves out of.
            float hz = haze * (0.9 + 0.1 * sin(vUv.x * 1800.0 + vUv.y * 900.0) * sin(vUv.y * 1500.0));
            col = mix(col, vec3(0.8, 0.89, 0.97), hz);
            gl_FragColor = vec4(col, 1.0);
        }`;
    const ATMO_VERT = `
        varying vec3 vNormal; varying vec3 vView;
        void main() {
            vNormal = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = -mv.xyz;
            gl_Position = projectionMatrix * mv;
        }`;
    const ATMO_FRAG = `
        uniform float limb;
        varying vec3 vNormal; varying vec3 vView;
        void main() {
            float d = -dot(normalize(vNormal), normalize(vView));
            float i = pow(clamp(d / limb, 0.0, 1.0), 2.2);
            vec3 col = mix(vec3(0.16, 0.42, 1.0), vec3(0.5, 0.78, 1.0), i * i);
            gl_FragColor = vec4(col * i * 0.95, i);
        }`;
    const POINTS_VERT = `
        attribute float size; attribute vec3 color; attribute float pulse;
        uniform float pixelRatio; uniform float time;
        varying vec3 vColor; varying float vFade; varying float vPulse;
        void main() {
            vColor = color; vPulse = pulse;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vec3 n = normalize(normalMatrix * normalize(position));
            vFade = smoothstep(0.0, 0.25, dot(n, normalize(-mv.xyz)));
            float grow = pulse > 0.5 ? 1.0 + 0.18 * sin(time * 2.4) : 1.0;
            gl_PointSize = size * pixelRatio * grow;
            gl_Position = projectionMatrix * mv;
        }`;
    const POINTS_FRAG = `
        varying vec3 vColor; varying float vFade; varying float vPulse;
        void main() {
            vec2 p = gl_PointCoord - 0.5; float r = length(p) * 2.0;
            if (r > 1.0) discard;
            float core = 1.0 - smoothstep(0.42, 0.55, r);
            float ring = vPulse > 0.5 ? smoothstep(0.62, 0.74, r) * (1.0 - smoothstep(0.86, 1.0, r)) : 0.0;
            float halo = (1.0 - r) * 0.35;
            vec3 col = mix(vColor, vec3(1.0), core * 0.25);
            float a = max(max(core, ring * 0.9), halo) * vFade;
            gl_FragColor = vec4(col, a);
        }`;
    const STARS_VERT = `
        attribute float size; attribute float bright; uniform float pixelRatio; varying float vBright;
        void main() { vBright = bright; gl_PointSize = size * pixelRatio; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
    const STARS_FRAG = `
        varying float vBright;
        void main() { float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
            gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * vBright, (1.0 - r) * vBright); }`;

    // ---- the view ----------------------------------------------------------------------------

    function hexToRgb(hex) {
        const n = parseInt(hex.slice(1), 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }

    function buildStars(THREE, count) {
        const pos = new Float32Array(count * 3); const size = new Float32Array(count); const bright = new Float32Array(count);
        let seed = 42;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        for (let i = 0; i < count; i++) {
            const u = rnd() * 2 - 1; const a = rnd() * Math.PI * 2; const r = Math.sqrt(1 - u * u);
            pos[i * 3] = 120 * r * Math.cos(a); pos[i * 3 + 1] = 120 * u; pos[i * 3 + 2] = 120 * r * Math.sin(a);
            const m = rnd();
            size[i] = 0.8 + m * m * 2.4; bright[i] = 0.25 + rnd() * 0.75;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('size', new THREE.BufferAttribute(size, 1));
        g.setAttribute('bright', new THREE.BufferAttribute(bright, 1));
        return g;
    }

    function buildCityPoints(THREE, coverage) {
        const items = [];
        coverage.liveCities.forEach(c => items.push({ lat: c.lat, lon: c.lon, color: TIER_COLORS.live, size: 15, pulse: 1 }));
        coverage.cities.forEach(c => items.push({ lat: c.lat, lon: c.lon, color: TIER_COLORS[c.tier] || TIER_COLORS.unknown, size: 8, pulse: 0 }));
        const pos = new Float32Array(items.length * 3); const col = new Float32Array(items.length * 3);
        const size = new Float32Array(items.length); const pulse = new Float32Array(items.length);
        items.forEach((it, i) => {
            pos.set(GM.latLonToVector(it.lat, it.lon, 1.002), i * 3);
            col.set(hexToRgb(it.color), i * 3);
            size[i] = it.size; pulse[i] = it.pulse;
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.setAttribute('size', new THREE.BufferAttribute(size, 1));
        g.setAttribute('pulse', new THREE.BufferAttribute(pulse, 1));
        return g;
    }

    function createView(THREE, coverage, opts) {
        const reduce = reducedMotion();
        const root = el('div', 'world-view', { id: 'world-view', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('world.title', 'Choose a place') });
        const stage = el('div', 'world-view__stage');
        root.appendChild(stage);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
        renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        renderer.setClearColor(0x000000, 0);
        renderer.domElement.className = 'world-view__canvas';
        renderer.domElement.setAttribute('tabindex', '0');
        renderer.domElement.setAttribute('aria-label', t('world.canvasLabel', 'Globe. Drag to rotate, scroll to zoom, click a place to check parcel data.'));
        stage.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(FOV, 1, 0.001, 400);
        const disposables = [];

        const maxTex = renderer.capabilities.maxTextureSize || 4096;
        const W = Math.min(4096, maxTex); const H = W / 2;
        const t0 = performance.now();
        const painted = paintEarth(coverage, W, H);
        log('painted ' + W + '×' + H + ' earth texture in ' + Math.round(performance.now() - t0) + ' ms');
        const colorTex = new THREE.CanvasTexture(painted.color);
        colorTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        colorTex.colorSpace = THREE.NoColorSpace;
        const maskTex = new THREE.CanvasTexture(painted.mask);
        maskTex.colorSpace = THREE.NoColorSpace;
        disposables.push(colorTex, maskTex);

        const sphereGeo = new THREE.SphereGeometry(1, 160, 96);
        const earthMat = new THREE.ShaderMaterial({
            uniforms: { map: { value: colorTex }, oceanMask: { value: maskTex }, lightDir: { value: new THREE.Vector3(-0.55, 0.5, 0.7) }, haze: { value: 0 } },
            vertexShader: EARTH_VERT, fragmentShader: EARTH_FRAG
        });
        const earth = new THREE.Mesh(sphereGeo, earthMat);
        scene.add(earth);

        const atmoScale = 1.16;
        const atmoMat = new THREE.ShaderMaterial({
            uniforms: { limb: { value: Math.sqrt(1 - 1 / (atmoScale * atmoScale)) } },
            vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
            side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        });
        const atmo = new THREE.Mesh(sphereGeo, atmoMat);
        atmo.scale.setScalar(atmoScale);
        scene.add(atmo);

        const pixelRatio = { value: renderer.getPixelRatio() };
        const time = { value: 0 };
        const starGeo = buildStars(THREE, 2600);
        const starMat = new THREE.ShaderMaterial({
            uniforms: { pixelRatio }, vertexShader: STARS_VERT, fragmentShader: STARS_FRAG,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        });
        scene.add(new THREE.Points(starGeo, starMat));

        const cityGeo = buildCityPoints(THREE, coverage);
        const cityMat = new THREE.ShaderMaterial({
            uniforms: { pixelRatio, time }, vertexShader: POINTS_VERT, fragmentShader: POINTS_FRAG,
            transparent: true, depthWrite: false
        });
        const cityPoints = new THREE.Points(cityGeo, cityMat);
        cityPoints.renderOrder = 2;
        scene.add(cityPoints);
        disposables.push(sphereGeo, earthMat, atmoMat, starGeo, starMat, cityGeo, cityMat);

        // ---- DOM chrome ----
        const top = el('div', 'world-view__top');
        const title = el('h1', 'world-view__title');
        const searchWrap = el('div', 'world-search');
        const searchInput = el('input', 'world-search__input', {
            type: 'search', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
            'aria-controls': 'world-search-results', autocomplete: 'off', spellcheck: 'false'
        });
        const results = el('ul', 'world-search__results', { id: 'world-search-results', role: 'listbox' });
        results.hidden = true;
        searchWrap.append(searchInput, results);
        const hint = el('p', 'world-view__hint');
        top.append(title, searchWrap, hint);
        root.appendChild(top);

        const closeBtn = el('button', 'world-view__close', { type: 'button' });
        closeBtn.textContent = '×';
        if (opts.closable !== false) root.appendChild(closeBtn);

        const legend = el('div', 'world-legend');
        const legendTitle = el('p', 'world-legend__title');
        const legendList = el('ul', 'world-legend__list');
        legend.append(legendTitle, legendList);
        root.appendChild(legend);

        const labelLayer = el('div', 'world-view__labels');
        root.appendChild(labelLayer);
        const liveLabels = coverage.liveCities
            .slice().sort((a, b) => LIVE_LABEL_ORDER.indexOf(a.id) - LIVE_LABEL_ORDER.indexOf(b.id))
            .map(city => {
                const node = el('button', 'world-city-label', { type: 'button', text: city.name });
                node.addEventListener('click', ev => { ev.stopPropagation(); select(coverage.tierAt(city.lat, city.lon)); });
                labelLayer.appendChild(node);
                return { city, node, vec: GM.latLonToVector(city.lat, city.lon, 1.002), w: 0, h: 0 };
            });

        const pin = el('div', 'world-pin');
        pin.hidden = true;
        root.appendChild(pin);
        const popup = el('div', 'world-popup', { role: 'dialog', 'aria-live': 'polite' });
        popup.hidden = true;
        root.appendChild(popup);

        function renderStaticText() {
            root.setAttribute('aria-label', t('world.title', 'Choose a place'));
            title.textContent = t('world.title', 'Choose a place');
            searchInput.placeholder = t('world.search.placeholder', 'Search a city or country');
            searchInput.setAttribute('aria-label', t('world.search.label', 'Search places'));
            hint.textContent = t('world.hint', 'Drag to spin · click anywhere to see what parcel data exists there');
            closeBtn.setAttribute('aria-label', t('world.close', 'Close'));
            legendTitle.textContent = t('world.legend.title', 'Parcel data');
            legendList.textContent = '';
            ['live', 'source', 'none', 'unknown'].forEach(tier => {
                const li = el('li', 'world-legend__item');
                li.append(el('span', 'world-tier-dot world-tier-dot--' + tier), el('span', '', { text: t('world.tier.' + tier + '.short', { live: 'In the app', source: 'Open data found', none: 'No open data', unknown: 'Not researched' }[tier]) }));
                legendList.appendChild(li);
            });
            if (selected) renderPopup();
        }

        // ---- camera state & interaction ----
        const initial = opts.initialView || {};
        const cam = {
            lat: Number.isFinite(initial.lat) ? initial.lat : 28,
            lon: Number.isFinite(initial.lon) ? initial.lon : 12,
            altitudeKm: Number.isFinite(initial.altitudeKm) ? initial.altitudeKm : 0 // 0 = fit on first resize
        };
        const vel = { lat: 0, lon: 0 };
        let lastInteraction = -Infinity;
        let flight = null;
        let selected = null;
        let dirty = true;
        let raf = 0;
        let lastFrame = performance.now();
        let viewport = { w: 1, h: 1 };
        let closed = false;

        function fitAltitude() {
            const vf = FOV * Math.PI / 180;
            const hf = 2 * Math.atan(Math.tan(vf / 2) * (viewport.w / viewport.h));
            // Portrait phones: let the globe nearly touch the sides, it is width-limited there.
            const angular = Math.min(vf, hf) / 2 * (viewport.w / viewport.h < 0.8 ? 0.94 : 0.72);
            return (1 / Math.sin(angular) - 1) * R_KM;
        }

        function resize() {
            const w = Math.max(1, root.clientWidth); const h = Math.max(1, root.clientHeight);
            viewport = { w, h };
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            // Nudge the globe below the search box: shift the view centre down a little.
            camera.setViewOffset(w, h, 0, -Math.round(Math.min(48, h * 0.045)), w, h);
            camera.updateProjectionMatrix();
            if (!cam.altitudeKm) cam.altitudeKm = fitAltitude();
            dirty = true;
        }

        function placeCamera() {
            cam.lat = GM.clamp(cam.lat, -80, 80);
            cam.lon = GM.wrapLon(cam.lon);
            const d = 1 + cam.altitudeKm / R_KM;
            const p = GM.latLonToVector(cam.lat, cam.lon, d);
            camera.position.set(p[0], p[1], p[2]);
            camera.up.set(0, 1, 0);
            camera.lookAt(0, 0, 0);
            const altUnits = cam.altitudeKm / R_KM;
            camera.near = Math.max(0.0002, altUnits * 0.25);
            camera.far = d + 150;
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld();
        }

        function degPerPx() {
            const altUnits = cam.altitudeKm / R_KM;
            const perPx = (2 * Math.tan(FOV * Math.PI / 360) * altUnits) / viewport.h;
            return Math.min(0.5, perPx * 180 / Math.PI);
        }

        const pointers = new Map();
        let drag = null;
        let pinch = null;

        function touch() { lastInteraction = performance.now(); dirty = true; }

        function onPointerDown(ev) {
            if (flight) return;
            renderer.domElement.setPointerCapture(ev.pointerId);
            pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            vel.lat = vel.lon = 0;
            touch();
            if (pointers.size === 1) {
                drag = { x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, t0: performance.now(), moved: 0, samples: [] };
            } else if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), alt: cam.altitudeKm };
                drag = null;
            }
        }

        function onPointerMove(ev) {
            if (!pointers.has(ev.pointerId)) return;
            pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            touch();
            if (pinch && pointers.size >= 2) {
                const [a, b] = [...pointers.values()];
                const dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
                cam.altitudeKm = GM.clamp(pinch.alt * (pinch.dist / dist), MIN_USER_ALT_KM, MAX_ALT_KM);
                return;
            }
            if (!drag) return;
            const dx = ev.clientX - drag.x; const dy = ev.clientY - drag.y;
            drag.x = ev.clientX; drag.y = ev.clientY;
            drag.moved = Math.max(drag.moved, Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0));
            const k = degPerPx();
            const dLon = -dx * k / Math.max(0.2, Math.cos(cam.lat * Math.PI / 180));
            const dLat = dy * k;
            cam.lon += dLon; cam.lat += dLat;
            const now = performance.now();
            drag.samples.push({ t: now, dLon, dLat });
            while (drag.samples.length && now - drag.samples[0].t > 90) drag.samples.shift();
        }

        function onPointerUp(ev) {
            if (!pointers.has(ev.pointerId)) return;
            pointers.delete(ev.pointerId);
            touch();
            if (pinch) { if (pointers.size < 2) pinch = null; drag = null; return; }
            if (!drag) return;
            const elapsed = performance.now() - drag.t0;
            if (drag.moved <= TAP_MAX_PX && elapsed <= TAP_MAX_MS) {
                pickAt(ev.clientX, ev.clientY);
            } else if (drag.samples.length > 1) {
                const span = Math.max(16, drag.samples[drag.samples.length - 1].t - drag.samples[0].t);
                const sum = drag.samples.reduce((acc, s) => ({ lon: acc.lon + s.dLon, lat: acc.lat + s.dLat }), { lon: 0, lat: 0 });
                if (!reduce) { vel.lon = GM.clamp((sum.lon / span) * 1000, -150, 150); vel.lat = GM.clamp((sum.lat / span) * 1000, -90, 90); }
            }
            drag = null;
        }

        function onWheel(ev) {
            if (flight) return;
            ev.preventDefault();
            const delta = ev.deltaMode === 1 ? ev.deltaY * 30 : ev.deltaY;
            cam.altitudeKm = GM.clamp(cam.altitudeKm * Math.exp(delta * 0.0014), MIN_USER_ALT_KM, MAX_ALT_KM);
            touch();
        }

        function onCanvasKey(ev) {
            const step = 12 * degPerPx() * 10;
            const moves = { ArrowLeft: [0, -step], ArrowRight: [0, step], ArrowUp: [step, 0], ArrowDown: [-step, 0] };
            if (moves[ev.key]) { cam.lat += moves[ev.key][0]; cam.lon += moves[ev.key][1]; touch(); ev.preventDefault(); }
            else if (ev.key === '+' || ev.key === '=') { cam.altitudeKm = GM.clamp(cam.altitudeKm / 1.3, MIN_USER_ALT_KM, MAX_ALT_KM); touch(); }
            else if (ev.key === '-' || ev.key === '_') { cam.altitudeKm = GM.clamp(cam.altitudeKm * 1.3, MIN_USER_ALT_KM, MAX_ALT_KM); touch(); }
        }

        function onRootKey(ev) {
            // The globe is modal: no key pressed in it reaches the map's document-level handlers
            // (/, Ctrl-K, the T/O/P/C hotkeys, multi-select and panel Escape chains) underneath.
            ev.stopPropagation();
            if (ev.key !== 'Escape') return;
            if (!results.hidden) return; // search handles its own Escape
            if (selected) { deselect(); return; }
            if (opts.closable !== false) {
                ev.preventDefault();
                global.WorldView.close();
                if (typeof opts.onClose === 'function') opts.onClose();
            }
        }

        // Screen position of a unit-sphere point, or null when it is behind the globe.
        const tmp = new THREE.Vector3();
        function screenOf(vec) {
            tmp.set(vec[0], vec[1], vec[2]);
            const toCam = camera.position.clone().sub(tmp);
            if (toCam.dot(tmp) <= 0) return null;
            tmp.project(camera);
            return { x: (tmp.x + 1) / 2 * viewport.w, y: (1 - tmp.y) / 2 * viewport.h };
        }

        function pickAt(clientX, clientY) {
            const rect = renderer.domElement.getBoundingClientRect();
            const x = clientX - rect.left; const y = clientY - rect.top;
            // Snap to a nearby city dot first: at globe scale a dot is hundreds of km wide.
            let snap = null; let best = Infinity;
            coverage.liveCities.forEach(c => {
                const s = screenOf(GM.latLonToVector(c.lat, c.lon, 1.002)); if (!s) return;
                const d = Math.hypot(s.x - x, s.y - y); if (d < 14 && d < best) { best = d; snap = c; }
            });
            if (!snap) coverage.cities.forEach(c => {
                const s = screenOf(GM.latLonToVector(c.lat, c.lon, 1.002)); if (!s) return;
                const d = Math.hypot(s.x - x, s.y - y); if (d < 8 && d < best) { best = d; snap = c; }
            });
            if (snap) { select(coverage.tierAt(snap.lat, snap.lon)); return; }
            const ndc = new THREE.Vector3((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1, 0.5).unproject(camera);
            const dir = ndc.sub(camera.position);
            const hit = GM.raySphere(camera.position.toArray(), dir.toArray(), 1);
            if (!hit) { deselect(); return; }
            const ll = GM.vectorToLatLon(hit);
            select(coverage.tierAt(ll.lat, ll.lon));
        }

        // ---- popup ----
        function select(place) {
            selected = place;
            requestState = null;
            vel.lat = vel.lon = 0;
            renderPopup();
            dirty = true;
        }

        function deselect() {
            selected = null;
            popup.hidden = true; pin.hidden = true;
            dirty = true;
        }

        let requestState = null; // null | 'sending' | 'done' | 'error'

        function renderPopup() {
            if (!selected) return;
            const place = selected;
            const tier = place.tier;
            popup.textContent = '';
            popup.className = 'world-popup world-popup--' + tier;
            const close = el('button', 'world-popup__close', { type: 'button', 'aria-label': t('world.close', 'Close'), text: '×' });
            close.addEventListener('click', deselect);
            const badge = el('p', 'world-popup__tier');
            badge.append(el('span', 'world-tier-dot world-tier-dot--' + tier), el('span', '', { text: t('world.tier.' + tier + '.short', { live: 'In the app', source: 'Open data found', none: 'No open data', unknown: 'Not researched' }[tier]) }));
            const heading = place.kind === 'ocean' ? t('world.popup.ocean', 'Open water') : place.name;
            const titleNode = el('h2', 'world-popup__title', { text: heading });
            const subtitleParts = [];
            if (place.kind !== 'country' && place.country) subtitleParts.push(place.country);
            subtitleParts.push(formatLatLon(place.lat, place.lon));
            const subtitle = el('p', 'world-popup__subtitle', { text: subtitleParts.join(' · ') });
            const texts = {
                live: 'Parcels, proposals and 3D are ready here.',
                source: 'Open parcel data exists here, but it is not in the app yet. Explore the map without parcels, or ask for this place to be added.',
                none: 'We looked and found no open parcel data here. You can still explore the map, without parcels.',
                unknown: 'Nobody has checked this place for open parcel data yet. You can still explore the map, without parcels.'
            };
            const text = el('p', 'world-popup__text', {
                text: place.kind === 'ocean'
                    ? t('world.popup.oceanText', 'No land here, so no parcels. You can still open the map at this spot.')
                    : t('world.tier.' + tier + '.text', texts[tier])
            });
            popup.append(close, badge, titleNode, subtitle, text);
            if (place.note && tier !== 'live') popup.appendChild(el('p', 'world-popup__note', { text: place.note }));
            const actions = el('div', 'world-popup__actions');
            const point = { lat: place.lat, lon: place.lon, place };
            const liveCityId = tier === 'live' && place.cityId
                ? (typeof opts.chooseCity === 'function' && opts.chooseCity(place)) || place.cityId
                : null;
            if (liveCityId) {
                const cityLabel = (coverage.liveCities.find(c => c.id === liveCityId) || {}).name || place.name;
                const open = el('button', 'world-btn world-btn--primary', { type: 'button', text: t('world.action.open', 'Open {{city}}', { city: cityLabel }) });
                open.addEventListener('click', () => { if (typeof opts.onOpenCity === 'function') opts.onOpenCity(liveCityId, point); });
                actions.appendChild(open);
            } else {
                const explore = el('button', 'world-btn' + (tier === 'source' ? '' : ' world-btn--primary'), { type: 'button', text: t('world.action.explore', 'Explore anyway') });
                explore.addEventListener('click', () => { if (typeof opts.onExplore === 'function') opts.onExplore(point); });
                if (tier === 'source') {
                    const labels = {
                        sending: t('world.request.sending', 'Sending…'),
                        done: t('world.request.done', 'Request noted, thank you'),
                        error: t('world.request.error', 'Could not send the request. Try again?')
                    };
                    const ask = el('button', 'world-btn world-btn--primary', {
                        type: 'button',
                        text: requestState === 'done' || requestState === 'sending' ? labels[requestState]
                            : place.kind === 'country' ? t('world.action.askArea', 'Ask for this area') : t('world.action.askCity', 'Ask for this city')
                    });
                    if (requestState === 'done' || requestState === 'sending') ask.disabled = true;
                    ask.addEventListener('click', () => {
                        if (typeof opts.onRequestCity !== 'function') return;
                        const current = selected;
                        requestState = 'sending'; renderPopup();
                        Promise.resolve(opts.onRequestCity(place)).then(() => {
                            if (selected === current) { requestState = 'done'; renderPopup(); }
                        }, error => {
                            console.error('[' + new Date().toISOString() + '] [world] city request failed', error);
                            if (selected === current) { requestState = 'error'; renderPopup(); }
                        });
                    });
                    actions.append(ask, explore);
                    if (requestState === 'error') popup.appendChild(el('p', 'world-popup__error', { text: labels.error }));
                } else {
                    actions.appendChild(explore);
                }
            }
            popup.appendChild(actions);
            popup.setAttribute('aria-label', heading);
            popup.hidden = false; pin.hidden = false;
            positionOverlays();
        }

        function positionOverlays() {
            if (selected) {
                const s = screenOf(GM.latLonToVector(selected.lat, selected.lon, 1.001));
                pin.hidden = !s;
                if (s) { pin.style.setProperty('--x', s.x + 'px'); pin.style.setProperty('--y', s.y + 'px'); }
                const sheet = viewport.w <= 600;
                popup.classList.toggle('world-popup--sheet', sheet);
                // Rotated round to the far side: an anchored popup has nothing to point at.
                popup.classList.toggle('world-popup--offscreen', !sheet && !s);
                if (!sheet && s) {
                    const pw = popup.offsetWidth || 300; const ph = popup.offsetHeight || 180;
                    const above = s.y - ph - 22 > 70;
                    const x = GM.clamp(s.x - pw / 2, 12, viewport.w - pw - 12);
                    const y = above ? s.y - ph - 18 : Math.min(viewport.h - ph - 12, s.y + 18);
                    popup.classList.toggle('world-popup--below', !above);
                    popup.style.setProperty('--x', x + 'px'); popup.style.setProperty('--y', y + 'px');
                    popup.style.setProperty('--caret', GM.clamp(s.x - x, 18, pw - 18) + 'px');
                }
            }
            // Live-city labels: nearest-first greedy placement, skipping overlaps and the far side.
            const placed = [];
            const showLabels = true;
            liveLabels.forEach(item => {
                const s = showLabels ? screenOf(item.vec) : null;
                let visible = !!s;
                if (visible) {
                    if (!item.w) { item.w = item.node.offsetWidth || 60; item.h = item.node.offsetHeight || 20; }
                    const box = { x: s.x + 10, y: s.y - item.h / 2, w: item.w, h: item.h };
                    visible = !placed.some(b => box.x < b.x + b.w + 4 && b.x < box.x + box.w + 4 && box.y < b.y + b.h + 2 && b.y < box.y + box.h + 2);
                    if (visible) {
                        placed.push(box);
                        item.node.style.setProperty('--x', box.x + 'px'); item.node.style.setProperty('--y', box.y + 'px');
                    }
                }
                item.node.classList.toggle('world-city-label--hidden', !visible);
            });
        }

        // ---- search ----
        let searchHits = [];
        let activeIndex = -1;

        function renderResults() {
            results.textContent = '';
            searchHits.forEach((place, i) => {
                const li = el('li', 'world-search__result' + (i === activeIndex ? ' world-search__result--active' : ''), {
                    role: 'option', id: 'world-search-opt-' + i, 'aria-selected': i === activeIndex ? 'true' : 'false'
                });
                li.append(el('span', 'world-tier-dot world-tier-dot--' + place.tier));
                const textWrap = el('span', 'world-search__text');
                textWrap.append(el('span', 'world-search__name', { text: place.name }),
                    el('span', 'world-search__meta', { text: place.kind === 'country' ? t('world.search.country', 'Country') : place.country }));
                li.append(textWrap);
                li.addEventListener('pointerdown', ev => ev.preventDefault());
                li.addEventListener('click', () => choose(place));
                results.appendChild(li);
            });
            if (!searchHits.length && searchInput.value.trim()) {
                results.appendChild(el('li', 'world-search__empty', { text: t('world.search.noResults', 'No matching place') }));
            }
            const open = !!searchInput.value.trim();
            results.hidden = !open;
            searchInput.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (activeIndex >= 0) searchInput.setAttribute('aria-activedescendant', 'world-search-opt-' + activeIndex);
            else searchInput.removeAttribute('aria-activedescendant');
        }

        function onSearchInput() {
            searchHits = coverage.searchPlaces(searchInput.value, { limit: 7 });
            activeIndex = searchHits.length ? 0 : -1;
            renderResults();
        }

        function onSearchKey(ev) {
            if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                if (!searchHits.length) return;
                ev.preventDefault();
                activeIndex = (activeIndex + (ev.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length;
                renderResults();
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                if (searchHits[activeIndex]) choose(searchHits[activeIndex]);
            } else if (ev.key === 'Escape') {
                ev.stopPropagation();
                if (searchInput.value) { searchInput.value = ''; onSearchInput(); } else searchInput.blur();
            }
        }

        function choose(place) {
            searchInput.value = place.name;
            searchHits = []; activeIndex = -1;
            results.hidden = true; searchInput.setAttribute('aria-expanded', 'false');
            searchInput.blur();
            deselect();
            const altitudeKm = place.kind === 'country' ? Math.max(11000, Math.min(cam.altitudeKm, 16000)) : 8500;
            const popupPlace = place.kind === 'country' ? Object.assign({}, place) : coverage.tierAt(place.lat, place.lon);
            fly({ lat: place.lat, lon: place.lon, altitudeKm }, { hop: 0.6 }).then(() => select(popupPlace));
        }

        // ---- flights ----
        function fly(target, options) {
            vel.lat = vel.lon = 0;
            const from = { lat: cam.lat, lon: cam.lon, altitudeKm: cam.altitudeKm };
            const to = { lat: GM.clamp(target.lat, -80, 80), lon: target.lon, altitudeKm: target.altitudeKm };
            return new Promise(resolve => {
                if (flight) flight.resolve(false);
                if (reduce) {
                    Object.assign(cam, to); flight = null; dirty = true; render(performance.now());
                    resolve(true); return;
                }
                const arc = GM.angularDistance(from, to);
                const dive = Math.abs(Math.log(Math.max(1, to.altitudeKm) / Math.max(1, from.altitudeKm)));
                const duration = options && options.durationMs
                    ? options.durationMs : GM.clamp(900 + 700 * (arc / Math.PI) + 220 * dive, 1500, 2500);
                flight = { from, to, start: performance.now(), duration, hop: options && typeof options.hop === 'number' ? options.hop : 1, resolve };
                touch();
            });
        }

        function stepFlight(now) {
            if (!flight) return;
            const tNorm = Math.min(1, (now - flight.start) / flight.duration);
            Object.assign(cam, GM.flyInterpolate(flight.from, flight.to, tNorm, { hop: flight.hop }));
            dirty = true;
            if (tNorm >= 1) { const done = flight.resolve; flight = null; done(true); }
        }

        // ---- loop ----
        function render(now) {
            placeCamera();
            time.value = now / 1000;
            const h = GM.clamp((1400 - cam.altitudeKm) / (1400 - 250), 0, 1);
            earthMat.uniforms.haze.value = 0.88 * h * h * (3 - 2 * h);
            renderer.render(scene, camera);
            positionOverlays();
            dirty = false;
        }

        function frame(now) {
            raf = 0;
            if (closed) return;
            const dt = Math.min(0.1, (now - lastFrame) / 1000);
            lastFrame = now;
            let moving = false;
            if (flight) { stepFlight(now); moving = true; }
            else {
                if (Math.abs(vel.lon) > 0.01 || Math.abs(vel.lat) > 0.01) {
                    cam.lon += vel.lon * dt; cam.lat += vel.lat * dt;
                    const decay = Math.exp(-dt * 2.6);
                    vel.lon *= decay; vel.lat *= decay;
                    moving = true;
                } else if (!reduce && !drag && !pinch && !selected && !root.classList.contains('world-view--diving') && now - lastInteraction > IDLE_DELAY_MS) {
                    cam.lon += IDLE_SPIN_DEG_PER_S * dt * Math.min(1, (now - lastInteraction - IDLE_DELAY_MS) / 1500);
                    moving = true;
                }
            }
            // Live dots pulse, so keep drawing unless motion is reduced.
            if (moving || dirty || !reduce) render(now);
            schedule();
        }

        function schedule() {
            if (!raf && !closed && !document.hidden) raf = requestAnimationFrame(frame);
        }

        function onVisibility() {
            if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; }
            else { lastFrame = performance.now(); dirty = true; schedule(); }
        }

        const resizeObserver = new ResizeObserver(() => { resize(); if (!raf) render(performance.now()); });

        // ---- wiring ----
        const canvas = renderer.domElement;
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('keydown', onCanvasKey);
        root.addEventListener('keydown', onRootKey);
        searchInput.addEventListener('input', onSearchInput);
        searchInput.addEventListener('keydown', onSearchKey);
        searchInput.addEventListener('blur', () => { results.hidden = true; searchInput.setAttribute('aria-expanded', 'false'); });
        searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) onSearchInput(); });
        closeBtn.addEventListener('click', () => { global.WorldView.close(); if (typeof opts.onClose === 'function') opts.onClose(); });
        document.addEventListener('visibilitychange', onVisibility);
        const onLanguage = () => renderStaticText();
        if (global.i18n && typeof global.i18n.onChange === 'function') global.i18n.onChange(onLanguage);
        global.addEventListener('i18n:translationsLoaded', onLanguage);

        document.body.appendChild(root);
        document.body.classList.add('world-view-open');
        renderStaticText();
        resizeObserver.observe(root);
        resize();
        render(performance.now());
        schedule();

        const api = {
            root,
            close() {
                if (closed) return;
                closed = true;
                if (raf) cancelAnimationFrame(raf);
                if (flight) { flight.resolve(false); flight = null; }
                resizeObserver.disconnect();
                document.removeEventListener('visibilitychange', onVisibility);
                if (global.i18n && typeof global.i18n.offChange === 'function') global.i18n.offChange(onLanguage);
                global.removeEventListener('i18n:translationsLoaded', onLanguage);
                disposables.forEach(d => d.dispose());
                renderer.dispose();
                renderer.forceContextLoss();
                root.remove();
                document.body.classList.remove('world-view-open');
                log('closed; GPU resources released');
            },
            flyTo(point, options) {
                const o = options || {};
                deselect();
                root.classList.add('world-view--diving');
                const altitudeKm = Number.isFinite(o.altitudeKm) ? o.altitudeKm : 120;
                return fly({ lat: point.lat, lon: point.lon, altitudeKm }, { hop: 0.5, durationMs: o.durationMs }).then(completed => {
                    if (!completed) return null;
                    const state = {
                        lat: cam.lat, lon: cam.lon, altitudeKm: cam.altitudeKm,
                        leafletZoom: GM.altitudeToLeafletZoom(cam.altitudeKm, cam.lat, viewport.h, FOV)
                    };
                    render(performance.now());
                    if (typeof o.onDone === 'function') o.onDone(state);
                    return state;
                });
            },
            captureHandoffFrame(options) {
                const o = options || {};
                const maxWidth = o.maxWidth || 960;
                render(performance.now()); // same task as the copy: the drawing buffer is still intact
                const scale = Math.min(1, maxWidth / canvas.width);
                const out = document.createElement('canvas');
                out.width = Math.round(canvas.width * scale); out.height = Math.round(canvas.height * scale);
                const g = out.getContext('2d');
                // The page background is CSS; paint the same space gradient under the transparent canvas.
                const bg = g.createRadialGradient(out.width / 2, out.height / 2, 0, out.width / 2, out.height / 2, Math.max(out.width, out.height) * 0.75);
                bg.addColorStop(0, '#0d1d44'); bg.addColorStop(1, '#030712');
                g.fillStyle = bg; g.fillRect(0, 0, out.width, out.height);
                g.drawImage(canvas, 0, 0, out.width, out.height);
                return out.toDataURL('image/jpeg', o.quality || 0.82);
            },
            getCamera() { return { lat: cam.lat, lon: cam.lon, altitudeKm: cam.altitudeKm }; },
            project(lat, lon) { placeCamera(); return screenOf(GM.latLonToVector(lat, lon, 1.001)); },
            selectPlace(lat, lon) {
                const place = coverage.tierAt(lat, lon);
                return fly({ lat, lon, altitudeKm: cam.altitudeKm }, { hop: 0.3 }).then(() => select(place));
            }
        };
        return api;
    }

    const WorldView = {
        TIER_COLORS,
        async open(opts) {
            if (view) return;
            const options = opts || {};
            const ok = await global.whenThreeReady();
            if (!ok || !global.THREE) throw new Error('WorldView: three.js failed to load');
            if (!coveragePromise) coveragePromise = global.WorldCoverage.load(options.coverageUrl);
            let coverage;
            try { coverage = await coveragePromise; } catch (error) { coveragePromise = null; throw error; }
            if (view) return;
            view = createView(global.THREE, coverage, options);
            WorldView.coverage = coverage;
            // Take focus like a dialog does, so Escape and the arrow keys reach the globe at once
            // (focus was on whatever opened it, now covered: the city chip, a Settings button).
            const canvas = view.root.querySelector('.world-view__canvas');
            if (canvas) canvas.focus({ preventScroll: true });
            log('opened');
        },
        close() { if (view) { const v = view; view = null; v.close(); } },
        isOpen() { return !!view; },
        flyTo(point, options) { if (!view) return Promise.reject(new Error('WorldView is not open')); return view.flyTo(point, options); },
        captureHandoffFrame(options) { if (!view) throw new Error('WorldView is not open'); return view.captureHandoffFrame(options); },
        getCamera() { return view ? view.getCamera() : null; },
        // Viewport pixel position of a lat/lon, or null when it is on the far side (tests, tours).
        project(lat, lon) { return view ? view.project(lat, lon) : null; },
        selectPlace(lat, lon) { return view ? view.selectPlace(lat, lon) : Promise.resolve(); }
    };

    global.WorldView = WorldView;
})(window);
