(function (global) {
    'use strict';

    const MONITOR_ROUTE_REGEX = /\/monitors\/(\d+)\/?$/;

    function nowMs() {
        return (global.performance && typeof global.performance.now === 'function')
            ? global.performance.now()
            : Date.now();
    }

    function roundMs(value) {
        return Number(value.toFixed(2));
    }

    function getBasePath() {
        const path = window.location.pathname.replace(MONITOR_ROUTE_REGEX, '');
        if (!path) return '/';
        return path;
    }

    function buildMonitorUrl(monitorId) {
        const basePath = getBasePath();
        const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
        return `${window.location.origin}${normalizedBase}monitors/${monitorId}`;
    }

    function parseMonitorRoute() {
        const path = window.location.pathname;
        const match = path.match(MONITOR_ROUTE_REGEX);
        if (match) {
            return parseInt(match[1], 10);
        }
        return null;
    }

    function getCityManager() {
        return global.CityConfigManager || null;
    }

    function getCityLabel(cityId) {
        const manager = getCityManager();
        if (!manager || typeof manager.getAvailableCities !== 'function') {
            return cityId;
        }
        const city = manager.getAvailableCities().find(entry => entry && entry.id === cityId);
        return city?.label || cityId;
    }

    async function ensureMonitorCityMatches(data) {
        const manager = getCityManager();
        if (!manager || typeof manager.getCurrentCityId !== 'function') {
            return true;
        }

        const monitorCityId = typeof data?.monitor?.cityId === 'string'
            ? data.monitor.cityId.trim()
            : '';
        const currentCityId = manager.getCurrentCityId();

        if (!monitorCityId || !currentCityId || monitorCityId === currentCityId) {
            return true;
        }

        const monitorCityLabel = getCityLabel(monitorCityId);
        const currentCityLabel = getCityLabel(currentCityId);
        const confirmFn = typeof global.showStyledConfirm === 'function'
            ? global.showStyledConfirm
            : global.confirm;
        const message = `This area monitor was created for ${monitorCityLabel}, but the current city is ${currentCityLabel}.\n\nSwitch to ${monitorCityLabel} and load the monitor?`;
        const proceed = await confirmFn(message, {
            okText: 'Switch city',
            cancelText: 'Cancel'
        });

        if (!proceed) {
            closeMonitor();
            if (global.AreaMonitorUI && typeof global.AreaMonitorUI.showToast === 'function') {
                global.AreaMonitorUI.showToast('Area monitor load cancelled because the selected city does not match.');
            }
            return false;
        }

        if (typeof manager.switchCity === 'function') {
            await manager.switchCity(monitorCityId);
            return false;
        }

        if (typeof manager.setCurrentCityId === 'function') {
            manager.setCurrentCityId(monitorCityId);
        }
        global.location.reload();
        return false;
    }

    async function loadMonitor(monitorId, options = {}) {
        if (!global.AreaMonitorUI || !global.AreaMonitorMap) {
            console.warn('Area monitor modules not loaded yet');
            return;
        }

        const loadStartedAt = nowMs();
        try {
            const fetchStartedAt = nowMs();
            const data = await global.AreaMonitorUI.fetchAreaMonitor(monitorId);
            const fetchMs = roundMs(nowMs() - fetchStartedAt);

            if (!await ensureMonitorCityMatches(data)) {
                return;
            }

            const renderStartedAt = nowMs();
            global.AreaMonitorMap.renderMonitor(data, { fitBounds: options.fitBounds !== false });
            const renderMs = roundMs(nowMs() - renderStartedAt);

            const overlayStartedAt = nowMs();
            if (typeof global.AreaMonitorMap.loadOverlayGeometries === 'function') {
                await global.AreaMonitorMap.loadOverlayGeometries(data);
                if (typeof global.AreaMonitorMap.reapplyStyles === 'function') {
                    global.AreaMonitorMap.reapplyStyles();
                }
            }
            const overlayMs = roundMs(nowMs() - overlayStartedAt);

            const detailPanelStartedAt = nowMs();
            global.AreaMonitorUI.showDetailPanel(data);
            const detailPanelMs = roundMs(nowMs() - detailPanelStartedAt);

            console.info('[area-monitor] loadMonitor diagnostics', {
                monitorId,
                parcelCount: data?.monitor?.parcelIds?.length || 0,
                fetchMs,
                overlayMs,
                renderMs,
                detailPanelMs,
                totalMs: roundMs(nowMs() - loadStartedAt)
            });
        } catch (error) {
            console.error('Failed to load area monitor:', error);
            global.AreaMonitorUI.showToast('Area monitor not found or failed to load.');
        }
    }

    function openMonitor(monitorId) {
        const id = parseInt(monitorId, 10);
        if (!Number.isFinite(id) || id <= 0) return;
        window.history.pushState({ monitorId: id }, '', buildMonitorUrl(id));
        loadMonitor(id, { fitBounds: true });
    }

    function closeMonitor(options = {}) {
        if (global.AreaMonitorUI) {
            global.AreaMonitorUI.removeDetailPanel();
            if (typeof global.AreaMonitorUI.removeMonitorListModal === 'function') {
                global.AreaMonitorUI.removeMonitorListModal();
            }
        }
        if (global.AreaMonitorMap) {
            if (typeof global.AreaMonitorMap.clearActiveMonitor === 'function') {
                global.AreaMonitorMap.clearActiveMonitor();
            } else {
                global.AreaMonitorMap.clear();
            }
        }
        if (options.updateUrl !== false) {
            window.history.pushState(null, '', `${getBasePath()}${window.location.search || ''}${window.location.hash || ''}`);
        }
    }

    function handleRouteOnLoad() {
        const monitorId = parseMonitorRoute();
        if (monitorId) {
            // Delay to let map and parcels initialize
            setTimeout(() => loadMonitor(monitorId, { fitBounds: true }), 1500);
        }
    }

    // Listen for areaMonitorCreated to load the new monitor
    global.addEventListener('areaMonitorCreated', (e) => {
        const monitor = e.detail;
        if (monitor && monitor.id) {
            // Small delay for URL to update
            setTimeout(() => loadMonitor(monitor.id, { fitBounds: true }), 300);
        }
    });

    // Handle browser back/forward
    global.addEventListener('popstate', () => {
        const monitorId = parseMonitorRoute();
        if (monitorId) {
            loadMonitor(monitorId, { fitBounds: true });
        } else {
            // Clear monitor display if navigated away
            closeMonitor({ updateUrl: false });
        }
    });

    // Init on page load
    if (document.readyState === 'complete') {
        handleRouteOnLoad();
    } else {
        global.addEventListener('load', handleRouteOnLoad);
    }

    // Public API
    global.AreaMonitorRouting = {
        buildMonitorUrl,
        closeMonitor,
        getBasePath,
        openMonitor,
        parseMonitorRoute,
        loadMonitor
    };

})(typeof window !== 'undefined' ? window : globalThis);
