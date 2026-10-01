// ui/map-shell.js — the floating map shell that replaced the left sidebar: the Layers/Settings
// buttons (top-right), the Proposals/Tools/Activity buttons (bottom-right), the Game pill
// (bottom-left) and the sheets they open. A sheet is a popover anchored to its button on desktop and
// a bottom sheet under 768px; one is open at a time, Esc and an outside click close it. The controls
// inside the sheets are the old sidebar's, moved with their ids and handlers (see UI-REWORK.md).
// placePopover is pure and exported for backend/test/frontend-ui-commands.test.js.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MapShell = api;
})(typeof window !== 'undefined' ? window : null, function (win) {
    'use strict';

    const MOBILE_QUERY = '(max-width: 767px)';
    const POPOVER_GAP = 8;
    const VIEWPORT_MARGIN = 10;

    // Where a popover goes relative to the button that opened it: below a button in the top half,
    // above one in the bottom half; right-aligned to a button in the right half, left-aligned
    // otherwise. Returns CSS offsets in px (null = auto) and the height left for it.
    function placePopover(anchor, viewport, options = {}) {
        const gap = typeof options.gap === 'number' ? options.gap : POPOVER_GAP;
        const margin = typeof options.margin === 'number' ? options.margin : VIEWPORT_MARGIN;
        const opensDown = (anchor.top + anchor.height / 2) < viewport.height / 2;
        const alignRight = (anchor.left + anchor.width / 2) > viewport.width / 2;
        const place = { top: null, bottom: null, left: null, right: null, maxHeight: 0 };
        if (opensDown) {
            place.top = anchor.bottom + gap;
            place.maxHeight = viewport.height - place.top - margin;
        } else {
            place.bottom = viewport.height - anchor.top + gap;
            place.maxHeight = anchor.top - gap - margin;
        }
        if (alignRight) place.right = Math.max(margin, viewport.width - anchor.right);
        else place.left = Math.max(margin, anchor.left);
        place.maxHeight = Math.max(120, Math.round(place.maxHeight));
        return place;
    }

    if (!win || !win.document) {
        return { placePopover };
    }

    const doc = win.document;
    const state = {
        openSheet: null,     // the open .map-sheet element
        trigger: null,       // the button that opened it
        initialized: false
    };

    const t = (key, fallback, params) => {
        const i18n = win.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params);
            if (value && value !== key) return value;
        }
        return fallback;
    };

    const isMobile = () => !!(win.matchMedia && win.matchMedia(MOBILE_QUERY).matches);
    const triggersFor = sheet => Array.from(doc.querySelectorAll(`[data-sheet-target="${sheet.id}"]`));

    function positionSheet(sheet, trigger) {
        const props = ['--sheet-top', '--sheet-bottom', '--sheet-left', '--sheet-right', '--sheet-max-height'];
        if (!trigger || isMobile()) {
            props.forEach(prop => sheet.style.removeProperty(prop));
            return;
        }
        const anchorEl = trigger.closest('[data-sheet-anchor]') || trigger;
        const rect = anchorEl.getBoundingClientRect();
        const place = placePopover(rect, { width: win.innerWidth, height: win.innerHeight });
        const px = value => (value === null ? 'auto' : `${Math.round(value)}px`);
        sheet.style.setProperty('--sheet-top', px(place.top));
        sheet.style.setProperty('--sheet-bottom', px(place.bottom));
        sheet.style.setProperty('--sheet-left', px(place.left));
        sheet.style.setProperty('--sheet-right', px(place.right));
        sheet.style.setProperty('--sheet-max-height', `${place.maxHeight}px`);
    }

    function setExpanded(sheet, expanded) {
        triggersFor(sheet).forEach(button => {
            button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            button.classList.toggle('is-active', expanded);
        });
    }

    function openSheet(sheetOrId, options = {}) {
        const sheet = typeof sheetOrId === 'string' ? doc.getElementById(sheetOrId) : sheetOrId;
        if (!sheet) throw new Error(`MapShell: no sheet ${sheetOrId}`);
        if (state.openSheet && state.openSheet !== sheet) closeSheet({ restoreFocus: false });
        const trigger = options.trigger || triggersFor(sheet)[0] || null;
        state.openSheet = sheet;
        state.trigger = trigger;
        sheet.hidden = false;
        positionSheet(sheet, trigger);
        setExpanded(sheet, true);
        doc.body.classList.add('map-sheet-open');
        if (options.focus !== false) {
            try { sheet.focus({ preventScroll: true }); } catch (_) { }
        }
        return sheet;
    }

    // Close the open sheet. Focus goes back to its button when the close came from the keyboard or
    // the close button; an outside click leaves focus where the person put it.
    function closeSheet(options = {}) {
        const sheet = state.openSheet;
        if (!sheet) return;
        const trigger = state.trigger;
        sheet.hidden = true;
        setExpanded(sheet, false);
        state.openSheet = null;
        state.trigger = null;
        doc.body.classList.remove('map-sheet-open');
        if (options.restoreFocus && trigger && typeof trigger.focus === 'function') {
            try { trigger.focus({ preventScroll: true }); } catch (_) { }
        }
    }

    function toggleSheet(sheetId, trigger) {
        const sheet = doc.getElementById(sheetId);
        if (!sheet) throw new Error(`MapShell: no sheet ${sheetId}`);
        if (state.openSheet === sheet) closeSheet({ restoreFocus: false });
        else openSheet(sheet, { trigger });
    }

    // The map needs the whole view (a proposal opens, 3D starts, a drawing tool takes over): fold
    // away whatever sheet is open. This is what callers used to do by collapsing the sidebar.
    function closeSheets() {
        closeSheet({ restoreFocus: false });
    }

    const isOpen = sheetId => !!(state.openSheet && state.openSheet.id === sheetId);

    function isVisible(el) {
        return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    }

    // Open the sheet that holds a control, scroll it into view and focus it. A control that is not
    // itself focusable while visible (the hidden native city <select> behind the custom dropdown)
    // hands focus to the first visible focusable thing beside it.
    function revealControl(id) {
        const el = doc.getElementById(id);
        if (!el) throw new Error(`MapShell: control #${id} is missing`);
        const sheet = el.closest('.map-sheet');
        if (sheet) openSheet(sheet, { focus: false });
        let target = el;
        if (!isVisible(el) && el.parentElement) {
            target = Array.from(el.parentElement.querySelectorAll('button, input, select, textarea, [tabindex]'))
                .find(candidate => candidate !== el && isVisible(candidate)) || el;
        }
        try { target.scrollIntoView({ block: 'nearest' }); } catch (_) { }
        try { target.focus({ preventScroll: true }); } catch (_) { }
        return target;
    }

    // Open the sheet holding a section (e.g. 'areaMonitor') and scroll the section into view.
    function revealSection(sectionName) {
        const section = Array.from(doc.querySelectorAll(`.accordion-section[data-section="${sectionName}"]`))
            .find(candidate => candidate.style.display !== 'none');
        if (!section) return null;
        const sheet = section.classList.contains('map-sheet') ? section : section.closest('.map-sheet');
        if (sheet) openSheet(sheet, { focus: false });
        try { section.scrollIntoView({ block: 'nearest' }); } catch (_) { }
        return section;
    }

    // A long-running action locks the section(s) it belongs to (not the whole UI, as the sidebar
    // overlay did): every control in them is disabled and a spinner line says why.
    function setSectionBusy(sectionName, busy, message) {
        doc.querySelectorAll(`.accordion-section[data-section="${sectionName}"]`).forEach(section => {
            const body = section.querySelector('.sheet-section-body') || section;
            let notice = section.querySelector(':scope .sheet-section-busy');
            if (busy) {
                section.classList.add('is-busy');
                section.setAttribute('aria-busy', 'true');
                body.querySelectorAll('input, button, select, textarea').forEach(el => {
                    if (el.hasAttribute('data-busy-prev-disabled')) return;
                    el.setAttribute('data-busy-prev-disabled', el.disabled ? '1' : '0');
                    el.disabled = true;
                });
                if (!notice) {
                    notice = doc.createElement('div');
                    notice.className = 'sheet-section-busy';
                    notice.setAttribute('role', 'status');
                    const spinner = doc.createElement('span');
                    spinner.className = 'sheet-section-busy__spinner';
                    spinner.setAttribute('aria-hidden', 'true');
                    const text = doc.createElement('span');
                    text.className = 'sheet-section-busy__text';
                    notice.appendChild(spinner);
                    notice.appendChild(text);
                    body.insertBefore(notice, body.firstChild);
                }
                notice.querySelector('.sheet-section-busy__text').textContent = message || '';
            } else {
                section.classList.remove('is-busy');
                section.removeAttribute('aria-busy');
                body.querySelectorAll('[data-busy-prev-disabled]').forEach(el => {
                    el.disabled = el.getAttribute('data-busy-prev-disabled') === '1';
                    el.removeAttribute('data-busy-prev-disabled');
                });
                if (notice) notice.remove();
            }
        });
    }

    // 3D keeps only what drives or navigates it usable: the Buildings and Proposals sections, and
    // the shell's own buttons (so every sheet can still be opened and closed). Everything else in
    // the sheets and the Game pill is disabled until 3D ends, remembering what was already disabled.
    const KEPT_IN_3D = ['buildings', 'proposals'];

    function setLockedFor3D(locked) {
        const scopes = Array.from(doc.querySelectorAll('.map-sheet, #game-pill'));
        if (locked) {
            scopes.forEach(scope => {
                scope.querySelectorAll('input, button, select, textarea').forEach(el => {
                    const section = el.closest('.accordion-section');
                    const kept = (section && KEPT_IN_3D.includes(section.dataset.section))
                        || el.hasAttribute('data-sheet-close') || el.hasAttribute('data-sheet-target');
                    if (kept) return;
                    if (!el.disabled) el.setAttribute('data-three-disabled', '1');
                    el.disabled = true;
                });
            });
        } else {
            doc.querySelectorAll('[data-three-disabled="1"]').forEach(el => {
                el.disabled = false;
                el.removeAttribute('data-three-disabled');
            });
        }
    }

    // The Proposals button carries the same count as the "Proposals List (N)" button inside its
    // sheet. That button's count is written in one place (list-ui.js updateShowProposalsButton) as
    // data-i18n-params, so the badge follows that attribute rather than asking a second time.
    function syncProposalsBadge() {
        const source = doc.getElementById('showProposalsButton');
        const badge = doc.getElementById('proposals-button-count');
        const button = doc.getElementById('proposals-button');
        if (!source || !badge) return;
        let count = 0;
        try {
            const params = JSON.parse(source.getAttribute('data-i18n-params') || '{}');
            count = Number.isFinite(Number(params.count)) ? Number(params.count) : 0;
        } catch (_) { count = 0; }
        badge.textContent = String(count);
        badge.hidden = count <= 0;
        if (button) {
            button.setAttribute('aria-label', t('mapShell.proposalsCount', `Proposals (${count})`, { count }));
        }
    }

    function watchProposalsBadge() {
        const source = doc.getElementById('showProposalsButton');
        if (!source || typeof win.MutationObserver !== 'function') return;
        new win.MutationObserver(syncProposalsBadge)
            .observe(source, { attributes: true, attributeFilter: ['data-i18n-params'] });
        // Its aria-label is translated text: redo it on a language switch too.
        if (win.i18n && typeof win.i18n.onChange === 'function') win.i18n.onChange(syncProposalsBadge);
        win.addEventListener('i18n:translationsLoaded', syncProposalsBadge);
        syncProposalsBadge();
    }

    function onDocumentPointerDown(event) {
        const sheet = state.openSheet;
        if (!sheet) return;
        const target = event.target;
        if (sheet.contains(target)) return;
        if (state.trigger && state.trigger.contains(target)) return;
        // Another sheet's button toggles through its own click handler.
        if (target.closest && target.closest('[data-sheet-target]')) return;
        closeSheet({ restoreFocus: false });
    }

    // A blocking dialog over the map — a modal, a styled confirm, the globe, the site intro, the
    // palette — as opposed to the non-modal surfaces (sheets, the parcel menu, docked panels, the
    // cross-section editor). `except` leaves one out (the palette asking about everything else).
    // Keyboard shortcuts and Escape chains use it so they never act on what is underneath.
    const BLOCKING_DIALOG_SELECTOR = '[aria-modal="true"], .cb-confirm-overlay, dialog[open], [role="dialog"]:not(.map-sheet)';

    function isBlockingDialogOpen(except) {
        if (doc.body && doc.body.classList.contains('modal-open')) return true;
        const visible = el => (typeof win.isElementVisiblyRendered === 'function'
            ? win.isElementVisiblyRendered(el)
            : el.getClientRects().length > 0);
        return Array.from(doc.querySelectorAll(BLOCKING_DIALOG_SELECTOR)).some(el => {
            if (except && (el === except || except.contains(el) || el.contains(except))) return false;
            if (el.closest('.corridor-editor-overlay')) return false;
            return visible(el);
        });
    }

    // Whether a blocking dialog was open when this Escape STARTED (window capture runs before every
    // other listener). Checking only at the end missed dialogs whose own Escape handler had
    // already removed them by then (Plan Stats, the status log): the sheet then closed as well.
    let escapeStartedInDialog = false;
    function onEscapeCapture(event) {
        if (event.key === 'Escape') escapeStartedInDialog = isBlockingDialogOpen();
    }

    function onDocumentKeyDown(event) {
        if (event.key !== 'Escape' || !state.openSheet || event.defaultPrevented) return;
        // A dialog opened on top of the sheet (status log, version history, a confirm) owns Escape,
        // even when it left focus in the sheet.
        if (escapeStartedInDialog || isBlockingDialogOpen()) return;
        const active = doc.activeElement;
        // Only when focus is with the sheet (or nowhere in particular): Escape inside a dialog
        // opened on top of it belongs to that dialog.
        const ours = !active || active === doc.body || state.openSheet.contains(active)
            || (state.trigger && state.trigger.contains(active));
        if (!ours) return;
        event.preventDefault();
        closeSheet({ restoreFocus: true });
    }

    function initializeMapShell() {
        if (state.initialized) return;
        state.initialized = true;

        doc.querySelectorAll('.map-sheet').forEach(sheet => {
            if (!sheet.hasAttribute('tabindex')) sheet.setAttribute('tabindex', '-1');
        });
        doc.querySelectorAll('[data-sheet-target]').forEach(button => {
            button.addEventListener('click', () => toggleSheet(button.getAttribute('data-sheet-target'), button));
        });
        doc.querySelectorAll('[data-sheet-close]').forEach(button => {
            button.addEventListener('click', () => closeSheet({ restoreFocus: true }));
        });
        doc.addEventListener('pointerdown', onDocumentPointerDown, true);
        // On window, not document: window listeners run after every document listener, so a tool
        // or dialog that handles Escape first (Measure, Pinpoint, area drawing, the status log)
        // marks it with preventDefault and the sheet stays open — one Escape, one step. On
        // document the order depended on who registered first, and a tool started from a sheet
        // always registers after the shell.
        (win || doc).addEventListener('keydown', onEscapeCapture, true);
        (win || doc).addEventListener('keydown', onDocumentKeyDown);
        win.addEventListener('resize', () => {
            if (state.openSheet) positionSheet(state.openSheet, state.trigger);
        });
        watchProposalsBadge();
    }

    return {
        placePopover,
        initializeMapShell,
        openSheet,
        closeSheet,
        closeSheets,
        toggleSheet,
        isOpen,
        revealControl,
        revealSection,
        setSectionBusy,
        setLockedFor3D,
        syncProposalsBadge,
        isBlockingDialogOpen,
        // The world view (globe); js/ui/world-entry.js owns it. opts: {} | { focus: place }.
        openWorldView: opts => {
            if (!win || !win.WorldEntry) throw new Error('MapShell.openWorldView: js/ui/world-entry.js is not loaded');
            return win.WorldEntry.open(opts || {});
        }
    };
});
