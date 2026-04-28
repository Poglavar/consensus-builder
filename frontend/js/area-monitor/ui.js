(function (global) {
    'use strict';

    const MAX_PARCELS = 400;

    function nowMs() {
        return (global.performance && typeof global.performance.now === 'function')
            ? global.performance.now()
            : Date.now();
    }

    function roundMs(value) {
        return Number(value.toFixed(2));
    }

    function t(key, params) {
        if (global.i18n && typeof global.i18n.t === 'function') {
            const val = global.i18n.t(key, params);
            if (val && val !== key) return val;
        }
        return null;
    }

    // --- Draw button state ---

    function setDrawButtonActive(active) {
        const btn = document.getElementById('areaMonitorDrawButton');
        if (!btn) return;
        btn.classList.toggle('active', active);
        // While freely drawing, grey out "Draw from plan"
        setDrawFromPlanEnabled(!active && isPlanLoaded());
    }

    // --- Creation panel (shown after polygon is closed) ---

    function showCreationPanel(detail) {
        const { polygon, parcels } = detail;

        if (parcels.length === 0 && !polygon) {
            showToast(t('sidebar.areaMonitor.noParcelsFound') || 'No parcels found in the drawn area. Ensure parcels are loaded on the map first.');
            return;
        }

        if (parcels.length > MAX_PARCELS) {
            showToast((t('sidebar.areaMonitor.tooManyParcels', { count: parcels.length })) || `Too many parcels (${parcels.length}). Maximum is ${MAX_PARCELS}. Draw a smaller area.`);
            return;
        }

        removeCreationPanel();

        const panel = document.createElement('div');
        panel.id = 'area-monitor-creation-panel';
        panel.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #fff; border-radius: 12px; padding: 24px; z-index: 10000;
            box-shadow: 0 8px 32px rgba(0,0,0,0.18); min-width: 340px; max-width: 420px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;

        const lblTitle = t('sidebar.areaMonitor.createTitle') || 'New Area Monitor';
        const lblName = t('sidebar.areaMonitor.nameLabel') || 'Name';
        const lblPlaceholder = t('sidebar.areaMonitor.namePlaceholder') || 'e.g. Slavonska extension';
        const polygonDerived = parcels.length === 0 && !!polygon;
        const lblParcels = polygonDerived
            ? (t('sidebar.areaMonitor.parcelsFromPolygon') || 'Parcels will be resolved from the polygon when created.')
            : (t('sidebar.areaMonitor.parcelsFound', { count: parcels.length }) || `${parcels.length} parcels found`);
        const createDisabled = !polygonDerived && parcels.length === 0;
        const lblExtLinks = t('sidebar.areaMonitor.externalLinks') || 'External links (optional)';
        const lblEojn = t('sidebar.areaMonitor.eojnLabel') || 'EOJN URL';
        const lblSsc = t('sidebar.areaMonitor.skyscraperCityLabel') || 'SkyscraperCity URL';
        const lblCancel = t('sidebar.areaMonitor.cancelButton') || 'Cancel';
        const lblCreate = t('sidebar.areaMonitor.createButton') || 'Create';

        panel.innerHTML = `
            <h3 style="margin:0 0 16px;font-size:18px;font-weight:600;">${escapeHtml(lblTitle)}</h3>
            <div style="margin-bottom:12px;">
                <label style="display:block;font-size:13px;font-weight:500;margin-bottom:4px;">${escapeHtml(lblName)}</label>
                <input id="am-name" type="text" placeholder="${escapeAttr(lblPlaceholder)}" maxlength="100"
                    style="width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:14px;box-sizing:border-box;" />
            </div>
            <div style="margin-bottom:12px;font-size:13px;color:#555;">
                <strong>${escapeHtml(lblParcels)}</strong>
            </div>
            <details style="margin-bottom:12px;">
                <summary style="cursor:pointer;font-size:13px;color:#777;">${escapeHtml(lblExtLinks)}</summary>
                <div style="margin-top:8px;">
                    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:2px;">${escapeHtml(lblEojn)}</label>
                    <input id="am-eojn" type="url" placeholder="https://eojn.nn.hr/..." disabled
                        style="width:100%;padding:6px 8px;border:1px solid #eee;border-radius:4px;font-size:13px;box-sizing:border-box;margin-bottom:8px;background:#f5f5f5;color:#aaa;cursor:not-allowed;" />
                    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:2px;">${escapeHtml(lblSsc)}</label>
                    <input id="am-skyscrapercity" type="url" placeholder="https://skyscrapercity.com/..." disabled
                        style="width:100%;padding:6px 8px;border:1px solid #eee;border-radius:4px;font-size:13px;box-sizing:border-box;background:#f5f5f5;color:#aaa;cursor:not-allowed;" />
                </div>
            </details>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
                <button id="am-cancel" style="padding:8px 16px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">${escapeHtml(lblCancel)}</button>
                <button id="am-create" ${createDisabled ? 'disabled' : ''} style="padding:8px 16px;border:none;border-radius:6px;background:#2196F3;color:#fff;cursor:pointer;font-size:13px;font-weight:500;${createDisabled ? 'opacity:0.45;cursor:not-allowed;' : ''}">${escapeHtml(lblCreate)}</button>
            </div>
            <div id="am-error" style="color:#d32f2f;font-size:12px;margin-top:8px;display:none;"></div>
        `;

        document.body.appendChild(panel);

        // Add backdrop
        const backdrop = document.createElement('div');
        backdrop.id = 'area-monitor-backdrop';
        backdrop.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.3);z-index:9999;';
        backdrop.addEventListener('click', removeCreationPanel);
        document.body.appendChild(backdrop);

        const nameInput = document.getElementById('am-name');
        nameInput.focus();

        document.getElementById('am-cancel').addEventListener('click', removeCreationPanel);
        document.getElementById('am-create').addEventListener('click', async () => {
            const name = nameInput.value.trim();
            if (name.length < 3) {
                showPanelError(t('sidebar.areaMonitor.nameLabel') ? (t('sidebar.areaMonitor.nameLabel') + ' — min 3') : 'Name must be at least 3 characters.');
                return;
            }

            const parcelIds = parcels.map(p => p.parcelId);
            const eojnUrl = document.getElementById('am-eojn')?.value.trim() || null;
            const skyscraperCityUrl = document.getElementById('am-skyscrapercity')?.value.trim() || null;

            const createBtn = document.getElementById('am-create');
            createBtn.disabled = true;
            createBtn.textContent = t('sidebar.areaMonitor.creating') || 'Creating...';

            try {
                const monitor = await createAreaMonitor({
                    name,
                    polygon,
                    parcelIds,
                    eojnUrl,
                    skyscraperCityUrl
                });

                removeCreationPanel();

                // Navigate to the new monitor
                const monitorUrl = (global.AreaMonitorRouting && typeof global.AreaMonitorRouting.buildMonitorUrl === 'function')
                    ? global.AreaMonitorRouting.buildMonitorUrl(monitor.id)
                    : `${window.location.origin}${window.location.pathname.replace(/\/?$/, '/')}monitors/${monitor.id}`;
                window.history.pushState({ monitorId: monitor.id }, '', monitorUrl);
                global.dispatchEvent(new CustomEvent('areaMonitorCreated', { detail: monitor }));

                showToast(t('sidebar.areaMonitor.created', { name: monitor.name }) || `Area monitor "${monitor.name}" created`);
            } catch (err) {
                createBtn.disabled = false;
                createBtn.textContent = t('sidebar.areaMonitor.createButton') || 'Create';
                showPanelError(err.message || 'Failed to create area monitor.');
            }
        });
    }

    function removeCreationPanel() {
        const panel = document.getElementById('area-monitor-creation-panel');
        if (panel) panel.remove();
        const backdrop = document.getElementById('area-monitor-backdrop');
        if (backdrop) backdrop.remove();
    }

    function showPanelError(msg) {
        const el = document.getElementById('am-error');
        if (el) {
            el.textContent = msg;
            el.style.display = 'block';
        }
    }

    // --- API calls ---

    function getBackendBase() {
        if (typeof global.resolveBackendBaseUrl === 'function') {
            return global.resolveBackendBaseUrl();
        }
        return 'http://localhost:3000';
    }

    function getCurrentCityId() {
        const manager = global.CityConfigManager || null;
        if (!manager || typeof manager.getCurrentCityId !== 'function') {
            return 'zagreb';
        }
        return manager.getCurrentCityId() || 'zagreb';
    }

    function generateFingerprint() {
        try {
            const raw = [
                navigator.userAgent || '',
                navigator.language || '',
                screen.width + 'x' + screen.height,
                new Date().getTimezoneOffset()
            ].join('|');
            let hash = 0;
            for (let i = 0; i < raw.length; i++) {
                const chr = raw.charCodeAt(i);
                hash = ((hash << 5) - hash) + chr;
                hash |= 0;
            }
            return Math.abs(hash).toString(16).padStart(8, '0');
        } catch (_) {
            return null;
        }
    }

    async function createAreaMonitor(data) {
        const backendBase = getBackendBase();
        const response = await fetch(`${backendBase}/area-monitors`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: data.name,
                cityId: getCurrentCityId(),
                polygon: data.polygon,
                parcelIds: data.parcelIds,
                eojnUrl: data.eojnUrl,
                skyscraperCityUrl: data.skyscraperCityUrl,
                fingerprint: generateFingerprint()
            })
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Server error (${response.status})`);
        }

        return response.json();
    }

    async function fetchAreaMonitor(id) {
        const backendBase = getBackendBase();
        const fetchStartedAt = nowMs();
        const response = await fetch(`${backendBase}/area-monitors/${id}`);
        const networkMs = roundMs(nowMs() - fetchStartedAt);
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Not found (${response.status})`);
        }

        const jsonStartedAt = nowMs();
        const payload = await response.json();
        const jsonParseMs = roundMs(nowMs() - jsonStartedAt);

        console.info('[area-monitor] fetchAreaMonitor diagnostics', {
            monitorId: id,
            status: response.status,
            contentLength: response.headers.get('content-length'),
            networkMs,
            jsonParseMs,
            totalMs: roundMs(nowMs() - fetchStartedAt)
        });

        return payload;
    }

    async function fetchAreaMonitorList() {
        const backendBase = getBackendBase();
        const response = await fetch(`${backendBase}/area-monitors`);
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Server error (${response.status})`);
        }
        const payload = await response.json();
        return Array.isArray(payload?.monitors) ? payload.monitors : [];
    }

    // --- Detail panel (shown when viewing an existing monitor) ---

    function setDetailPanelMinimized(panel, minimized, labels = {}) {
        if (!panel) return;

        panel.classList.toggle('is-minimized', minimized);

        const body = panel.querySelector('.panel-body');
        if (body) {
            body.hidden = minimized;
        }

        const toggleButton = panel.querySelector('#am-detail-minimize');
        if (toggleButton) {
            const nextLabel = minimized
                ? (labels.expandLabel || 'Expand')
                : (labels.minimizeLabel || 'Minimize');
            toggleButton.setAttribute('aria-label', nextLabel);
            toggleButton.setAttribute('title', nextLabel);
            toggleButton.setAttribute('aria-expanded', minimized ? 'false' : 'true');
            toggleButton.innerHTML = minimized ? '+' : '&#8722;';
        }
    }

    function showDetailPanel(data) {
        removeDetailPanel();
        removeMonitorListModal();

        const { monitor, parcels, summary } = data;
        const acquiredCount = Number.isFinite(summary.cityOwned) ? summary.cityOwned : (summary.governmentOwned || 0);
        const pct = summary.total > 0 ? Math.round((acquiredCount / summary.total) * 100) : 0;

        const lblAcquired = t('sidebar.areaMonitor.acquired') || 'acquired';
        const lblParcels = t('sidebar.areaMonitor.parcels') || 'parcels';
        const lblMonitoredArea = t('sidebar.areaMonitor.monitoredArea') || 'Monitored area';
        const polygonAreaSqm = computePolygonAreaSqm(monitor.polygon);
        const formattedArea = polygonAreaSqm > 0 ? formatArea(polygonAreaSqm) : '';
        const lblCopyLink = t('sidebar.areaMonitor.copyShareLink') || 'Copy share link';
        const lblListOtherMonitors = t('sidebar.areaMonitor.listOtherMonitors') || 'List other monitors';
        const lblMinimize = t('sidebar.areaMonitor.minimize') || 'Minimize';
        const lblExpand = t('sidebar.areaMonitor.expand') || 'Expand';
        const lblClose = t('modal.common.close') || 'Close';
        const lblSubscribe = t('sidebar.areaMonitor.subscribeTitle') || 'Subscribe for updates';
        const lblSubPlaceholder = t('sidebar.areaMonitor.subscribePlaceholder') || 'your@email.com';
        const lblSubHint = t('sidebar.areaMonitor.subscribeHint') || 'Get an email alert when something changes';

        const panel = document.createElement('div');
        panel.id = 'area-monitor-detail-panel';
        panel.className = 'info-panel visible';

        const externalLinks = [];
        if (monitor.eojnUrl) {
            externalLinks.push(`<a href="${escapeHtml(monitor.eojnUrl)}" target="_blank" rel="noopener">EOJN</a>`);
        }
        if (monitor.skyscraperCityUrl) {
            externalLinks.push(`<a href="${escapeHtml(monitor.skyscraperCityUrl)}" target="_blank" rel="noopener">SkyscraperCity</a>`);
        }

        panel.innerHTML = `
            <div class="panel-header">
                <h3>${escapeHtml(monitor.name)}</h3>
                <div class="panel-header__actions">
                    <button id="am-detail-minimize" type="button" class="close-circle-btn close-circle-btn--lg area-monitor-detail-toggle"
                        aria-label="${escapeAttr(lblMinimize)}" title="${escapeAttr(lblMinimize)}" aria-controls="am-detail-body" aria-expanded="true">&#8722;</button>
                    <button id="am-detail-close" type="button" class="close-circle-btn close-circle-btn--lg close-button"
                        aria-label="${escapeAttr(lblClose)}" title="${escapeAttr(lblClose)}">×</button>
                </div>
            </div>
            <div id="am-detail-body" class="panel-body">
                <div class="area-monitor-detail-summary">
                    <div class="area-monitor-detail-summary__percent">${pct}%</div>
                    <div class="area-monitor-detail-summary__meta">${escapeHtml(lblAcquired)} (${acquiredCount} / ${summary.total} ${escapeHtml(lblParcels)})</div>
                    <div class="area-monitor-detail-summary__bar">
                        <div class="area-monitor-detail-summary__fill" style="width:${pct}%;"></div>
                    </div>
                    ${formattedArea ? `<div class="area-monitor-detail-summary__area">${escapeHtml(lblMonitoredArea)}: ${escapeHtml(formattedArea)}</div>` : ''}
                </div>
                ${externalLinks.length ? `<div class="area-monitor-detail-links">${externalLinks.join('<span class="area-monitor-detail-links__sep">&middot;</span>')}</div>` : ''}
                <div class="area-monitor-detail-actions">
                    <button id="am-share" type="button" class="btn btn-secondary area-monitor-detail-button">
                        ${escapeHtml(lblCopyLink)}
                    </button>
                    <button id="am-list-others" type="button" class="btn btn-secondary area-monitor-detail-button">
                        ${escapeHtml(lblListOtherMonitors)}
                    </button>
                </div>
                <div class="area-monitor-detail-subscribe">
                    <div class="area-monitor-detail-subscribe__title">${escapeHtml(lblSubscribe)}</div>
                    <input type="email" placeholder="${escapeAttr(lblSubPlaceholder)}" disabled
                        class="area-monitor-detail-subscribe__input" />
                    <div class="area-monitor-detail-subscribe__hint">${escapeHtml(lblSubHint)}</div>
                </div>
            </div>
        `;

        const mapContainer = document.getElementById('map-container') || document.body;
        mapContainer.appendChild(panel);

        document.getElementById('am-detail-minimize').addEventListener('click', () => {
            const isMinimized = panel.classList.contains('is-minimized');
            setDetailPanelMinimized(panel, !isMinimized, {
                minimizeLabel: lblMinimize,
                expandLabel: lblExpand
            });
        });

        document.getElementById('am-detail-close').addEventListener('click', () => {
            if (global.AreaMonitorRouting && typeof global.AreaMonitorRouting.closeMonitor === 'function') {
                global.AreaMonitorRouting.closeMonitor();
                return;
            }
            removeDetailPanel();
            if (global.AreaMonitorMap) {
                if (typeof global.AreaMonitorMap.clearActiveMonitor === 'function') {
                    global.AreaMonitorMap.clearActiveMonitor();
                } else {
                    global.AreaMonitorMap.clear();
                }
            }
            const baseUrl = window.location.origin + window.location.pathname.replace(/monitors\/\d+\/?$/, '');
            window.history.pushState(null, '', baseUrl);
        });

        setDetailPanelMinimized(panel, false, {
            minimizeLabel: lblMinimize,
            expandLabel: lblExpand
        });

        document.getElementById('am-list-others').addEventListener('click', () => {
            showMonitorListModal();
        });

        document.getElementById('am-share').addEventListener('click', () => {
            const url = `${window.location.origin}${window.location.pathname}`;
            const lblCopied = t('sidebar.areaMonitor.copied') || 'Copied!';
            navigator.clipboard.writeText(url).then(() => {
                const btn = document.getElementById('am-share');
                btn.textContent = lblCopied;
                setTimeout(() => { btn.textContent = t('sidebar.areaMonitor.copyShareLink') || 'Copy share link'; }, 2000);
            });
        });
    }

    function removeDetailPanel() {
        const panel = document.getElementById('area-monitor-detail-panel');
        if (panel) panel.remove();
    }

    function formatMonitorDate(dateValue) {
        if (!dateValue) return '';
        try {
            return new Date(dateValue).toLocaleDateString();
        } catch (_) {
            return '';
        }
    }

    function removeMonitorListModal() {
        const modal = document.getElementById('area-monitor-list-modal');
        if (modal) modal.remove();
        const backdrop = document.getElementById('area-monitor-list-backdrop');
        if (backdrop) backdrop.remove();
    }

    function isMobileViewport() {
        return typeof window !== 'undefined' && window.innerWidth < 768;
    }

    async function prepareMonitorSelection() {
        const isMobile = isMobileViewport();
        if (!isMobile) {
            return;
        }

        removeMonitorListModal();

        const sidebar = document.getElementById('sidebar');
        if (!sidebar || sidebar.classList.contains('collapsed') || typeof global.toggleSidebar !== 'function') {
            return;
        }

        try {
            global.toggleSidebar();
        } catch (_) {
            return;
        }

        await new Promise((resolve) => {
            global.setTimeout(resolve, 360);
        });
    }

    async function showMonitorListModal() {
        removeMonitorListModal();

        const lblTitle = t('sidebar.areaMonitor.listModalTitle') || 'Monitored areas';
        const lblLoading = t('sidebar.areaMonitor.listLoading') || 'Loading monitored areas...';
        const lblEmpty = t('sidebar.areaMonitor.listEmpty') || 'No monitored areas yet.';
        const lblError = t('sidebar.areaMonitor.listError') || 'Failed to load monitored areas.';
        const lblParcelCount = t('sidebar.areaMonitor.listParcelCount', { count: 0 }) || '{{count}} parcels';

        const backdrop = document.createElement('div');
        backdrop.id = 'area-monitor-list-backdrop';
        backdrop.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.3);z-index:9999;';
        backdrop.addEventListener('click', removeMonitorListModal);
        document.body.appendChild(backdrop);

        const modal = document.createElement('div');
        modal.id = 'area-monitor-list-modal';
        modal.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #fff; border-radius: 12px; padding: 22px; z-index: 10000;
            box-shadow: 0 8px 32px rgba(0,0,0,0.18); min-width: 360px; max-width: 460px;
            max-height: min(70vh, 640px); overflow-y: auto;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;
        modal.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;">
                <h3 style="margin:0;font-size:18px;font-weight:600;">${escapeHtml(lblTitle)}</h3>
                <button id="am-list-close" title="Close" style="background:none;border:none;cursor:pointer;font-size:20px;color:#999;padding:0;line-height:1;">&times;</button>
            </div>
            <div id="am-list-content" style="display:flex;flex-direction:column;gap:10px;">
                <div style="font-size:13px;color:#666;">${escapeHtml(lblLoading)}</div>
            </div>
        `;

        document.body.appendChild(modal);

        const closeButton = modal.querySelector('#am-list-close');
        if (closeButton) {
            closeButton.addEventListener('click', removeMonitorListModal);
        }

        const content = modal.querySelector('#am-list-content');

        try {
            const monitors = await fetchAreaMonitorList();
            if (!document.getElementById('area-monitor-list-modal') || !content) return;

            content.innerHTML = '';
            if (!monitors.length) {
                const empty = document.createElement('div');
                empty.style.cssText = 'font-size:13px;color:#666;';
                empty.textContent = lblEmpty;
                content.appendChild(empty);
                return;
            }

            monitors.forEach(monitor => {
                const item = document.createElement('button');
                const createdLabel = formatMonitorDate(monitor.createdAt);
                const parcelText = (t('sidebar.areaMonitor.listParcelCount', { count: monitor.parcelCount }))
                    || lblParcelCount.replace('{{count}}', monitor.parcelCount);
                item.type = 'button';
                item.style.cssText = `
                    width:100%;text-align:left;padding:12px 14px;border:1px solid #d9dee5;border-radius:10px;
                    background:#fff;cursor:pointer;display:flex;flex-direction:column;gap:4px;
                `;
                item.innerHTML = `
                    <div style="font-size:14px;font-weight:600;color:#1f2937;">${escapeHtml(monitor.name || `Area ${monitor.id}`)}</div>
                    <div style="font-size:12px;color:#6b7280;">${escapeHtml(parcelText)}</div>
                    ${createdLabel ? `<div style="font-size:11px;color:#9ca3af;">${escapeHtml(createdLabel)}</div>` : ''}
                `;
                item.addEventListener('click', async () => {
                    await prepareMonitorSelection();

                    if (global.AreaMonitorRouting && typeof global.AreaMonitorRouting.openMonitor === 'function') {
                        global.AreaMonitorRouting.openMonitor(monitor.id);
                    } else if (global.AreaMonitorRouting && typeof global.AreaMonitorRouting.loadMonitor === 'function') {
                        const basePath = window.location.pathname.replace(/\/monitors\/\d+\/?$/, '');
                        const normalizedBasePath = basePath.endsWith('/') ? basePath : `${basePath}/`;
                        window.history.pushState({ monitorId: monitor.id }, '', `${window.location.origin}${normalizedBasePath}monitors/${monitor.id}`);
                        global.AreaMonitorRouting.loadMonitor(monitor.id, { fitBounds: true });
                    }
                });
                content.appendChild(item);
            });
        } catch (error) {
            if (!document.getElementById('area-monitor-list-modal') || !content) return;
            content.innerHTML = `<div style="font-size:13px;color:#d32f2f;">${escapeHtml(lblError)}</div>`;
            console.error('Failed to load area monitor list:', error);
        }
    }

    // --- Utils ---

    function showToast(message) {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            background: #333; color: #fff; padding: 10px 20px; border-radius: 8px;
            font-size: 13px; z-index: 20000; pointer-events: none;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3500);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

    function computePolygonAreaSqm(polygon) {
        if (!polygon || typeof global.turf === 'undefined' || typeof global.turf.area !== 'function') {
            return 0;
        }
        try {
            return global.turf.area(polygon);
        } catch (err) {
            console.warn('[area-monitor] failed to compute polygon area:', err);
            return 0;
        }
    }

    // --- Plan / paint-mode helpers ---

    let _planDataLoaded = false;
    function isPlanLoaded() { return _planDataLoaded; }

    function setDrawFromPlanEnabled(enabled) {
        const btn = document.getElementById('areaMonitorFromPlanButton');
        if (!btn) return;
        btn.disabled = !enabled;
        btn.style.opacity = enabled ? '' : '0.4';
        btn.style.cursor = enabled ? '' : 'not-allowed';
    }

    function setAmPlanToggleLoading(loading) {
        const lbl = document.getElementById('amCityPlanLabel');
        if (!lbl) return;
        if (loading) {
            lbl._origText = lbl._origText || lbl.textContent;
            lbl.textContent = t('sidebar.areaMonitor.fromPlanLoading') || 'Loading...';
        } else if (lbl._origText) {
            lbl.textContent = lbl._origText;
            delete lbl._origText;
        }
    }

    function activatePaintMode() {
        if (typeof global.isZoomWithinParcelRange === 'function' && !global.isZoomWithinParcelRange()) {
            showToast(t('sidebar.areaMonitor.zoomInFirst') || 'Zoom in to parcel level before drawing from the plan.');
            return;
        }
        const fromPlanBtn = document.getElementById('areaMonitorFromPlanButton');
        if (fromPlanBtn) fromPlanBtn.classList.add('active');
        // Disable "Draw freely" while in paint mode
        const drawBtn = document.getElementById('areaMonitorDrawButton');
        if (drawBtn) { drawBtn.disabled = true; drawBtn.style.opacity = '0.4'; drawBtn.style.cursor = 'not-allowed'; }
        // Register before activate() — event may fire synchronously if plan is already loaded
        global.addEventListener('planVerticesReady', onPlanVerticesReady, { once: true });
        if (global.AreaMonitorPaint) global.AreaMonitorPaint.activate();
        updateStatus(t('sidebar.areaMonitor.drawingHint') || 'Click plan vertices to build a polygon. Click the green vertex to close. Press Esc to cancel.');
    }

    function onPlanVerticesReady() { /* vertices rendered; button state already set */ }

    function deactivatePaintMode() {
        global.removeEventListener('planVerticesReady', onPlanVerticesReady);
        if (global.AreaMonitorPaint) global.AreaMonitorPaint.deactivate();
        const fromPlanBtn = document.getElementById('areaMonitorFromPlanButton');
        if (fromPlanBtn) fromPlanBtn.classList.remove('active');
        // Restore "Draw freely"
        const drawBtn = document.getElementById('areaMonitorDrawButton');
        if (drawBtn) { drawBtn.disabled = false; drawBtn.style.opacity = ''; drawBtn.style.cursor = ''; }
        clearStatus();
    }

    // Wire all area monitor controls once the DOM is ready.
    function wireAreaMonitorControls() {
        const planToggle  = document.getElementById('amCityPlanToggle');
        const roadsToggle = document.getElementById('showGovernmentRoadPlan');
        const drawFreeBtn = document.getElementById('areaMonitorDrawButton');
        const fromPlanBtn = document.getElementById('areaMonitorFromPlanButton');

        // City road plan toggle
        if (planToggle) {
            planToggle.addEventListener('change', () => {
                if (roadsToggle && roadsToggle.checked !== planToggle.checked) {
                    roadsToggle.checked = planToggle.checked;
                    roadsToggle.dispatchEvent(new Event('change'));
                }
                if (planToggle.checked) {
                    setAmPlanToggleLoading(true);
                } else {
                    _planDataLoaded = false;
                    setAmPlanToggleLoading(false);
                    setDrawFromPlanEnabled(false);
                    if (global.AreaMonitorPaint && global.AreaMonitorPaint.isActive()) deactivatePaintMode();
                }
            });
        }

        // Keep AM toggle in sync when Roads section checkbox changes externally
        if (roadsToggle && planToggle) {
            roadsToggle.addEventListener('change', () => {
                if (planToggle.checked !== roadsToggle.checked) planToggle.checked = roadsToggle.checked;
            });
        }

        // Initialise if plan is already on at page load
        if (roadsToggle && roadsToggle.checked && planToggle) {
            planToggle.checked = true;
            const l = global.governmentRoadPlanLayer;
            if (l && typeof l.getLayers === 'function' && l.getLayers().length > 0) {
                _planDataLoaded = true;
                setDrawFromPlanEnabled(true);
            }
        }

        // Plan loaded / cleared events (dispatched from government-roads.js)
        global.addEventListener('governmentPlanLoaded', (e) => {
            const hasData = !!(e.detail && e.detail.featureCount > 0);
            _planDataLoaded = hasData;
            setAmPlanToggleLoading(false);
            const drawingActive = (global.AreaMonitorDraw && global.AreaMonitorDraw.isActive()) ||
                                  (global.AreaMonitorPaint && global.AreaMonitorPaint.isActive());
            setDrawFromPlanEnabled(hasData && !drawingActive);
        });

        global.addEventListener('governmentPlanCleared', () => {
            _planDataLoaded = false;
            setAmPlanToggleLoading(false);
            setDrawFromPlanEnabled(false);
            if (planToggle) planToggle.checked = false;
            if (roadsToggle) roadsToggle.checked = false;
        });

        // Draw freely button
        if (drawFreeBtn) {
            drawFreeBtn.addEventListener('click', () => {
                if (global.AreaMonitorDraw && global.AreaMonitorDraw.isActive()) {
                    global.AreaMonitorDraw.deactivate();
                } else {
                    global.AreaMonitorDraw && global.AreaMonitorDraw.activate();
                }
            });
        }

        // Draw from plan button
        if (fromPlanBtn) {
            fromPlanBtn.addEventListener('click', () => {
                if (global.AreaMonitorPaint && global.AreaMonitorPaint.isActive()) {
                    deactivatePaintMode();
                } else {
                    activatePaintMode();
                }
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireAreaMonitorControls);
    } else {
        wireAreaMonitorControls();
    }

    function updateStatus(msg) {
        if (typeof window.updateStatus === 'function') window.updateStatus(msg);
    }

    function clearStatus() {
        if (typeof window.updateStatus === 'function') window.updateStatus('');
    }

    // --- Event wiring ---

    global.addEventListener('areaMonitorDrawComplete', (e) => {
        if (e.detail?.source === 'paint') {
            deactivatePaintMode();
        } else {
            setDrawButtonActive(false);
        }
        clearStatus();
        showCreationPanel(e.detail);
    });

    global.addEventListener('areaMonitorDrawCancel', () => {
        setDrawButtonActive(false);
        clearStatus();
    });

    global.addEventListener('areaMonitorDrawStart', () => {
        setDrawButtonActive(true);
        updateStatus(t('sidebar.areaMonitor.drawingHint') || 'Click on the map to draw a polygon. Click the first point to close. Press Esc to cancel.');
    });

    // Public API
    global.AreaMonitorUI = {
        fetchAreaMonitorList,
        showCreationPanel,
        removeCreationPanel,
        showDetailPanel,
        removeDetailPanel,
        showMonitorListModal,
        removeMonitorListModal,
        fetchAreaMonitor,
        showToast
    };

})(typeof window !== 'undefined' ? window : globalThis);
