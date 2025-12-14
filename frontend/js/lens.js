(function () {
    const STORAGE_KEY = 'lensEntries';
    const DEFAULT_LENS_ENTRIES = [
        { address: '0xfCF94DD41B2B5d6C887a30273F995d01bacA1A45', name: 'University of Leaston' },
        { address: '0xAA2530fe1682190FE63440f5eE8C602108f46790', name: 'Danburg Chamber of Layers' },
        { address: '0xb083c11D5Aa7D0f9CAa907227166417637BA85C9', name: 'dr. Peter Frughnachter' }
    ];
    const COLOR_PALETTE = ['#ff5252', '#ffa726', '#ffd54f', '#81c784', '#4dd0e1', '#42a5f5', '#7e57c2', '#ba68c8', '#8d6e63', '#bdbdbd'];

    const ATTESTIFY_BASE_URLS = Object.freeze({
        development: 'http://localhost:3000/',
        production: 'https://attestify.network/'
    });

    function formatTemplate(template, params = {}) {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (match, key1, key2) => {
            const key = key1 || key2;
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    }

    function getI18nApi() {
        return (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    }

    function translateLens(key, fallback, params = {}) {
        const api = getI18nApi();
        if (api && typeof api.t === 'function') {
            return api.t(key, params);
        }
        return formatTemplate(fallback, params);
    }

    function applyLensTranslations(root) {
        const api = getI18nApi();
        if (api && typeof api.applyTranslations === 'function') {
            api.applyTranslations(root);
        }
    }

    function resolveAttestifyBaseUrl() {
        const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
        if (!globalScope) {
            return ATTESTIFY_BASE_URLS.production;
        }

        const pickString = (...candidates) => candidates.find(v => typeof v === 'string' && v.trim());

        const explicit = pickString(
            globalScope.AttestifyNetworbaseUrl,
            globalScope.AttestifyNetworkBaseUrl,
            globalScope.ATTESTIFY_BASE_URL,
            globalScope.ATTESTIFY_URL
        );
        if (explicit) {
            return explicit.trim();
        }

        const hostname = (globalScope.location && typeof globalScope.location.hostname === 'string')
            ? globalScope.location.hostname.toLowerCase()
            : '';
        const isLocalHost = hostname === 'localhost'
            || hostname === '127.0.0.1'
            || hostname === '0.0.0.0'
            || hostname.endsWith('.local');
        const env = globalScope.current_environment || (isLocalHost ? 'development' : 'production');

        if (env === 'development') {
            const devOverride = pickString(
                globalScope.AttestifyNetworkDevBaseUrl,
                globalScope.ATTESTIFY_DEV_BASE_URL,
                globalScope.ATTESTIFY_DEV_URL
            );
            if (devOverride) {
                return devOverride.trim();
            }
            return ATTESTIFY_BASE_URLS.development;
        }

        const prodOverride = pickString(
            globalScope.AttestifyNetworkProdBaseUrl,
            globalScope.ATTESTIFY_PROD_BASE_URL,
            globalScope.ATTESTIFY_PROD_URL
        );
        if (prodOverride) {
            return prodOverride.trim();
        }
        return ATTESTIFY_BASE_URLS.production;
    }

    let lensEntries = loadLensEntries();

    function loadLensEntries() {
        const fallback = DEFAULT_LENS_ENTRIES.slice();
        const raw = readFromStorage();
        if (!raw) return fallback;
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return sanitizeEntries(parsed);
            }
        } catch (_) {
            // Ignore parse errors and fall back to defaults
        }
        return fallback;
    }

    function sanitizeEntries(entries) {
        return (entries || []).map(item => {
            if (typeof item === 'string') {
                return { address: item.trim(), name: '' };
            }
            return {
                address: (item && (item.address || item.addr || item.wallet || item.value)) ? String(item.address || item.addr || item.wallet || item.value).trim() : '',
                name: (item && item.name) ? String(item.name).trim() : ''
            };
        }).filter(entry => entry.address || entry.name);
    }

    function readFromStorage() {
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage.getItem) {
                return PersistentStorage.getItem(STORAGE_KEY);
            }
            if (typeof window !== 'undefined' && window.localStorage) {
                return window.localStorage.getItem(STORAGE_KEY);
            }
        } catch (_) {
            // Ignore storage issues
        }
        return null;
    }

    function writeToStorage(entries) {
        const payload = JSON.stringify(entries || []);
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage.setItem) {
                PersistentStorage.setItem(STORAGE_KEY, payload);
                return;
            }
            if (typeof window !== 'undefined' && window.localStorage) {
                window.localStorage.setItem(STORAGE_KEY, payload);
            }
        } catch (_) {
            // Swallow storage write errors
        }
    }

    function updateLensEntries(entries) {
        const cleaned = sanitizeEntries(entries);
        if (cleaned.length === 0) {
            cleaned.push({ address: '', name: '' });
        }
        lensEntries = cleaned;
        writeToStorage(lensEntries);
        refreshLensPatternPreviews();
    }

    function getActiveLensEntries() {
        return lensEntries.slice();
    }

    function normalizeChainId(chainId) {
        if (chainId === undefined || chainId === null) return null;
        try {
            if (typeof chainId === 'bigint') return chainId.toString();
            const str = chainId.toString().trim();
            if (str.startsWith('0x')) {
                return BigInt(str).toString();
            }
            return str;
        } catch (_) {
            return null;
        }
    }

    function getCurrentChainId() {
        try {
            const state = window.walletManager && typeof window.walletManager.getState === 'function'
                ? window.walletManager.getState()
                : null;
            if (state && state.chainId !== undefined && state.chainId !== null) {
                return normalizeChainId(state.chainId);
            }
        } catch (_) { }
        return null;
    }

    function getExplorerBaseUrlForChain(chainId) {
        const id = chainId ? chainId.toString() : '';
        switch (id) {
            case '1':
                return 'https://etherscan.io';
            case '11155111':
                return 'https://sepolia.etherscan.io';
            case '8453':
                return 'https://basescan.org';
            case '84532':
            case '0x14a34':
                return 'https://sepolia.basescan.org';
            default:
                return null;
        }
    }

    function buildEtherscanAddressUrl(address) {
        if (!address) return null;
        const chainId = getCurrentChainId();
        const base = getExplorerBaseUrlForChain(chainId) || 'https://etherscan.io';
        return `${base}/address/${address}`;
    }

    function buildAttestifyUrl(address) {
        if (!address) return null;
        try {
            const base = resolveAttestifyBaseUrl();
            const url = new URL(`address/${address}`, base);
            return url.toString();
        } catch (_) {
            return null;
        }
    }

    function generateLensPatternSvg(entries = lensEntries) {
        const normalized = sanitizeEntries(entries);
        const filtered = normalized.filter(item => item && item.address && String(item.address).trim());
        if (filtered.length === 0) {
            const emptyLabel = translateLens('modal.lens.emptyPattern', 'No lens');
            return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='0' y='0' width='100' height='100' fill='#000' /><text x='50' y='55' fill='#777' font-size='12' text-anchor='middle'>${emptyLabel}</text></svg>`;
        }

        const barWidth = 100 / filtered.length;
        const rects = filtered.map((entry, idx) => {
            const raw = String(entry.address || '').trim();
            const trimmed = raw.startsWith('0x') ? raw.slice(2, 8) : raw.slice(0, 6);
            const hex = parseInt(trimmed || '0', 16);
            const paletteIdx = Number.isFinite(hex) ? hex % COLOR_PALETTE.length : idx % COLOR_PALETTE.length;
            const x = idx * barWidth;
            return `<rect x='${x}' y='0' width='${barWidth}' height='100' fill='${COLOR_PALETTE[paletteIdx]}' />`;
        }).join('');

        return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='0' y='0' width='100' height='100' fill='#000' />${rects}</svg>`;
    }

    function getLensPatternDataUrl(entries = lensEntries) {
        const svg = generateLensPatternSvg(entries);
        return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    }

    function refreshLensPatternPreviews() {
        const patternUrl = getLensPatternDataUrl();
        document.querySelectorAll('[data-lens-pattern]').forEach(el => {
            if (el.tagName === 'IMG') {
                el.src = patternUrl;
            } else {
                el.style.backgroundImage = `url("${patternUrl}")`;
                el.style.backgroundSize = 'cover';
                el.style.backgroundRepeat = 'no-repeat';
                el.style.backgroundPosition = 'center';
            }
            el.setAttribute('aria-label', translateLens('modal.lens.patternAria', 'Lens pattern preview'));
            el.setAttribute('title', translateLens('modal.lens.patternTitle', 'Lens pattern'));
        });
    }

    function renderLensList(container, entries = getActiveLensEntries(), options = {}) {
        if (!container) return;
        const readOnly = options.readOnly === true;
        // Preserve empty entries for editing - don't filter them out
        const list = (entries || []).map(item => {
            if (typeof item === 'string') {
                return { address: item.trim(), name: '' };
            }
            return {
                address: (item && (item.address || item.addr || item.wallet || item.value)) ? String(item.address || item.addr || item.wallet || item.value).trim() : '',
                name: (item && item.name) ? String(item.name).trim() : ''
            };
        });
        container.innerHTML = '';

        list.forEach((entry, idx) => {
            const row = document.createElement('div');
            row.className = 'lens-row';

            const labelText = translateLens('modal.lens.addressLabel', 'Address {{index}}', { index: idx + 1 });
            const placeholderAddress = translateLens('modal.lens.placeholders.address', '0x... address');
            const placeholderName = translateLens('modal.lens.placeholders.name', 'Friendly name');
            const removeLabel = translateLens('modal.lens.removeAddress', 'Remove address');
            const etherscanLabel = translateLens('modal.lens.links.etherscan', 'Etherscan ↗');
            const attestifyLabel = translateLens('modal.lens.links.attestify', 'Attestify ↗');

            const header = document.createElement('div');
            header.className = 'lens-row-header';

            const label = document.createElement('div');
            label.className = 'lens-row-label';
            label.textContent = labelText;
            label.setAttribute('data-i18n-key', 'modal.lens.addressLabel');
            label.setAttribute('data-i18n-params', JSON.stringify({ index: idx + 1 }));

            const addressInput = document.createElement('input');
            addressInput.type = 'text';
            addressInput.className = 'lens-input lens-address-input';
            addressInput.placeholder = placeholderAddress;
            addressInput.setAttribute('data-i18n-key', 'modal.lens.placeholders.address');
            addressInput.setAttribute('data-i18n-attr', 'placeholder');
            addressInput.value = entry.address || '';
            if (readOnly) {
                addressInput.disabled = true;
                addressInput.readOnly = true;
            } else {
                addressInput.addEventListener('input', event => {
                    const nextEntries = getActiveLensEntries();
                    // Ensure we have enough entries (in case idx is out of bounds)
                    while (nextEntries.length <= idx) {
                        nextEntries.push({ address: '', name: '' });
                    }
                    nextEntries[idx].address = event.target.value.trim();
                    // Update directly to preserve empty entries during editing
                    lensEntries = nextEntries;
                    writeToStorage(lensEntries);
                    refreshLensPatternPreviews();
                });
            }

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'lens-input lens-name-input';
            nameInput.placeholder = placeholderName;
            nameInput.setAttribute('data-i18n-key', 'modal.lens.placeholders.name');
            nameInput.setAttribute('data-i18n-attr', 'placeholder');
            nameInput.value = entry.name || '';
            if (readOnly) {
                nameInput.disabled = true;
                nameInput.readOnly = true;
            } else {
                nameInput.addEventListener('input', event => {
                    const nextEntries = getActiveLensEntries();
                    // Ensure we have enough entries (in case idx is out of bounds)
                    while (nextEntries.length <= idx) {
                        nextEntries.push({ address: '', name: '' });
                    }
                    nextEntries[idx].name = event.target.value.trim();
                    // Update directly to preserve empty entries during editing
                    lensEntries = nextEntries;
                    writeToStorage(lensEntries);
                    refreshLensPatternPreviews();
                });
            }

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'lens-remove-btn';
            removeBtn.textContent = '×';
            removeBtn.title = removeLabel;
            removeBtn.setAttribute('data-i18n-key', 'modal.lens.removeAddress');
            removeBtn.setAttribute('data-i18n-attr', 'title');
            if (!readOnly) {
                removeBtn.addEventListener('click', () => {
                    const nextEntries = getActiveLensEntries();
                    nextEntries.splice(idx, 1);
                    updateLensEntries(nextEntries);
                    renderLensList(container, getActiveLensEntries(), options);
                });
            }

            const actions = document.createElement('div');
            actions.className = 'lens-inline-actions';

            const etherscanLink = document.createElement('a');
            etherscanLink.className = 'lens-link-btn';
            etherscanLink.textContent = etherscanLabel;
            etherscanLink.setAttribute('data-i18n-key', 'modal.lens.links.etherscan');
            etherscanLink.target = '_blank';
            etherscanLink.rel = 'noreferrer noopener';

            const attestifyLink = document.createElement('a');
            attestifyLink.className = 'lens-link-btn';
            attestifyLink.textContent = attestifyLabel;
            attestifyLink.setAttribute('data-i18n-key', 'modal.lens.links.attestify');
            attestifyLink.target = '_blank';
            attestifyLink.rel = 'noreferrer noopener';

            function updateLinks(addressValue) {
                const etherscanUrl = buildEtherscanAddressUrl(addressValue);
                const attestifyUrl = buildAttestifyUrl(addressValue);

                if (etherscanUrl) {
                    etherscanLink.href = etherscanUrl;
                    etherscanLink.classList.remove('lens-link-btn--disabled');
                } else {
                    etherscanLink.removeAttribute('href');
                    etherscanLink.classList.add('lens-link-btn--disabled');
                }

                if (attestifyUrl) {
                    attestifyLink.href = attestifyUrl;
                    attestifyLink.classList.remove('lens-link-btn--disabled');
                } else {
                    attestifyLink.removeAttribute('href');
                    attestifyLink.classList.add('lens-link-btn--disabled');
                }
            }

            updateLinks(entry.address || '');

            actions.appendChild(etherscanLink);
            actions.appendChild(attestifyLink);

            header.appendChild(label);
            if (!readOnly) {
                header.appendChild(removeBtn);
            }
            row.appendChild(header);
            row.appendChild(addressInput);
            row.appendChild(nameInput);
            row.appendChild(actions);
            container.appendChild(row);

            // Keep links in sync as user edits
            addressInput.addEventListener('input', () => {
                updateLinks(addressInput.value.trim());
            });
        });
        applyLensTranslations(container);
    }

    function showLensModal(options = {}) {
        closeLensModal();

        const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
        const readOnly = opts.readOnly === true;
        const sourceEntries = Array.isArray(opts.entries) ? sanitizeEntries(opts.entries) : getActiveLensEntries();

        const title = (typeof opts.title === 'string' && opts.title.trim())
            ? opts.title
            : translateLens(readOnly ? 'modal.lens.readOnlyTitle' : 'modal.lens.title', 'The lens through which I see the world 👓🏖️');
        const subtitle = (typeof opts.subtitle === 'string' && opts.subtitle.trim())
            ? opts.subtitle
            : translateLens(
                readOnly ? 'modal.lens.readOnlySubtitle' : 'modal.lens.subtitle',
                'These are the trusted addresses, whose attestations will be trusted for the purposes of determining owners of the parcels.'
            );
        const note = (typeof opts.note === 'string' && opts.note.trim())
            ? opts.note
            : (readOnly ? translateLens('modal.lens.readOnlyNote', 'This lens is baked into the proposal and cannot be edited.') : '');
        const closeLabel = translateLens('modal.lens.closeLabel', 'Close lens modal');
        const patternCaption = translateLens('modal.lens.patternCaption', 'Pattern updates automatically when you edit the list.');
        const addButtonLabel = translateLens('modal.lens.addButton', '+ Add address');
        const addButtonTitle = translateLens('modal.lens.addButtonTitle', 'Add trusted address');
        const patternAria = translateLens('modal.lens.patternAria', 'Lens pattern preview');
        const patternTitle = translateLens('modal.lens.patternTitle', 'Lens pattern');

        const overlay = document.createElement('div');
        overlay.className = 'lens-modal-overlay';
        overlay.innerHTML = `
            <div class="lens-modal${readOnly ? ' lens-modal--readonly' : ''}" role="dialog" aria-modal="true">
                <div class="lens-modal-header">
                    <div class="lens-modal-title-group">
                        <h2 class="lens-modal-title" data-i18n-key="modal.lens.title">${title}</h2>
                        <p class="lens-modal-subtitle" data-i18n-key="modal.lens.subtitle">${subtitle}</p>
                    </div>
                    <button type="button" class="lens-close-btn close-circle-btn close-circle-btn--lg" aria-label="${closeLabel}" data-i18n-key="modal.lens.closeLabel" data-i18n-attr="aria-label">&times;</button>
                </div>
                <div class="lens-modal-body">
                    <div class="lens-pattern-card">
                        <div class="lens-pattern-chip" data-lens-pattern aria-label="${patternAria}" title="${patternTitle}" data-i18n-key="modal.lens.patternAria" data-i18n-attr="aria-label"></div>
                        <div class="lens-pattern-caption" data-i18n-key="modal.lens.patternCaption">${patternCaption}</div>
                    </div>
                    ${note ? `<div class="lens-readonly-note" data-lens-note data-i18n-key="modal.lens.readOnlyNote">${note}</div>` : ''}
                    <div class="lens-list" id="lens-list"></div>
                    <div class="lens-actions">
                        <button type="button" class="lens-add-btn" id="lens-add-btn" title="${addButtonTitle}" data-i18n-key="modal.lens.addButton" data-i18n-attr="text">${addButtonLabel}</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        applyLensTranslations(overlay);

        const closeBtn = overlay.querySelector('.lens-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', closeLensModal);
        }
        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                closeLensModal();
            }
        });
        const listContainer = overlay.querySelector('#lens-list');
        renderLensList(listContainer, sourceEntries, { readOnly });

        const patternChip = overlay.querySelector('[data-lens-pattern]');
        if (patternChip) {
            try {
                const patternUrl = getLensPatternDataUrl(sourceEntries);
                patternChip.style.backgroundImage = `url("${patternUrl}")`;
                patternChip.style.backgroundSize = 'cover';
                patternChip.style.backgroundRepeat = 'no-repeat';
                patternChip.style.backgroundPosition = 'center';
            } catch (_) { }
        }

        if (note) {
            const noteEl = overlay.querySelector('[data-lens-note]');
            if (noteEl) {
                noteEl.textContent = note;
            }
        }

        if (!readOnly) {
            refreshLensPatternPreviews();
        }

        const addBtn = overlay.querySelector('#lens-add-btn');
        if (addBtn) {
            if (readOnly) {
                addBtn.disabled = true;
                addBtn.setAttribute('aria-disabled', 'true');
                addBtn.style.display = 'none';
            } else {
                addBtn.addEventListener('click', () => {
                    const nextEntries = getActiveLensEntries();
                    // Add a new empty entry
                    nextEntries.push({ address: '', name: '' });
                    // Update lensEntries directly to preserve empty entries
                    lensEntries = nextEntries;
                    writeToStorage(lensEntries);
                    // Render with the updated entries (including empty ones)
                    renderLensList(listContainer, lensEntries, { readOnly });
                    refreshLensPatternPreviews();
                    // Focus the last input field (the newly added one)
                    const inputs = listContainer ? listContainer.querySelectorAll('.lens-address-input') : [];
                    if (inputs && inputs.length) {
                        inputs[inputs.length - 1].focus();
                    }
                });
            }
        }
    }

    function closeLensModal() {
        // Clean up empty entries before closing
        const currentEntries = getActiveLensEntries();
        const cleaned = sanitizeEntries(currentEntries);
        if (cleaned.length !== currentEntries.length) {
            updateLensEntries(cleaned);
        }
        const overlay = document.querySelector('.lens-modal-overlay');
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
    }

    function hydrateFromStorage() {
        const raw = readFromStorage();
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    lensEntries = sanitizeEntries(parsed);
                }
            } catch (_) {
                lensEntries = DEFAULT_LENS_ENTRIES.slice();
            }
        }
        refreshLensPatternPreviews();
    }

    // Initial hydration when storage is ready
    if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ready && typeof PersistentStorage.ready.then === 'function') {
        PersistentStorage.ready.then(hydrateFromStorage);
    } else {
        hydrateFromStorage();
    }

    window.showLensModal = showLensModal;
    window.closeLensModal = closeLensModal;
    window.getLensEntries = getActiveLensEntries;
    window.getLensPatternDataUrl = getLensPatternDataUrl;
    window.refreshLensPatternPreviews = refreshLensPatternPreviews;
})();

