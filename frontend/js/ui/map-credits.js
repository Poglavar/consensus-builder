// Compact provider attribution on the map (the basemap licences require it), with the city's data
// and software credits under Settings → Information → "Sources & software", including the parcel
// source that last answered for the map in view.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MapCredits = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';
    const software = [
        ['Leaflet', 'https://leafletjs.com/'],
        ['Three.js', 'https://threejs.org/'],
        ['3D Tiles Renderer', 'https://github.com/NASA-AMMOS/3DTilesRendererJS'],
        ['Proj4js', 'https://proj4js.org/'],
        ['Turf', 'https://turfjs.org/'],
        ['Font Awesome Free', 'https://fontawesome.com/license/free'],
        ['pako', 'https://github.com/nodeca/pako'],
        ['leaflet-image', 'https://github.com/mapbox/leaflet-image'],
        ['ethers', 'https://docs.ethers.org/'],
        ['Solana web3.js', 'https://github.com/solana-foundation/solana-web3.js']
    ];
    const providers = {
        openstreetmap: [['© OpenStreetMap', 'https://www.openstreetmap.org/copyright']],
        maptiler: [['© MapTiler', 'https://www.maptiler.com/copyright/'],
            ['© OpenStreetMap', 'https://www.openstreetmap.org/copyright']]
    };
    function textOnly(value) {
        const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ', copy: '©' };
        return String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|#39|nbsp|copy);/gi,
                (_, name) => entities[name.toLowerCase()]).trim();
    }
    function safeUrl(value) {
        try {
            const url = new URL(value);
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
        } catch (_) { return null; }
    }
    // Retain source links without allowing publisher HTML, event handlers or embedded content.
    function creditParts(html) {
        const source = String(html || '');
        const parts = [];
        const links = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let end = 0;
        for (const match of source.matchAll(links)) {
            if (match.index > end) parts.push({ text: textOnly(source.slice(end, match.index)) });
            parts.push({ text: textOnly(match[2]), url: safeUrl(textOnly(match[1])) });
            end = match.index + match[0].length;
        }
        if (end < source.length) parts.push({ text: textOnly(source.slice(end)) });
        return parts.filter(part => part.text);
    }
    function parcelCredits(city) {
        const parcels = city?.parcels || {};
        return [...new Set([parcels.attribution, parcels.raster?.attribution].filter(Boolean))];
    }
    function providerCredits(key) { return providers[key] || providers.openstreetmap; }
    // The source behind the parcels in view as display lines ({ text, label?, url?, html?, strong? }),
    // built without the DOM. latest comes from ParcelSourceInView; info is the catalog's public
    // description of a browser source; credits are the configured city's attribution, used for
    // server-side sources that the browser catalog does not describe.
    function inViewLines({ latest, info = null, credits = [], recordCityLabel = null, time = '', tr }) {
        if (!latest) return null;
        const lines = [];
        if (latest.sourceKey === 'ground-custom-url') {
            lines.push({ text: tr('customFile', 'Your parcel file from {{host}}', { host: latest.detail?.host || '?' }), strong: true });
        } else if (latest.sourceKey.startsWith('ground-')) {
            lines.push({ text: tr('generated', 'Generated parcels: no parcel register is used here.'), strong: true });
        } else if (info) {
            lines.push({ text: info.name, strong: true });
            if (info.attribution && info.attribution !== info.name) lines.push({ text: info.attribution });
            if (info.host) lines.push({ text: info.viaRelay
                ? tr('viaRelay', "Read from {{host}} through this site's server", { host: info.host })
                : tr('direct', 'Read by your browser directly from {{host}}', { host: info.host }) });
            if (info.scope) lines.push({ label: tr('coverage', 'Area covered'), text: info.scope });
            if (info.licenceNote) lines.push({ label: tr('terms', 'Terms'), text: info.licenceNote });
            if (info.catalogueUrl) lines.push({ text: tr('sourcePage', 'Source page'), url: info.catalogueUrl });
            if (info.licenceUrl && info.licenceUrl !== info.catalogueUrl) lines.push({ text: tr('licence', 'Licence'), url: info.licenceUrl });
        } else {
            credits.forEach(html => lines.push({ html }));
            if (!credits.length) lines.push({ text: latest.sourceKey, strong: true });
        }
        lines.push({ text: recordCityLabel
            ? tr('loadedAtCity', 'Last loaded at {{time}} for {{city}}', { time, city: recordCityLabel })
            : tr('loadedAt', 'Last loaded at {{time}}', { time }) });
        return lines;
    }
    function install(map) {
        const doc = root.document;
        const target = doc.getElementById('map-credits-details');
        const tr = (key, fallback, params) => {
            const translated = root.i18n?.t?.('mapCredits.' + key, params);
            return translated && translated !== 'mapCredits.' + key ? translated : fallback;
        };
        // Every credit leaves the app: cb-link cb-link--external (css/primitives.css); the on-map
        // line adds --quiet so it keeps the haloed text colour around it.
        const makeLink = (text, url, quiet = false) => {
            const link = doc.createElement('a');
            link.className = 'cb-link cb-link--external' + (quiet ? ' cb-link--quiet' : '');
            link.textContent = text;
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            return link;
        };
        function appendCredit(parent, html) {
            creditParts(html).forEach((part, index) => {
                if (index) parent.appendChild(doc.createTextNode(' '));
                parent.appendChild(part.url ? makeLink(part.text, part.url) : doc.createTextNode(part.text));
            });
        }
        let renderGeneration = 0;
        // Fills "Parcels in view" from the last source that answered; a browser source's catalog
        // details come from the parcel worker's bundled catalog, never from this site's server.
        function renderInView(latest, city) {
            const title = doc.createElement('dt');
            title.textContent = tr('inView', 'Parcels in view');
            const body = doc.createElement('dd');
            body.className = 'map-credits-in-view';
            target.append(title, body);
            const generation = renderGeneration;
            const manager = root.CityConfigManager;
            const recordCity = latest.cityId && latest.cityId !== manager.getCurrentCityId?.()
                ? manager.getCityConfig?.(latest.cityId)?.label || latest.cityId : null;
            const time = new Date(latest.at).toLocaleTimeString(root.i18n?.getLanguage?.() || undefined, { hour: '2-digit', minute: '2-digit' });
            const fill = info => {
                if (generation !== renderGeneration) return;
                body.replaceChildren();
                const recordConfig = latest.cityId ? manager.getCityConfig?.(latest.cityId) : null;
                inViewLines({ latest, info, credits: parcelCredits(recordConfig || city), recordCityLabel: recordCity, time, tr })
                    .forEach(line => {
                        const block = doc.createElement('div');
                        if (line.label) { const label = doc.createElement('span'); label.className = 'map-credits-in-view__label'; label.textContent = line.label + ': '; block.append(label); }
                        if (line.html) appendCredit(block, line.html);
                        else if (line.url) block.append(makeLink(line.text, line.url));
                        else if (line.strong) { const strong = doc.createElement('strong'); strong.textContent = line.text; block.append(strong); }
                        else block.append(doc.createTextNode(line.text));
                        body.append(block);
                    });
            };
            fill(null);
            if (latest.browserSource && root.BrowserParcelSources?.describe) {
                root.BrowserParcelSources.describe(latest.sourceKey, { city: latest.cityId }).then(fill, () => { /* The configured attribution stays. */ });
            }
        }
        function renderDetails() {
            if (!target) return;
            renderGeneration += 1;
            target.replaceChildren();
            const city = root.CityConfigManager.getCurrentCityConfig();
            const basemap = root.BasemapManager.getCurrentBasemapKey();
            function row(label, credits) {
                const title = doc.createElement('dt');
                title.textContent = label;
                const body = doc.createElement('dd');
                credits.forEach((html, index) => {
                    if (index) body.appendChild(doc.createElement('br'));
                    appendCredit(body, html);
                });
                target.append(title, body);
            }
            row(tr('basemap', 'Map'), [root.BasemapManager.BASEMAPS[basemap].options.attribution]);
            const latest = root.ParcelSourceInView?.latest?.();
            if (latest) renderInView(latest, city);
            else {
                const credits = parcelCredits(city);
                row(tr('parcel', 'Parcel source for ' + city.label, { city: city.label }),
                    credits.length ? credits : [tr('none', 'No parcel source configured for this city.')]);
            }
            const buildings = doc.querySelector('.three-mode-source-note:not([hidden])');
            if (buildings?.textContent) row(tr('buildings', '3D buildings'), [buildings.textContent]);
            const photo = doc.querySelector('.photoreal-attribution.visible');
            if (photo) row(tr('photo', 'Photo view'), [photo.textContent || 'Google']);
            row(tr('software', 'Open-source software'), []);
            const softwareList = target.lastElementChild;
            softwareList.className = 'map-credits-software';
            software.forEach(([name, url]) => softwareList.appendChild(makeLink(name, url)));
        }
        const control = root.L.control({ position: 'bottomleft' });
        let container;
        function renderControl() {
            if (!container) return;
            container.replaceChildren();
            providerCredits(root.BasemapManager.getCurrentBasemapKey()).forEach(([name, url]) => {
                container.appendChild(makeLink(name, url, true));
            });
            renderDetails();
        }
        control.onAdd = () => {
            container = root.L.DomUtil.create('div', 'map-credits-control');
            root.L.DomEvent.disableClickPropagation(container);
            root.L.DomEvent.disableScrollPropagation(container);
            renderControl();
            return container;
        };
        control.addTo(map);
        map.on('basemapchange', renderControl);
        root.i18n?.onChange(renderControl);
        // The details render when Settings opens (the map control carries only the basemap credit).
        doc.addEventListener('mapshell:sheetopened', event => {
            if (event.detail?.id === 'settings-sheet') renderDetails();
        });
        // A pan into another source's city updates an open Settings sheet too.
        root.ParcelSourceInView?.subscribe?.(() => renderDetails());
        return { refresh: renderControl };
    }
    return Object.freeze({ install, creditParts, parcelCredits, providerCredits, inViewLines });
});
