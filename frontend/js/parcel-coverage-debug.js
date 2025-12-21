(function () {
    'use strict';

    if (typeof window === 'undefined') {
        return;
    }

    let modalElement = null;
    let openButton = null;
    let closeButton = null;
    let refreshButton = null;
    let legendElement = null;
    let summaryElement = null;
    let mapContainer = null;

    let coverageMap = null;
    let coverageLayerGroup = null;

    let listenersAttached = false;

    const CELL_STYLE = {
        color: '#d97706',
        weight: 1,
        fillOpacity: 0.28,
        fillColor: '#f59e0b',
        dashArray: null,
        interactive: false
    };

    const VIEWPORT_STYLE = {
        color: '#2563eb',
        weight: 1.5,
        fillOpacity: 0.08,
        fillColor: '#2563eb',
        dashArray: '6, 4',
        interactive: false
    };

    const TILE_OPTIONS = {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    };

    function cacheElements() {
        modalElement = document.getElementById('parcel-coverage-modal') || null;
        openButton = document.getElementById('showParcelCoverageButton') || null;
        closeButton = document.getElementById('parcel-coverage-close-btn') || null;
        refreshButton = document.getElementById('parcel-coverage-refresh-btn') || null;
        legendElement = document.getElementById('parcel-coverage-legend') || null;
        summaryElement = document.getElementById('parcel-coverage-summary') || null;
        mapContainer = document.getElementById('parcel-coverage-map') || null;
    }

    function ensureMap() {
        if (!mapContainer || typeof L === 'undefined') {
            return null;
        }
        if (coverageMap) {
            setTimeout(() => coverageMap.invalidateSize(), 0);
            return coverageMap;
        }
        coverageMap = L.map(mapContainer, {
            attributionControl: false,
            zoomControl: true,
            preferCanvas: true
        });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', TILE_OPTIONS).addTo(coverageMap);
        coverageLayerGroup = L.layerGroup().addTo(coverageMap);

        try {
            if (typeof map !== 'undefined' && map && typeof map.getCenter === 'function') {
                const primaryCenter = map.getCenter();
                const primaryZoom = typeof map.getZoom === 'function' ? map.getZoom() : 16;
                if (primaryCenter && Number.isFinite(primaryCenter.lat) && Number.isFinite(primaryCenter.lng)) {
                    coverageMap.setView(primaryCenter, Math.max(0, Math.min(19, primaryZoom || 16)));
                } else {
                    coverageMap.setView([45.804503, 15.978786], 16);
                }
            } else {
                coverageMap.setView([45.804503, 15.978786], 16);
            }
        } catch (error) {
            console.warn('Failed to initialise coverage map view', error);
            coverageMap.setView([45.804503, 15.978786], 16);
        }

        requestAnimationFrame(() => coverageMap.invalidateSize());
        setTimeout(() => coverageMap.invalidateSize(), 60);
        return coverageMap;
    }

    function isModalOpen() {
        return !!modalElement && modalElement.style.display && modalElement.style.display !== 'none';
    }

    function formatArea(areaSqm) {
        if (!Number.isFinite(areaSqm) || areaSqm <= 0) {
            return '0 m²';
        }
        if (areaSqm >= 1_000_000) {
            return `${(areaSqm / 1_000_000).toFixed(areaSqm >= 10_000_000 ? 1 : 2)} km²`;
        }
        if (areaSqm >= 10_000) {
            return `${(areaSqm / 10_000).toFixed(areaSqm >= 100_000 ? 0 : 1)} ha`;
        }
        return `${Math.round(areaSqm).toLocaleString()} m²`;
    }

    function gridKeyToBounds(key) {
        if (typeof key !== 'string' || !key.includes(',')) {
            return null;
        }
        const parts = key.split(',').map(Number);
        if (parts.length !== 2) {
            return null;
        }
        const [gridEasting, gridNorthing] = parts;
        if (!Number.isFinite(gridEasting) || !Number.isFinite(gridNorthing) || typeof parcelCache === 'undefined') {
            return null;
        }
        const cellSize = parcelCache && parcelCache.gridSize ? parcelCache.gridSize : 500;
        const swEasting = gridEasting * cellSize;
        const swNorthing = gridNorthing * cellSize;
        const neEasting = (gridEasting + 1) * cellSize;
        const neNorthing = (gridNorthing + 1) * cellSize;

        const swLatLng = htrsToLatLng(swEasting, swNorthing);
        const neLatLng = htrsToLatLng(neEasting, neNorthing);
        if (!swLatLng || !neLatLng) {
            return null;
        }
        return L.latLngBounds(swLatLng, neLatLng);
    }

    function htrsToLatLng(easting, northing) {
        if (typeof window.htrs96ToWGS84 !== 'function') {
            return null;
        }
        try {
            const [lat, lon] = window.htrs96ToWGS84(easting, northing);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                return null;
            }
            return L.latLng(lat, lon);
        } catch (error) {
            console.warn('Failed to convert HTRS96/TM to WGS84 for coverage visualisation', error);
            return null;
        }
    }

    function computeCoverageData() {
        const result = {
            cellBounds: [],
            coverageBounds: null,
            totalCells: 0,
            intersectingCells: 0,
            viewCellCount: 0,
            cellAreaSqm: 0
        };

        if (typeof parcelCache === 'undefined' || !parcelCache || !parcelCache.grid) {
            return result;
        }
        const gridSize = parcelCache.gridSize || 500;
        result.cellAreaSqm = gridSize * gridSize;

        const mainMapBounds = (typeof map !== 'undefined' && map && typeof map.getBounds === 'function') ? map.getBounds() : null;

        let aggregateBounds = null;

        for (const key of parcelCache.grid.keys()) {
            const bounds = gridKeyToBounds(key);
            if (!bounds) {
                continue;
            }
            result.cellBounds.push(bounds);
            result.totalCells += 1;

            if (typeof L !== 'undefined' && typeof L.latLngBounds === 'function') {
                if (!aggregateBounds) {
                    aggregateBounds = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
                } else {
                    aggregateBounds.extend(bounds.getSouthWest());
                    aggregateBounds.extend(bounds.getNorthEast());
                }
            }

            if (mainMapBounds && bounds.intersects(mainMapBounds)) {
                result.intersectingCells += 1;
            }
        }

        if (aggregateBounds && aggregateBounds.isValid()) {
            result.coverageBounds = aggregateBounds;
        }

        if (mainMapBounds && typeof window.getRequiredGridCells === 'function') {
            try {
                const zoom = (typeof map !== 'undefined' && map && typeof map.getZoom === 'function') ? map.getZoom() : null;
                const latSpan = Math.abs(mainMapBounds.getNorth() - mainMapBounds.getSouth());
                const lngSpan = Math.abs(mainMapBounds.getEast() - mainMapBounds.getWest());
                const spanTooLarge = latSpan > 1.5 || lngSpan > 1.5; // prevent world-scale grids
                const zoomTooLow = Number.isFinite(zoom) && zoom < 11;

                if (spanTooLarge || zoomTooLow) {
                    result.viewCellCount = 0;
                } else {
                    const cells = window.getRequiredGridCells(mainMapBounds, 0);
                    result.viewCellCount = cells.size > 5000 ? 5000 : cells.size;
                }
            } catch (error) {
                console.warn('Unable to compute view cell count for coverage modal', error);
                result.viewCellCount = 0;
            }
        } else if (mainMapBounds) {
            result.viewCellCount = result.intersectingCells;
        }

        return result;
    }

    function updateLegend(totalCells) {
        if (!legendElement) {
            return;
        }
        const cachedLabel = totalCells === 1 ? 'cached cell' : 'cached cells';
        legendElement.innerHTML = `
            <div class="parcel-coverage-legend-item">
                <span class="parcel-coverage-swatch coverage"></span>
                <span>${totalCells.toLocaleString()} ${cachedLabel}</span>
            </div>
            <div class="parcel-coverage-legend-item">
                <span class="parcel-coverage-swatch viewport"></span>
                <span>Current map view</span>
            </div>
        `;
    }

    function updateSummary(data) {
        if (!summaryElement) {
            return;
        }
        if (!data.totalCells) {
            summaryElement.textContent = 'No cached parcel grid cells found. Fetch parcels to populate the cache, then refresh.';
            return;
        }
        const cachedArea = data.totalCells * data.cellAreaSqm;
        const overlapArea = data.intersectingCells * data.cellAreaSqm;
        const viewArea = data.viewCellCount * data.cellAreaSqm;
        const overlapPct = viewArea > 0 ? ((overlapArea / viewArea) * 100) : null;

        const parts = [
            `Cached ${data.totalCells.toLocaleString()} cells (~${formatArea(cachedArea)})`
        ];
        if (data.intersectingCells) {
            parts.push(`Overlap with current view: ${data.intersectingCells.toLocaleString()} cells (~${formatArea(overlapArea)})`);
        } else {
            parts.push('Current view has no overlap with cached cells');
        }
        if (overlapPct !== null && isFinite(overlapPct)) {
            parts.push(`Approximate coverage of view: ${overlapPct.toFixed(overlapPct >= 99.5 ? 0 : 1)}%`);
        }
        summaryElement.textContent = parts.join(' • ');
    }

    function updateMap(data, options = {}) {
        const mapInstance = ensureMap();
        if (!mapInstance || !coverageLayerGroup) {
            return;
        }
        coverageLayerGroup.clearLayers();

        data.cellBounds.forEach(bounds => {
            L.rectangle(bounds, CELL_STYLE).addTo(coverageLayerGroup);
        });

        const mainMapBounds = (typeof map !== 'undefined' && map && typeof map.getBounds === 'function') ? map.getBounds() : null;
        if (mainMapBounds) {
            L.rectangle(mainMapBounds, VIEWPORT_STYLE).addTo(coverageLayerGroup);
        }

        const shouldFit = options.fitToContent === true || (!options.hasOwnProperty('fitToContent') && !mapInstance.__coverageHasFitted);
        if (shouldFit) {
            let targetBounds = null;
            const coverageLayers = coverageLayerGroup.getLayers();
            if (data.coverageBounds && data.coverageBounds.isValid()) {
                targetBounds = data.coverageBounds;
            } else if (coverageLayers.length > 0) {
                targetBounds = coverageLayerGroup.getBounds();
            } else if (mainMapBounds) {
                targetBounds = mainMapBounds;
            }
            if (targetBounds && targetBounds.isValid()) {
                const paddedBounds = typeof targetBounds.pad === 'function' ? targetBounds.pad(0.04) : targetBounds;
                const fitOptions = {
                    padding: [24, 24],
                    animate: false,
                    maxZoom: typeof options.maxZoom === 'number' ? options.maxZoom : 15
                };
                requestAnimationFrame(() => mapInstance.fitBounds(paddedBounds, fitOptions));
                setTimeout(() => mapInstance.fitBounds(paddedBounds, fitOptions), 60);
                mapInstance.__coverageHasFitted = true;
            }
        }

        requestAnimationFrame(() => mapInstance.invalidateSize());
        setTimeout(() => mapInstance.invalidateSize(), 60);
    }

    function refreshVisualization(options) {
        if (!isModalOpen()) {
            return;
        }
        const coverageData = computeCoverageData();
        updateLegend(coverageData.totalCells);
        updateSummary(coverageData);
        updateMap(coverageData, options);
    }

    function attachGlobalListeners() {
        if (listenersAttached) {
            return;
        }
        listenersAttached = true;
        if (typeof map !== 'undefined' && map && typeof map.on === 'function') {
            map.on('moveend', handlePrimaryMapChange);
            map.on('zoomend', handlePrimaryMapChange);
        }
        window.addEventListener('parcelCoverageUpdated', handleCoverageEvent);
    }

    function detachGlobalListeners() {
        if (!listenersAttached) {
            return;
        }
        listenersAttached = false;
        if (typeof map !== 'undefined' && map && typeof map.off === 'function') {
            map.off('moveend', handlePrimaryMapChange);
            map.off('zoomend', handlePrimaryMapChange);
        }
        window.removeEventListener('parcelCoverageUpdated', handleCoverageEvent);
    }

    function handlePrimaryMapChange() {
        if (!isModalOpen()) {
            return;
        }
        refreshVisualization({ fitToContent: false });
    }

    function handleCoverageEvent() {
        if (!isModalOpen()) {
            return;
        }
        refreshVisualization({ fitToContent: true, maxZoom: 15 });
    }

    function openModal() {
        if (!modalElement) {
            return;
        }
        modalElement.style.display = 'flex';
        attachGlobalListeners();
        ensureMap();
        if (coverageMap) {
            coverageMap.__coverageHasFitted = false;
        }
        refreshVisualization({ fitToContent: true });
    }

    function closeModal() {
        if (!modalElement) {
            return;
        }
        modalElement.style.display = 'none';
        detachGlobalListeners();
    }

    function handleDocumentKeydown(event) {
        if (event.key === 'Escape' && isModalOpen()) {
            event.stopPropagation();
            closeModal();
        }
    }

    function handleOverlayClick(event) {
        if (event.target === modalElement) {
            closeModal();
        }
    }

    function init() {
        cacheElements();
        if (!modalElement || !openButton) {
            return;
        }

        const initialData = computeCoverageData();
        updateLegend(initialData.totalCells);
        updateSummary(initialData);

        openButton.addEventListener('click', function () {
            openModal();
        });

        if (closeButton) {
            closeButton.addEventListener('click', function () {
                closeModal();
            });
        }

        if (refreshButton) {
            refreshButton.addEventListener('click', function () {
                refreshVisualization({ fitToContent: true });
            });
        }

        modalElement.addEventListener('click', handleOverlayClick);
        window.addEventListener('keydown', handleDocumentKeydown);

        // Keep modal in sync if coverage updates while it's closed, so that summary is fresh when opened
        window.addEventListener('parcelCoverageUpdated', function () {
            if (!isModalOpen() && summaryElement) {
                const data = computeCoverageData();
                updateLegend(data.totalCells);
                updateSummary(data);
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
