(function () {
    // Lightweight overlay to surface memory and storage usage for debugging.
    const UPDATE_INTERVAL_MS = 10000;
    const BYTES_PER_CHAR = 2;

    let panelEl = null;
    let bodyEl = null;
    let summaryEl = null;
    let toggleBtn = null;
    let updaterId = null;
    let isCollapsed = false;
    let pendingUpdate = false;

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) {
            return 'n/a';
        }
        if (bytes < 1024) {
            return `${Math.round(bytes)} B`;
        }
        const units = ['KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unitIndex = -1;
        do {
            value /= 1024;
            unitIndex += 1;
        } while (value >= 1024 && unitIndex < units.length - 1);
        const digits = value >= 10 ? 1 : 2;
        return `${value.toFixed(digits)} ${units[unitIndex]}`;
    }

    function formatTimestamp(timestamp) {
        if (!Number.isFinite(timestamp)) {
            return '--';
        }
        try {
            return new Date(timestamp).toLocaleTimeString();
        } catch (_) {
            return '--';
        }
    }

    function approximateBytes(value) {
        if (!value) {
            return 0;
        }
        return value.length * BYTES_PER_CHAR;
    }

    function gatherHeapStats() {
        if (typeof performance === 'undefined' || !performance || !performance.memory) {
            return { available: false, used: NaN, total: NaN, limit: NaN };
        }
        const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = performance.memory;
        return {
            available: true,
            used: Number(usedJSHeapSize),
            total: Number(totalJSHeapSize),
            limit: Number(jsHeapSizeLimit)
        };
    }

    function gatherLocalStorageStats() {
        if (typeof window === 'undefined' || !window.localStorage) {
            return { available: false, bytes: NaN, keys: 0 };
        }
        let bytes = 0;
        let keys = 0;
        try {
            for (let index = 0; index < window.localStorage.length; index += 1) {
                const key = window.localStorage.key(index);
                let value = '';
                try {
                    value = window.localStorage.getItem(key);
                } catch (_) {
                    value = '';
                }
                keys += 1;
                bytes += approximateBytes(key || '');
                bytes += approximateBytes(value || '');
            }
        } catch (err) {
            console.warn('[MemoryMonitor] Unable to inspect localStorage.', err);
            return { available: false, bytes: NaN, keys: 0 };
        }
        return { available: true, bytes, keys };
    }

    function gatherPersistentStorageStats() {
        if (typeof PersistentStorage === 'undefined' || !PersistentStorage || typeof PersistentStorage.forEach !== 'function') {
            return { available: false, bytes: NaN, keys: 0 };
        }
        try {
            let bytes = 0;
            let keys = 0;
            PersistentStorage.forEach((value, key) => {
                keys += 1;
                bytes += approximateBytes(key || '');
                bytes += approximateBytes(value || '');
            });
            return { available: true, bytes, keys };
        } catch (err) {
            console.warn('[MemoryMonitor] Unable to inspect PersistentStorage.', err);
            return { available: false, bytes: NaN, keys: 0 };
        }
    }

    function summariseStats(heap, local, persistent) {
        const totalStorageBytes = (Number.isFinite(local.bytes) ? local.bytes : 0) + (Number.isFinite(persistent.bytes) ? persistent.bytes : 0);
        const heapLabel = heap.available ? formatBytes(heap.used) : 'n/a';
        const storageLabel = formatBytes(totalStorageBytes);
        return { totalStorageBytes, heapLabel, storageLabel };
    }

    function updateSummaryRow(stats) {
        if (!summaryEl) {
            return;
        }
        summaryEl.textContent = `Heap ${stats.heapLabel} · Storage ${stats.storageLabel}`;
    }

    function render(stats) {
        if (!bodyEl) {
            return;
        }
        const { heap, local, persistent, timestamp } = stats;
        const heapUsedEl = bodyEl.querySelector('[data-memory="heap-used"]');
        const heapTotalEl = bodyEl.querySelector('[data-memory="heap-total"]');
        const heapLimitEl = bodyEl.querySelector('[data-memory="heap-limit"]');
        const localBytesEl = bodyEl.querySelector('[data-memory="local-bytes"]');
        const localKeysEl = bodyEl.querySelector('[data-memory="local-keys"]');
        const persistentBytesEl = bodyEl.querySelector('[data-memory="persistent-bytes"]');
        const persistentKeysEl = bodyEl.querySelector('[data-memory="persistent-keys"]');
        const storageBytesEl = bodyEl.querySelector('[data-memory="storage-total"]');
        const updatedEl = bodyEl.querySelector('[data-memory="updated"]');

        if (heapUsedEl) heapUsedEl.textContent = heap.available ? formatBytes(heap.used) : 'n/a';
        if (heapTotalEl) heapTotalEl.textContent = heap.available ? formatBytes(heap.total) : 'n/a';
        if (heapLimitEl) heapLimitEl.textContent = heap.available ? formatBytes(heap.limit) : 'n/a';
        if (localBytesEl) localBytesEl.textContent = local.available ? formatBytes(local.bytes) : 'n/a';
        if (localKeysEl) localKeysEl.textContent = local.available ? `${local.keys}` : 'n/a';
        if (persistentBytesEl) persistentBytesEl.textContent = persistent.available ? formatBytes(persistent.bytes) : 'n/a';
        if (persistentKeysEl) persistentKeysEl.textContent = persistent.available ? `${persistent.keys}` : 'n/a';
        if (storageBytesEl) storageBytesEl.textContent = formatBytes(stats.totalStorageBytes);
        if (updatedEl) updatedEl.textContent = formatTimestamp(timestamp);
    }

    function collectStats() {
        const heap = gatherHeapStats();
        const local = gatherLocalStorageStats();
        const persistent = gatherPersistentStorageStats();
        const { totalStorageBytes, heapLabel, storageLabel } = summariseStats(heap, local, persistent);
        return {
            heap,
            local,
            persistent,
            totalStorageBytes,
            heapLabel,
            storageLabel,
            timestamp: Date.now()
        };
    }

    function runUpdate() {
        if (document.hidden) {
            pendingUpdate = false;
            return;
        }
        const stats = collectStats();
        updateSummaryRow(stats);
        if (!isCollapsed) {
            render(stats);
        }
        pendingUpdate = false;
    }

    function requestUpdate() {
        if (pendingUpdate) {
            return;
        }
        pendingUpdate = true;
        const invoke = () => {
            try {
                runUpdate();
            } catch (err) {
                pendingUpdate = false;
                console.warn('[MemoryMonitor] Failed to refresh stats.', err);
            }
        };
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(invoke, { timeout: 2000 });
        } else {
            setTimeout(invoke, 0);
        }
    }

    function handleToggleClick() {
        isCollapsed = !isCollapsed;
        if (panelEl) {
            panelEl.classList.toggle('memory-monitor-collapsed', isCollapsed);
        }
        if (toggleBtn) {
            toggleBtn.textContent = isCollapsed ? '+' : '–';
        }
        if (!isCollapsed) {
            requestUpdate();
        }
    }

    function buildPanel() {
        panelEl = document.createElement('div');
        panelEl.id = 'memory-monitor-panel';
        panelEl.className = 'memory-monitor-panel';
        panelEl.innerHTML = `
            <div class="memory-monitor-header">
                <div class="memory-monitor-title">Memory Monitor</div>
                <div class="memory-monitor-summary" data-memory="summary">--</div>
                <button type="button" class="memory-monitor-toggle" aria-label="Toggle memory monitor">&minus;</button>
            </div>
            <div class="memory-monitor-body">
                <div class="memory-monitor-row"><span>JS Heap Used</span><span data-memory="heap-used">--</span></div>
                <div class="memory-monitor-row"><span>JS Heap Total</span><span data-memory="heap-total">--</span></div>
                <div class="memory-monitor-row"><span>JS Heap Limit</span><span data-memory="heap-limit">--</span></div>
                <div class="memory-monitor-divider"></div>
                <div class="memory-monitor-row"><span>localStorage Size</span><span data-memory="local-bytes">--</span></div>
                <div class="memory-monitor-row"><span>localStorage Keys</span><span data-memory="local-keys">--</span></div>
                <div class="memory-monitor-divider"></div>
                <div class="memory-monitor-row"><span>Persistent Size</span><span data-memory="persistent-bytes">--</span></div>
                <div class="memory-monitor-row"><span>Persistent Keys</span><span data-memory="persistent-keys">--</span></div>
                <div class="memory-monitor-divider"></div>
                <div class="memory-monitor-row"><span>Total Stored</span><span data-memory="storage-total">--</span></div>
                <div class="memory-monitor-row"><span>Updated</span><span data-memory="updated">--</span></div>
            </div>
        `;
        document.body.appendChild(panelEl);

        bodyEl = panelEl.querySelector('.memory-monitor-body');
        summaryEl = panelEl.querySelector('[data-memory="summary"]');
        toggleBtn = panelEl.querySelector('.memory-monitor-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', handleToggleClick);
        }
    }

    function startMonitoring() {
        buildPanel();
        requestUpdate();
        updaterId = window.setInterval(requestUpdate, UPDATE_INTERVAL_MS);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                requestUpdate();
            }
        });
        if (typeof window !== 'undefined') {
            window.forceMemoryMonitorUpdate = requestUpdate;
        }
    }

    function init() {
        if (panelEl) {
            return;
        }
        startMonitoring();
    }

    function waitForReadyAndInit() {
        const boot = () => init();
        if (typeof PersistentStorage !== 'undefined' && PersistentStorage && PersistentStorage.ready && typeof PersistentStorage.ready.then === 'function') {
            PersistentStorage.ready.then(boot).catch(boot);
            return;
        }
        if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.ensureReady === 'function') {
            PersistentStorage.ensureReady(boot);
            return;
        }
        boot();
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', waitForReadyAndInit);
        } else {
            waitForReadyAndInit();
        }
    }

    if (typeof window !== 'undefined') {
        window.MemoryMonitor = {
            refresh: requestUpdate,
            stop() {
                if (updaterId) {
                    clearInterval(updaterId);
                    updaterId = null;
                }
            }
        };
    }
})();
