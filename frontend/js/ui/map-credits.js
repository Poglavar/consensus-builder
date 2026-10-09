// Compact provider attribution on the map, with city data and software credits in Information.
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
    function install(map) {
        const doc = root.document;
        const target = doc.getElementById('map-credits-details');
        const tr = (key, fallback, params) => {
            const translated = root.i18n?.t?.('mapCredits.' + key, params);
            return translated && translated !== 'mapCredits.' + key ? translated : fallback;
        };
        const makeLink = (text, url) => {
            const link = doc.createElement('a');
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
        function renderDetails() {
            if (!target) return;
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
            const credits = parcelCredits(city);
            row(tr('parcel', 'Parcel source for ' + city.label, { city: city.label }),
                credits.length ? credits : [tr('none', 'No parcel source configured for this city.')]);
            const buildings = doc.querySelector('.three-mode-source-note:not([hidden])');
            if (buildings?.textContent) row(tr('buildings', '3D buildings'), [buildings.textContent]);
            const photo = doc.querySelector('.photoreal-attribution.visible');
            if (photo) row(tr('photo', 'Photo view'), [photo.textContent || 'Google']);
            row(tr('software', 'Open-source software'), []);
            const softwareList = target.lastElementChild;
            softwareList.className = 'map-credits-software';
            software.forEach(([name, url]) => softwareList.appendChild(makeLink(name, url)));
        }
        function open(event) {
            event?.preventDefault();
            renderDetails();
            root.MapShell.revealSection('info');
            const heading = doc.getElementById('map-credits-title');
            heading.scrollIntoView({ block: 'start' });
            heading.focus({ preventScroll: true });
        }
        const control = root.L.control({ position: 'bottomright' });
        let container;
        function renderControl() {
            if (!container) return;
            container.replaceChildren();
            providerCredits(root.BasemapManager.getCurrentBasemapKey()).forEach(([name, url]) => {
                container.appendChild(makeLink(name, url));
            });
            const sourceLink = doc.createElement('a');
            sourceLink.href = '#map-credits-title';
            sourceLink.textContent = tr('open', 'Sources');
            sourceLink.setAttribute('aria-label', tr('title', 'Sources & software'));
            sourceLink.addEventListener('click', open);
            container.appendChild(sourceLink);
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
        // Settings can be opened without the map's Sources link (including in 3D).
        doc.addEventListener('mapshell:sheetopened', event => {
            if (event.detail?.id === 'settings-sheet') renderDetails();
        });
        return { open, refresh: renderControl };
    }
    return Object.freeze({ install, creditParts, parcelCredits, providerCredits });
});
