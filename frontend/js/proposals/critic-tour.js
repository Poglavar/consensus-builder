// Plays evidence from the assessment on the map. It never changes the assessment or the plan.
(function (win) {
    'use strict';
    const doc = win.document;
    const reducedMotion = () => win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = (key, params) => win.i18n.t(`criticTour.${key}`, params);
    const latLng = ([lon, lat]) => win.L.latLng(lat, lon);

    function pane() {
        const name = 'criticTourPane';
        if (!win.map.getPane(name)) win.map.createPane(name).classList.add('critic-tour-pane');
        return name;
    }

    function sample(items, limit = 5) {
        if (items.length <= limit) return items;
        return Array.from({ length: limit }, (_, i) => items[Math.round(i * (items.length - 1) / (limit - 1))]);
    }

    function move(duration, signal, draw) {
        if (signal.aborted) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let frame, start;
            const stop = () => finish();
            function finish(error) {
                win.cancelAnimationFrame(frame);
                signal.removeEventListener('abort', stop);
                if (error) reject(error);
                else resolve();
            }
            function tick(now) {
                start ??= now;
                const portion = Math.min(1, (now - start) / duration);
                try { draw(portion); }
                catch (error) { finish(error); return; }
                if (portion < 1) frame = win.requestAnimationFrame(tick);
                else finish();
            }
            signal.addEventListener('abort', stop, { once: true });
            frame = win.requestAnimationFrame(tick);
        });
    }

    function trace(marker, line, points, portion) {
        const distance = points.at(-1).distance;
        let index = 1;
        while (index < points.length - 1 && points[index].distance < distance * portion) index++;
        const from = points[index - 1], to = points[index];
        const length = to.distance - from.distance;
        const ratio = length > 0 ? (distance * portion - from.distance) / length : 0;
        const position = win.L.latLng(from.point.lat + (to.point.lat - from.point.lat) * ratio,
            from.point.lng + (to.point.lng - from.point.lng) * ratio);
        marker.setLatLng(position);
        line.setLatLngs([...points.slice(0, index).map(item => item.point), position]);
    }

    function routePoints(coordinates = []) {
        let distance = 0, previous;
        return coordinates.map(latLng).map(point => {
            if (previous) distance += point.distanceTo(previous);
            previous = point;
            return { point, distance };
        });
    }

    async function play({ id, portrait, steps, panel, status, close, signal, frame }) {
        const visible = steps.filter(step => step.geometry || step.coordinates?.length);
        if (reducedMotion() || !visible.length || signal.aborted) return;
        const local = new AbortController();
        const stop = () => local.abort();
        signal.addEventListener('abort', stop, { once: true });
        const skip = doc.createElement('button');
        skip.type = 'button';
        skip.className = 'btn btn-sm critic-tour-skip';
        skip.textContent = t('skip');
        skip.addEventListener('click', stop);
        status.after(skip);
        status.hidden = false;
        status.classList.remove('sr-only');
        panel.setAttribute('data-critic-tour', id);
        let overlay;
        try {
            const bounds = win.L.latLngBounds([]);
            for (const step of visible) {
                for (const point of step.coordinates || []) bounds.extend(latLng(point));
                if (step.geometry) bounds.extend(win.L.geoJSON(step.geometry).getBounds());
            }
            overlay = win.L.layerGroup().addTo(win.map);
            const layerPane = pane();
            let current;
            for (const [index, step] of visible.entries()) {
                if (local.signal.aborted) break;
                status.textContent = t('progress', { current: index + 1, total: visible.length, label: step.label });
                if (index === 0) frame?.(bounds);
                current?.remove();
                current = win.L.layerGroup().addTo(overlay);
                const points = routePoints(step.coordinates);
                const spotlight = step.geometry && win.L.geoJSON(step.geometry, { interactive: false, pane: layerPane,
                    style: { color: step.color || '#6535ad', fillOpacity: .28, weight: 4, className: 'critic-tour-spotlight' } }).addTo(current);
                const position = points[0]?.point || spotlight?.getBounds().getCenter();
                if (!position) continue;
                const animal = doc.createElement('img');
                animal.src = portrait;
                animal.alt = '';
                const marker = win.L.marker(position, { interactive: false, alt: '', keyboard: false, pane: layerPane, zIndexOffset: 500,
                    icon: win.L.divIcon({ html: animal, className: `critic-tour-marker critic-tour-marker--${id}`,
                        iconSize: [34, 34], iconAnchor: [17, 22] }) }).addTo(current);
                const line = win.L.polyline([], { interactive: false, pane: layerPane, color: step.color || '#6535ad', weight: 6 }).addTo(current);
                if (points.length > 1) {
                    await move(visible.length === 1 ? 1500 : 950, local.signal, portion => trace(marker, line, points, portion));
                }
                marker.getElement()?.classList.add('is-checking');
                await move(points.length > 1 ? 260 : 700, local.signal, () => {});
            }
        } catch (error) {
            win.console.warn('[critic-tour] Animation unavailable', error);
        } finally {
            overlay?.remove();
            signal.removeEventListener('abort', stop);
            if (doc.activeElement === skip && !signal.aborted) close?.focus();
            skip.remove();
            panel.removeAttribute('data-critic-tour');
        }
    }

    function fitContext(map, bounds, padding, { force = false } = {}) {
        if (!bounds?.isValid()) return false;
        const size = map.getSize();
        const nw = map.latLngToContainerPoint(bounds.getNorthWest());
        const se = map.latLngToContainerPoint(bounds.getSouthEast());
        if (!force && nw.x >= padding.left && nw.y >= padding.top
            && se.x <= size.x - padding.right && se.y <= size.y - padding.bottom) return false;
        map.fitBounds(bounds, { maxZoom: 19, animate: false,
            paddingTopLeft: [padding.left, padding.top], paddingBottomRight: [padding.right, padding.bottom] });
        return true;
    }
    win.CriticTour = { play, sample, t, pane, fitContext };
})(window);
