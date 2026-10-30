// View pills: top centre of the map, one pill per setting that changes how the map reads (Highlight
// by use, Highlight by ownership type), each naming what is on and with × to turn it off, so nobody
// forgets a highlight or has to go back to Layers for it. Also renders the Highlight by use ticks
// into every `[data-use-highlight]` host in Layers (the Buildings section in 2D, the model view's
// layers in 3D); the choice itself lives in building-use-highlight.js.
(function (global) {
    'use strict';
    const doc = global.document;
    const t = (key, params) => (global.i18n ? global.i18n.t(key, params) : key);
    const highlight = () => global.BuildingUseHighlight;

    let bar = null;

    const STOREY_KEYS = {
        residential: 'buildingUseHighlight.storey.residential', shop: 'buildingUseHighlight.storey.shop',
        office: 'buildingUseHighlight.storey.office', public: 'buildingUseHighlight.storey.public',
        industrial: 'buildingUseHighlight.storey.industrial', none: 'modal.singleBuilding.useNotStated'
    };
    const storeyLabel = category => t(STOREY_KEYS[category]);

    // Each pill: its label while on (null while off), and how × turns it off. `twoD` hides it in the
    // model and photo views, where the highlight draws nothing.
    const PILLS = [
        {
            key: 'use',
            label: () => {
                const uses = highlight().selected();
                return uses.length ? t('buildingUseHighlight.pill', { uses: uses.map(storeyLabel).join(', ') }) : null;
            },
            clear: () => highlight().clear()
        },
        {
            key: 'ownership',
            twoD: true,
            label: () => {
                const types = checkedOwnershipBoxes().map(box => box.closest('label')?.textContent.trim()).filter(Boolean);
                return types.length ? t('buildingUseHighlight.ownershipPill', { types: types.join(', ') }) : null;
            },
            clear: () => checkedOwnershipBoxes().forEach(box => {
                box.checked = false;
                box.dispatchEvent(new Event('change', { bubbles: true }));
            })
        }
    ];

    function checkedOwnershipBoxes() {
        return Array.from(doc.querySelectorAll('.ownership-type-checkbox')).filter(box => box.checked);
    }

    function ensureBar() {
        if (bar && bar.isConnected) return bar;
        const anchor = doc.getElementById('map-shell-top-right');
        if (!anchor || !anchor.parentElement) return null;
        bar = doc.createElement('div');
        bar.id = 'map-view-pills';
        bar.className = 'map-view-pills';
        anchor.parentElement.insertBefore(bar, anchor);
        return bar;
    }

    function renderPills() {
        const host = ensureBar();
        if (!host) return;
        host.replaceChildren(...PILLS.map(pill => {
            const text = pill.label();
            if (!text) return null;
            const el = doc.createElement('div');
            el.className = `map-view-pill${pill.twoD ? ' map-view-pill--2d' : ''}`;
            el.dataset.viewPill = pill.key;
            el.setAttribute('role', 'status');
            const label = doc.createElement('span');
            label.className = 'map-view-pill-label';
            label.textContent = text;
            const close = doc.createElement('button');
            close.type = 'button';
            close.className = 'close-circle-btn map-view-pill-close';
            close.textContent = '×';
            close.setAttribute('aria-label', t('buildingUseHighlight.off'));
            close.title = t('buildingUseHighlight.off');
            close.addEventListener('click', () => pill.clear());
            el.append(label, close);
            return el;
        }).filter(Boolean));
    }

    // The Highlight by use ticks, the list doubling as the legend.
    function renderUseOptions() {
        const api = highlight();
        doc.querySelectorAll('[data-use-highlight]').forEach(host => {
            const title = doc.createElement('div');
            title.className = 'control-group-title';
            title.textContent = t('buildingUseHighlight.highlight');
            const group = doc.createElement('div');
            group.className = 'checkbox-group';
            api.CATEGORIES.forEach(category => {
                const label = doc.createElement('label');
                const input = doc.createElement('input');
                input.type = 'checkbox';
                input.className = 'use-highlight-checkbox';
                input.dataset.useHighlightCategory = category;
                input.checked = api.selected().includes(category);
                input.addEventListener('change', () => api.setSelected(category, input.checked));
                const swatch = doc.createElement('span');
                swatch.className = 'use-legend-swatch';
                swatch.setAttribute('aria-hidden', 'true');
                swatch.style.setProperty('--legend-swatch-color', api.COLORS[category]);
                const text = doc.createElement('span');
                text.textContent = storeyLabel(category);
                label.append(input, swatch, text);
                group.appendChild(label);
            });
            const note = doc.createElement('p');
            note.className = 'sheet-note';
            note.textContent = t('buildingUseHighlight.note');
            host.replaceChildren(title, group, note);
        });
    }

    function syncUseOptions() {
        const chosen = new Set(highlight().selected());
        doc.querySelectorAll('.use-highlight-checkbox').forEach(input => {
            input.checked = chosen.has(input.dataset.useHighlightCategory);
        });
    }

    function init() {
        if (!highlight()) throw new Error('view-pills.js needs building-use-highlight.js');
        renderUseOptions();
        renderPills();
        highlight().onChange(() => { syncUseOptions(); renderPills(); });
        doc.addEventListener('change', event => {
            if (event.target?.classList?.contains('ownership-type-checkbox')) renderPills();
        });
        global.i18n?.onChange?.(() => { renderUseOptions(); renderPills(); });
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
    else init();

    global.ViewPills = { refresh: renderPills };
})(window);
