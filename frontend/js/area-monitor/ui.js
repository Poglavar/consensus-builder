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
        btn.setAttribute('aria-pressed', String(Boolean(active)));
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
        panel.className = 'area-monitor-creation-panel';
        panel.setAttribute('role', 'dialog');

        const lblTitle = t('sidebar.areaMonitor.createTitle') || 'New Area Monitor';
        const lblName = t('sidebar.areaMonitor.nameLabel') || 'Name';
        const lblPlaceholder = t('sidebar.areaMonitor.namePlaceholder') || 'e.g. Slavonska extension';
        const polygonDerived = parcels.length === 0 && !!polygon;
        const lblParcels = polygonDerived
            ? (t('sidebar.areaMonitor.parcelsFromPolygon') || 'Parcels will be resolved from the polygon when created.')
            : (t('sidebar.areaMonitor.parcelsFound', { count: parcels.length }) || `${parcels.length} parcels found`);
        const createDisabled = !polygonDerived && parcels.length === 0;
        const lblCancel = t('sidebar.areaMonitor.cancelButton') || 'Cancel';
        const lblCreate = t('sidebar.areaMonitor.createButton') || 'Create';

        // Looks from css/map-shell.css (.area-monitor-creation-panel) and the shared controls.
        panel.innerHTML = `
            <h3 id="am-creation-title" class="area-monitor-creation-panel__title">${escapeHtml(lblTitle)}</h3>
            <div class="area-monitor-creation-panel__field">
                <label for="am-name" class="area-monitor-creation-panel__label">${escapeHtml(lblName)}</label>
                <input id="am-name" class="area-monitor-creation-panel__input" type="text" placeholder="${escapeAttr(lblPlaceholder)}" maxlength="100" />
            </div>
            <p class="area-monitor-creation-panel__parcels"><strong>${escapeHtml(lblParcels)}</strong></p>
            <div class="cb-actions cb-actions--end area-monitor-creation-panel__actions">
                <button type="button" id="am-cancel" class="btn">${escapeHtml(lblCancel)}</button>
                <button type="button" id="am-create" class="btn btn-primary" ${createDisabled ? 'disabled' : ''}>${escapeHtml(lblCreate)}</button>
            </div>
            <p id="am-error" class="area-monitor-creation-panel__error" role="alert" hidden></p>
        `;

        panel.setAttribute('aria-labelledby', 'am-creation-title');
        document.body.classList.add('area-monitor-creation-active');
        document.body.appendChild(panel);

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

            const createBtn = document.getElementById('am-create');
            createBtn.disabled = true;
            createBtn.textContent = t('sidebar.areaMonitor.creating') || 'Creating...';

            try {
                const monitor = await createAreaMonitor({
                    name,
                    polygon,
                    parcelIds,
                    eojnUrl: null,
                    skyscraperCityUrl: null
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
        document.body.classList.remove('area-monitor-creation-active');
    }

    function showPanelError(msg) {
        const el = document.getElementById('am-error');
        if (el) {
            el.textContent = msg;
            el.hidden = false;
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

    // One watched area: a selectable cb-option row (css/primitives.css).
    function createMonitorListItem(monitor) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'cb-option area-monitor-list-item';
        const icon = document.createElement('i');
        icon.className = 'cb-option__icon fa-solid fa-draw-polygon';
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'cb-option__text';
        const name = document.createElement('span');
        name.className = 'cb-option__title area-monitor-list-item__name';
        name.textContent = monitor.name || `Area ${monitor.id}`;
        const meta = document.createElement('span');
        meta.className = 'cb-option__desc area-monitor-list-item__meta';
        const parcelText = t('proposals.autoName.parcels', { count: monitor.parcelCount })
            || `${monitor.parcelCount} parcels`;
        const createdLabel = formatMonitorDate(monitor.createdAt);
        meta.textContent = [parcelText, createdLabel].filter(Boolean).join(' · ');
        text.append(name, meta);
        item.append(icon, text);
        item.addEventListener('click', () => openMonitorFromList(monitor.id));
        return item;
    }

    async function openMonitorFromList(monitorId) {
        await prepareMonitorSelection();
        if (global.AreaMonitorRouting && typeof global.AreaMonitorRouting.openMonitor === 'function') {
            global.AreaMonitorRouting.openMonitor(monitorId);
        } else if (global.AreaMonitorRouting && typeof global.AreaMonitorRouting.loadMonitor === 'function') {
            const basePath = window.location.pathname.replace(/\/monitors\/\d+\/?$/, '');
            const normalizedBasePath = basePath.endsWith('/') ? basePath : `${basePath}/`;
            window.history.pushState({ monitorId }, '', `${window.location.origin}${normalizedBasePath}monitors/${monitorId}`);
            global.AreaMonitorRouting.loadMonitor(monitorId, { fitBounds: true });
        }
    }

    let watchedAreasRequest = 0;
    function isActivitySheetOpen() {
        return global.MapShell?.isOpen?.('activity-sheet')
            || document.getElementById('activity-sheet')?.hidden === false;
    }

    function renderInlineMonitorMessage(host, message, kind = '') {
        host.replaceChildren();
        const note = document.createElement('div');
        note.className = `area-monitor-list-message${kind ? ` area-monitor-list-message--${kind}` : ''}`;
        note.textContent = message;
        host.appendChild(note);
    }

    async function refreshInlineMonitorList() {
        const host = document.getElementById('activity-watched-areas-list');
        if (!host || !isActivitySheetOpen()) return false;
        const requestId = ++watchedAreasRequest;
        const cityId = getCurrentCityId();
        renderInlineMonitorMessage(host, t('sidebar.areaMonitor.listLoading') || 'Loading monitored areas…');
        try {
            const monitors = await fetchAreaMonitorList();
            if (requestId !== watchedAreasRequest || !isActivitySheetOpen() || cityId !== getCurrentCityId()) return false;
            host.replaceChildren();
            if (!monitors.length) {
                renderInlineMonitorMessage(host, t('sidebar.areaMonitor.listEmpty') || 'No monitored areas yet.');
                return true;
            }
            const filter = document.createElement('input');
            filter.type = 'search';
            filter.className = 'area-monitor-list-filter';
            filter.placeholder = t('sidebar.areaMonitor.listFilterPlaceholder') || 'Filter by name';
            filter.setAttribute('aria-label', filter.placeholder);
            const list = document.createElement('div');
            list.className = 'area-monitor-list-items';
            const records = monitors.map(monitor => {
                const item = createMonitorListItem(monitor);
                item.dataset.monitorName = String(monitor.name || `Area ${monitor.id}`).toLowerCase();
                list.appendChild(item);
                return item;
            });
            const noMatch = document.createElement('div');
            noMatch.className = 'area-monitor-list-message';
            noMatch.textContent = t('sidebar.areaMonitor.listFilterEmpty') || 'No monitors match the filter.';
            noMatch.hidden = true;
            list.appendChild(noMatch);
            filter.addEventListener('input', () => {
                const query = filter.value.trim().toLowerCase();
                let matches = 0;
                records.forEach(item => {
                    const visible = !query || item.dataset.monitorName.includes(query);
                    item.hidden = !visible;
                    if (visible) matches += 1;
                });
                noMatch.hidden = matches > 0;
            });
            host.append(filter, list);
        } catch (error) {
            if (requestId !== watchedAreasRequest || !isActivitySheetOpen()) return false;
            renderInlineMonitorMessage(host, t('sidebar.areaMonitor.listError') || 'Failed to load monitored areas.', 'error');
            console.error('Failed to load watched areas:', error);
        }
        return true;
    }

    document.addEventListener('mapshell:sheetopened', event => {
        if (event.detail?.id === 'activity-sheet') refreshInlineMonitorList();
    });
    global.addEventListener('cityChanged', () => {
        if (isActivitySheetOpen()) refreshInlineMonitorList();
    });

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
            toggleButton.innerHTML = `<i class="fa-solid ${minimized ? 'fa-plus' : 'fa-minus'}" aria-hidden="true"></i>`;
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
        panel.className = 'info-panel right-screen-panel visible';

        const externalLinks = [];
        if (monitor.eojnUrl) {
            externalLinks.push(`<a class="cb-link cb-link--external" href="${escapeHtml(monitor.eojnUrl)}" target="_blank" rel="noopener noreferrer">EOJN</a>`);
        }
        if (monitor.skyscraperCityUrl) {
            externalLinks.push(`<a class="cb-link cb-link--external" href="${escapeHtml(monitor.skyscraperCityUrl)}" target="_blank" rel="noopener noreferrer">SkyscraperCity</a>`);
        }

        panel.innerHTML = `
            <div class="panel-header">
                <h3>${escapeHtml(monitor.name)}</h3>
                <div class="panel-header__actions">
                    <button id="am-detail-minimize" type="button" class="btn btn-quiet btn-icon area-monitor-detail-toggle"
                        aria-label="${escapeAttr(lblMinimize)}" title="${escapeAttr(lblMinimize)}" aria-controls="am-detail-body" aria-expanded="true"><i class="fa-solid fa-minus" aria-hidden="true"></i></button>
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
                ${externalLinks.length ? `<div class="cb-link-row area-monitor-detail-links">${externalLinks.join('')}</div>` : ''}
                <div class="cb-actions cb-actions--stack area-monitor-detail-actions">
                    <button id="am-share" type="button" class="btn btn-sm">
                        ${escapeHtml(lblCopyLink)}
                    </button>
                    <button id="am-list-others" type="button" class="btn btn-sm">
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
        return CbFormat.formatDate(dateValue);
    }

    // The "other monitors" list: the shared dialog (js/ui/dialogs.js). Its card keeps the
    // area-monitor-list-modal id and its close button am-list-close, which the tests address.
    let monitorListDialog = null;

    function removeMonitorListModal() {
        const dialog = monitorListDialog;
        monitorListDialog = null;
        if (dialog) dialog.close();
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

        // Fold the Activity sheet away on phones so the selected area has the map.
        if (global.MapShell) global.MapShell.closeSheets();
    }

    async function showMonitorListModal() {
        removeMonitorListModal();

        const lblTitle = t('sidebar.areaMonitor.listModalTitle') || 'Monitored areas';
        const lblLoading = t('sidebar.areaMonitor.listLoading') || 'Loading monitored areas...';
        const lblEmpty = t('sidebar.areaMonitor.listEmpty') || 'No monitored areas yet.';
        const lblError = t('sidebar.areaMonitor.listError') || 'Failed to load monitored areas.';
        const lblFilterPlaceholder = t('sidebar.areaMonitor.listFilterPlaceholder') || 'Filter by name';
        const lblFilterEmpty = t('sidebar.areaMonitor.listFilterEmpty') || 'No monitors match the filter.';

        // The title and filter stay at the top; only the list scrolls. The dialog keeps one height
        // (css/area-monitor-list.css) so it does not move as the filter shortens the list.
        const filterInput = document.createElement('input');
        filterInput.id = 'am-list-filter';
        filterInput.type = 'search';
        filterInput.className = 'area-monitor-list-filter';
        filterInput.autocomplete = 'off';
        filterInput.placeholder = lblFilterPlaceholder;
        filterInput.setAttribute('aria-label', lblFilterPlaceholder);
        filterInput.hidden = true;

        const content = document.createElement('div');
        content.id = 'am-list-content';
        content.className = 'area-monitor-list-items';
        renderInlineMonitorMessage(content, lblLoading);

        const dialogApi = global.CbDialog.open({
            title: lblTitle,
            size: 'md',
            className: 'area-monitor-list-modal',
            bodyClassName: 'area-monitor-list-modal__body',
            body: [filterInput, content],
            onClose: () => { if (monitorListDialog === dialogApi) monitorListDialog = null; }
        });
        if (!dialogApi) return;
        monitorListDialog = dialogApi;
        dialogApi.dialog.id = 'area-monitor-list-modal';
        const closeButton = dialogApi.header && dialogApi.header.querySelector('.close-circle-btn');
        if (closeButton) closeButton.id = 'am-list-close';

        try {
            const monitors = await fetchAreaMonitorList();
            if (monitorListDialog !== dialogApi) return;

            if (!monitors.length) {
                renderInlineMonitorMessage(content, lblEmpty);
                return;
            }

            // Show the filter now that there is a list to filter. Filtering hides rows with the
            // hidden attribute, so the per-item click listeners stay wired across passes.
            content.replaceChildren();
            filterInput.hidden = false;
            filterInput.focus();

            const itemRecords = [];
            const noMatchEl = document.createElement('div');
            noMatchEl.id = 'am-list-no-match';
            noMatchEl.className = 'area-monitor-list-message';
            noMatchEl.hidden = true;
            noMatchEl.textContent = lblFilterEmpty;

            monitors.forEach(monitor => {
                const item = createMonitorListItem(monitor);
                content.appendChild(item);
                itemRecords.push({ element: item, name: (monitor.name || `Area ${monitor.id}`).toLowerCase() });
            });
            content.appendChild(noMatchEl);

            filterInput.addEventListener('input', () => {
                const query = filterInput.value.trim().toLowerCase();
                let matchCount = 0;
                itemRecords.forEach(({ element, name }) => {
                    const matches = !query || name.includes(query);
                    element.hidden = !matches;
                    if (matches) matchCount += 1;
                });
                noMatchEl.hidden = matchCount > 0;
            });
        } catch (error) {
            if (monitorListDialog !== dialogApi) return;
            renderInlineMonitorMessage(content, lblError, 'error');
            console.error('Failed to load area monitor list:', error);
        }
    }

    // --- Utils ---

    // An outcome goes out as a notice like every other (ephemerals.md).
    function showToast(message) {
        if (typeof window.showEphemeralMessage === 'function') window.showEphemeralMessage(message, 3500);
    }

    function escapeAttr(str) {
        return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // m² through the shared formatter; hectares and km² keep their fixed decimals, in the UI language.
    function formatArea(areaSqm) {
        if (!Number.isFinite(areaSqm) || areaSqm <= 0) {
            return CbFormat.formatArea(0);
        }
        if (areaSqm >= 1_000_000) {
            const digits = areaSqm >= 10_000_000 ? 1 : 2;
            return `${CbFormat.formatNumber(areaSqm / 1_000_000, { maxFractionDigits: digits, minFractionDigits: digits })}\u202fkm²`;
        }
        if (areaSqm >= 10_000) {
            const digits = areaSqm >= 100_000 ? 0 : 1;
            return `${CbFormat.formatNumber(areaSqm / 10_000, { maxFractionDigits: digits, minFractionDigits: digits })}\u202fha`;
        }
        return CbFormat.formatArea(areaSqm);
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

    // A disabled .btn already reads as inert (css/primitives.css).
    function setDrawFromPlanEnabled(enabled) {
        const btn = document.getElementById('areaMonitorFromPlanButton');
        if (!btn) return;
        btn.disabled = !enabled;
    }

    function setAmPlanToggleLoading(loading) {
        const lbl = document.getElementById('governmentRoadPlanLabel');
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
        if (fromPlanBtn) fromPlanBtn.setAttribute('aria-pressed', 'true');
        // Disable "Draw freely" while in paint mode
        const drawBtn = document.getElementById('areaMonitorDrawButton');
        if (drawBtn) drawBtn.disabled = true;
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
        if (fromPlanBtn) fromPlanBtn.setAttribute('aria-pressed', 'false');
        // Restore "Draw freely"
        const drawBtn = document.getElementById('areaMonitorDrawButton');
        if (drawBtn) drawBtn.disabled = false;
        clearStatus();
    }

    // Wire all area monitor controls once the DOM is ready.
    function wireAreaMonitorControls() {
        const roadsToggle = document.getElementById('showGovernmentRoadPlan');
        const drawFreeBtn = document.getElementById('areaMonitorDrawButton');
        const fromPlanBtn = document.getElementById('areaMonitorFromPlanButton');

        // The Roads section's government road plan is the plan "Draw from the plan" traces.
        if (roadsToggle) {
            roadsToggle.addEventListener('change', () => {
                if (roadsToggle.checked) {
                    setAmPlanToggleLoading(true);
                } else {
                    _planDataLoaded = false;
                    setAmPlanToggleLoading(false);
                    setDrawFromPlanEnabled(false);
                    if (global.AreaMonitorPaint && global.AreaMonitorPaint.isActive()) deactivatePaintMode();
                }
            });
        }

        // Initialise if plan is already on at page load
        if (roadsToggle && roadsToggle.checked) {
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

    global.addEventListener('areaMonitorDrawCancel', (event) => {
        if (event.detail?.source === 'paint') deactivatePaintMode();
        setDrawButtonActive(false);
        clearStatus();
    });

    global.addEventListener('areaMonitorDrawStart', (event) => {
        if (global.MapShell) global.MapShell.closeSheets();
        if (event.detail?.source !== 'paint') {
            setDrawButtonActive(true);
            updateStatus(t('sidebar.areaMonitor.drawingHint') || 'Click on the map to draw a polygon. Click the first point to close. Press Esc to cancel.');
        }
    });

    // Public API
    global.AreaMonitorUI = {
        fetchAreaMonitorList,
        refreshInlineMonitorList,
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
