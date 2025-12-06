(function () {
    const STORAGE_KEY = 'lensEntries';
    const DEFAULT_LENS_ENTRIES = [
        { address: '0xfCF94DD41B2B5d6C887a30273F995d01bacA1A45', name: 'University of Leaston' },
        { address: '0xAA2530fe1682190FE63440f5eE8C602108f46790', name: 'Danburg Chamber of Layers' },
        { address: '0xb083c11D5Aa7D0f9CAa907227166417637BA85C9', name: 'dr. Peter Frughnachter' }
    ];
    const COLOR_PALETTE = ['#ff5252', '#ffa726', '#ffd54f', '#81c784', '#4dd0e1', '#42a5f5', '#7e57c2', '#ba68c8', '#8d6e63', '#bdbdbd'];

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
        return (entries || []).map(item => ({
            address: (item && item.address) ? String(item.address).trim() : '',
            name: (item && item.name) ? String(item.name).trim() : ''
        }));
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

    function generateLensPatternSvg(entries = lensEntries) {
        const filtered = (entries || []).filter(item => item && item.address && String(item.address).trim());
        if (filtered.length === 0) {
            return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='0' y='0' width='100' height='100' fill='#000' /><text x='50' y='55' fill='#777' font-size='12' text-anchor='middle'>No lens</text></svg>`;
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
            el.setAttribute('aria-label', 'Lens pattern preview');
            el.setAttribute('title', 'Lens pattern');
        });
    }

    function renderLensList(container) {
        if (!container) return;
        container.innerHTML = '';

        getActiveLensEntries().forEach((entry, idx) => {
            const row = document.createElement('div');
            row.className = 'lens-row';

            const addressInput = document.createElement('input');
            addressInput.type = 'text';
            addressInput.className = 'lens-input lens-address-input';
            addressInput.placeholder = '0x... address';
            addressInput.value = entry.address || '';
            addressInput.addEventListener('input', event => {
                const nextEntries = getActiveLensEntries();
                nextEntries[idx].address = event.target.value.trim();
                updateLensEntries(nextEntries);
            });

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'lens-input lens-name-input';
            nameInput.placeholder = 'Friendly name';
            nameInput.value = entry.name || '';
            nameInput.addEventListener('input', event => {
                const nextEntries = getActiveLensEntries();
                nextEntries[idx].name = event.target.value.trim();
                updateLensEntries(nextEntries);
            });

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'lens-remove-btn';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove address';
            removeBtn.addEventListener('click', () => {
                const nextEntries = getActiveLensEntries();
                nextEntries.splice(idx, 1);
                updateLensEntries(nextEntries);
                renderLensList(container);
            });

            row.appendChild(addressInput);
            row.appendChild(nameInput);
            row.appendChild(removeBtn);
            container.appendChild(row);
        });
    }

    function showLensModal() {
        closeLensModal();

        const overlay = document.createElement('div');
        overlay.className = 'lens-modal-overlay';
        overlay.innerHTML = `
            <div class="lens-modal" role="dialog" aria-modal="true">
                <div class="lens-modal-header">
                    <div class="lens-modal-title-group">
                        <h2 class="lens-modal-title">The lens through which I see the world</h2>
                        <p class="lens-modal-subtitle">These are the trusted addresses, whose attestations will be trusted for the purposes of determining owners of the parcels.</p>
                    </div>
                    <button type="button" class="lens-close-btn close-circle-btn close-circle-btn--lg" aria-label="Close lens modal">&times;</button>
                </div>
                <div class="lens-modal-body">
                    <div class="lens-pattern-card">
                        <div class="lens-pattern-chip" data-lens-pattern></div>
                        <div class="lens-pattern-caption">Pattern updates automatically when you edit the list.</div>
                    </div>
                    <div class="lens-list" id="lens-list"></div>
                    <div class="lens-actions">
                        <button type="button" class="lens-add-btn" id="lens-add-btn" title="Add trusted address">+ Add address</button>
                    </div>
                </div>
                <div class="lens-modal-footer">
                    <button type="button" class="btn lens-close-footer-btn" id="lens-close-footer-btn">Close</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const closeBtn = overlay.querySelector('.lens-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', closeLensModal);
        }
        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                closeLensModal();
            }
        });
        const footerClose = overlay.querySelector('#lens-close-footer-btn');
        if (footerClose) {
            footerClose.addEventListener('click', closeLensModal);
        }

        const listContainer = overlay.querySelector('#lens-list');
        renderLensList(listContainer);
        refreshLensPatternPreviews();

        const addBtn = overlay.querySelector('#lens-add-btn');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                const nextEntries = getActiveLensEntries();
                nextEntries.push({ address: '', name: '' });
                updateLensEntries(nextEntries);
                renderLensList(listContainer);
                refreshLensPatternPreviews();
                const inputs = listContainer ? listContainer.querySelectorAll('.lens-address-input') : [];
                if (inputs && inputs.length) {
                    inputs[inputs.length - 1].focus();
                }
            });
        }
    }

    function closeLensModal() {
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

