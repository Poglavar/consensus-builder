// Public cadastral map imagery with exact parcel geometry loaded on a deliberate click.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PointParcelMap = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Async clicks are scoped to the active city and the most recent click. Geometry is retained
    // first, then integrated only if the visitor still wants that result.
    function createController({ city, canIdentify, repository, select, status, failed }) {
        let sequence = 0;
        async function identify(point, event) {
            if (!canIdentify(event)) return null;
            const requestedCity = city();
            const ticket = ++sequence;
            const active = () => ticket === sequence && city() === requestedCity && canIdentify(event);
            status('looking_up_parcel');
            try {
                const result = await repository.ensurePoint(point, { city: requestedCity, retainOnly: true });
                if (!active()) return null;
                if (!result.ids.length) { status('no_parcel_at_point'); return result; }
                await repository.ensureIds(result.ids, { city: requestedCity });
                if (!active()) return null;
                select(result.ids[0], event);
                status('parcel_boundary_loaded');
                return result;
            } catch (error) {
                if (active()) failed(error);
                return null;
            }
        }
        return { identify, invalidate: () => { sequence++; } };
    }

    let installed = null;
    const messages = {
        tap_parcel_to_load: 'Tap a parcel to load its boundary. Area-wide parcel loading is unavailable.',
        looking_up_parcel: 'Loading parcel…',
        no_parcel_at_point: 'No registered parcel returned at this point.',
        parcel_lookup_failed: 'Parcel could not be loaded. Tap again to retry.',
        parcel_boundary_loaded: 'Parcel boundary loaded.'
    };

    function install(root) {
        installed?.dispose();
        installed = null;
        const map = root.map;
        const config = () => root.CityConfigManager?.getCurrentCityConfig?.();
        const settings = config()?.parcels;
        if (!map || settings?.strategy !== 'point') return;
        const city = () => root.CityConfigManager.getCurrentCityId();
        const sourceCity = city();
        const status = key => {
            const translated = root.i18n?.t?.(`status.messages.${key}`);
            root.updateStatus?.(translated && translated !== `status.messages.${key}` ? translated : messages[key]);
        };
        const visible = () => city() === sourceCity
            && root.document.getElementById('parcelsCheckbox')?.checked !== false
            && map.getZoom() >= (config()?.map?.parcelZoomRange?.min ?? 17);
        const canIdentify = event => visible()
            && !event?.originalEvent?._stopped
            && !root.measureMode && !root.sharePlanMode && !root.proposalListBrowseMode
            && !root.__mapEditLock?.isHeld?.() && !root.pinpointToolIsActive?.()
            && !root.isParcelDrawingModeActive?.() && !root.isStructureGeometryEditorActive?.()
            && !root.AreaMonitorPaint?.isActive?.();
        const raster = settings.raster;
        let layer = null;
        if (raster) {
            const pane = map.getPane('pointParcelMap') || map.createPane('pointParcelMap');
            pane.style.zIndex = '390';
            pane.style.pointerEvents = 'none';
            const options = { pane: 'pointParcelMap', attribution: raster.attribution || settings.attribution,
                minZoom: config()?.map?.parcelZoomRange?.min ?? 17, maxZoom: 22, ...raster.params };
            layer = raster.layers
                ? root.L.tileLayer.wms(raster.url, { ...options, layers: raster.layers, version: raster.version || '1.1.1',
                    format: 'image/png', transparent: true })
                : root.L.tileLayer(raster.url, options);
        }
        const controller = createController({ city, canIdentify, repository: root.CadastralParcelRepository, status,
            failed: error => {
                console.error('[PointParcelMap] Parcel lookup failed', error);
                status('parcel_lookup_failed');
            },
            select: (id, event) => {
                const parcelLayer = root.ParcelPresenter?.getLayer?.(id);
                if (!parcelLayer) throw new Error('Loaded parcel has no map layer.');
                root.onParcelClick?.({ ...event, target: parcelLayer });
            }
        });
        const sync = () => {
            if (visible()) { if (layer && !map.hasLayer(layer)) layer.addTo(map); }
            else { controller.invalidate(); if (layer && map.hasLayer(layer)) map.removeLayer(layer); }
        };
        const click = event => {
            if (event.latlng) void controller.identify([event.latlng.lng, event.latlng.lat], event);
        };
        const checkbox = root.document.getElementById('parcelsCheckbox');
        const dispose = () => {
            controller.invalidate();
            map.off('click', click);
            map.off('zoomend', sync);
            checkbox?.removeEventListener('change', sync);
            if (layer && map.hasLayer(layer)) map.removeLayer(layer);
        };
        map.on('click', click);
        map.on('zoomend', sync);
        checkbox?.addEventListener('change', sync);
        installed = { sync, dispose };
        sync();
        status('tap_parcel_to_load');
    }

    return { createController, install, sync: () => installed?.sync() };
});
