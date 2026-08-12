// Draws the tile-by-tile coverage survey produced by backend/scripts/topology-coverage.js.
//
// Deliberately reads a precomputed file rather than calling the API: surveying the city means
// building a graph for every tile, which takes minutes. The page is a picture of a survey, and the
// note in the panel says how to take a fresh one.
(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    const source = params.get('data') || 'coverage.json';

    const map = L.map('map', { preferCanvas: true }).setView([45.808, 15.978], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    function element(id) {
        return document.getElementById(id);
    }

    // Green through amber to red as the settled share falls. Kept away from a rainbow: the reader
    // only ever asks "is this nearly done", which is one ordered question.
    function shade(done) {
        if (done >= 1) return '#2f7d4f';
        if (done >= 0.9) return '#6f9a3a';
        if (done >= 0.75) return '#c98a1e';
        if (done >= 0.5) return '#d1642a';
        return '#b23a2c';
    }

    function totalsMarkup(totals, tiles) {
        const settledPct = totals.junctions
            ? Math.round(100 * totals.settled / totals.junctions)
            : 0;
        const finished = tiles.filter(tile => !tile.open).length;
        return [
            [totals.junctions.toLocaleString('en'), 'junctions'],
            [`${settledPct}%`, 'settled by the rules'],
            [totals.movements.toLocaleString('en'), 'decisions left'],
            [`${finished}/${tiles.length}`, 'tiles finished']
        ].map(([figure, label]) => `<div><span class="figure">${figure}</span><span>${label}</span></div>`).join('');
    }

    function tileLabel(tile) {
        return tile.open
            ? `${tile.movements} decisions · ${tile.open} of ${tile.junctions} junctions open`
            : `all ${tile.junctions} junctions settled`;
    }

    fetch(source, { cache: 'no-store' })
        .then(response => {
            if (!response.ok) throw new Error(`${source} → HTTP ${response.status}`);
            return response.json();
        })
        .then(survey => {
            const tiles = survey.tiles || [];
            if (!tiles.length) throw new Error('the survey has no tiles with roads in it');
            element('totals').innerHTML = totalsMarkup(survey.totals, tiles);

            const bounds = [];
            tiles.forEach(tile => {
                const [west, south, east, north] = tile.core;
                const rectangle = L.rectangle([[south, west], [north, east]], {
                    color: shade(tile.done),
                    weight: 1,
                    opacity: .55,
                    fillOpacity: tile.open ? .28 : .42
                }).addTo(map);
                rectangle.bindTooltip(tileLabel(tile), { sticky: true });
                rectangle.on('click', () => window.open(tile.url, '_blank', 'noopener'));
                bounds.push([south, west], [north, east]);
            });
            map.fitBounds(bounds, { padding: [20, 20], animate: false });

            const nearly = tiles
                .filter(tile => tile.open > 0 && tile.junctions >= 8)
                .sort((a, b) => a.movements - b.movements)
                .slice(0, 12);
            element('nearly').innerHTML = nearly.map(tile => (
                `<li><a href="${tile.url}" target="_blank" rel="noopener"><b>${tile.movements}</b> `
                + `decisions · ${Math.round(100 * tile.done)}% settled</a></li>`
            )).join('');
        })
        .catch(error => {
            element('error').textContent = `Could not load the survey: ${error.message}`;
        });
})();
