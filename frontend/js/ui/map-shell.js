// ui/map-shell.js — the floating map shell that replaced the left sidebar: the Layers/Settings
// buttons (top-right), the Proposals/Bets/Activity dock and the sheets they
// open. Right-screen panels use the shared inspection column on desktop; other sheets are
// popovers anchored to their buttons. Bets and Activity share a wider frame centred on the dock.
// Phones use the shared sheet controls. One is open at a time; Escape closes it. The controls
// inside the sheets are the old sidebar's, moved with their ids and handlers.
// placePopover is pure and exported for backend/test/frontend-ui-commands.test.js.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MapShell = api;
})(typeof window !== 'undefined' ? window : null, function (win) {
    'use strict';

    const MOBILE_QUERY = '(max-width: 767.98px)';
    const POPOVER_GAP = 8;
    const VIEWPORT_MARGIN = 10;

    // Where a popover goes relative to the button that opened it: below a button in the top half,
    // above one in the bottom half; centred on a button that straddles the viewport's midline
    // (the middle button of the bottom dock) when its width is known, otherwise right-aligned to
    // a button in the right half and left-aligned to one in the left half. Returns CSS offsets in
    // px (null = auto) and the height left for it.
    function placePopover(anchor, viewport, options = {}) {
        const gap = typeof options.gap === 'number' ? options.gap : POPOVER_GAP;
        const margin = typeof options.margin === 'number' ? options.margin : VIEWPORT_MARGIN;
        const opensDown = (anchor.top + anchor.height / 2) < viewport.height / 2;
        const midline = viewport.width / 2;
        const straddles = anchor.left < midline && (anchor.left + anchor.width) > midline;
        const width = typeof options.width === 'number' && options.width > 0 ? options.width : null;
        const alignRight = (anchor.left + anchor.width / 2) > midline;
        const place = { top: null, bottom: null, left: null, right: null, maxHeight: 0 };
        if (opensDown) {
            place.top = anchor.bottom + gap;
            place.maxHeight = viewport.height - place.top - margin;
        } else {
            place.bottom = viewport.height - anchor.top + gap;
            place.maxHeight = anchor.top - gap - margin;
        }
        if (straddles && width) {
            const centred = anchor.left + anchor.width / 2 - width / 2;
            place.left = Math.round(Math.max(margin, Math.min(centred, viewport.width - width - margin)));
        } else if (alignRight) place.right = Math.max(margin, viewport.width - anchor.right);
        else place.left = Math.max(margin, anchor.left);
        place.maxHeight = Math.max(120, Math.round(place.maxHeight));
        return place;
    }

    // Whether a pointer-down at `target` is an "outside click" that folds the open sheet away. A
    // press inside the sheet, on its own button or on another sheet's button is not; neither is any
    // press while a blocking dialog is open on top of the sheet (the stake dialog, the wallet picker,
    // a confirm): that press belongs to the dialog, and the sheet it was opened from stays so the
    // person lands back on it, not on the bare map, when the dialog closes. Pure, tested in
    // backend/test/frontend-ui-commands.test.js.
    function pointerDownClosesSheet({ sheet, trigger, target, blockingDialogOpen }) {
        if (!sheet || !target) return false;
        if (blockingDialogOpen) return false;
        if (sheet.contains(target)) return false;
        if (trigger && trigger.contains(target)) return false;
        // Another sheet's button toggles through its own click handler.
        if (target.closest && target.closest('[data-sheet-target]')) return false;
        return true;
    }

    // While a design is being edited (an on-map editor holds the map, a road or track is being drawn,
    // a site is being drawn), the controls that would start another task are greyed out, never
    // hidden: the dock keeps its shape and the tooltip says how to get them back. The views the
    // editor cannot run in are locked the same way by map-mode-loader.js (paintModeLocks). Layers,
    // Buildings and massing and Measure stay: they help with the drawing.
    const EDIT_LOCKED_CONTROLS = Object.freeze(['proposals-button', 'bets-button', 'activity-button', 'shareAppliedProposalsButton', 'settings-button', 'username-display']);
    const EDIT_LOCKED_SELECTORS = '.map-search__chip, .map-search__icon-button, .map-search__input';
    const EDIT_LOCKED_SHEETS = Object.freeze(['proposals-sheet', 'bets-sheet', 'activity-sheet', 'settings-sheet']);

    function isEditingDesign(global) {
        if (!global) return false;
        if (global.roadDrawingMode === true) return true;
        if (global.__mapEditLock && typeof global.__mapEditLock.isHeld === 'function' && global.__mapEditLock.isHeld()) return true;
        const body = global.document && global.document.body;
        return !!(body && body.classList && body.classList.contains('site-tool-drawing'));
    }

    // Lock or unlock one control, keeping what the page had set so the unlock puts it back. A real
    // control is disabled; the profile bubble (a div with role=button) leaves the tab order instead,
    // and the shell's capture-phase click guard stops its clicks.
    function setEditLocked(el, locked, title) {
        const wasLocked = el.hasAttribute('data-edit-locked');
        if (locked) {
            if (!wasLocked) {
                el.setAttribute('data-edit-locked', JSON.stringify({
                    title: el.getAttribute('title'),
                    disabled: 'disabled' in el ? !!el.disabled : null,
                    tabindex: el.getAttribute('tabindex')
                }));
            }
            el.classList.add('is-edit-locked');
            el.setAttribute('aria-disabled', 'true');
            el.setAttribute('title', title);
            if ('disabled' in el) el.disabled = true;
            else el.setAttribute('tabindex', '-1');
        } else if (wasLocked) {
            const saved = JSON.parse(el.getAttribute('data-edit-locked'));
            el.removeAttribute('data-edit-locked');
            el.classList.remove('is-edit-locked');
            el.removeAttribute('aria-disabled');
            if (saved.title === null) el.removeAttribute('title');
            else el.setAttribute('title', saved.title);
            if (saved.disabled !== null) el.disabled = saved.disabled;
            if (saved.tabindex === null) el.removeAttribute('tabindex');
            else el.setAttribute('tabindex', saved.tabindex);
        }
    }

    if (!win || !win.document) {
        return { placePopover, pointerDownClosesSheet, isEditingDesign, setEditLocked, EDIT_LOCKED_CONTROLS, EDIT_LOCKED_SHEETS };
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
        if (!trigger || isMobile() || sheet.classList.contains('right-screen-panel')) {
            props.forEach(prop => sheet.style.removeProperty(prop));
            return;
        }
        const anchorEl = trigger.closest('[data-sheet-anchor]') || trigger;
        const rect = anchorEl.getBoundingClientRect();
        // The sheet is already shown (display: flex) when this runs, so its width is its CSS width.
        const place = placePopover(rect, { width: win.innerWidth, height: win.innerHeight }, { width: sheet.offsetWidth || 0 });
        const px = value => (value === null ? 'auto' : `${Math.round(value)}px`);
        sheet.style.setProperty('--sheet-top', px(place.top));
        sheet.style.setProperty('--sheet-bottom', px(place.bottom));
        sheet.style.setProperty('--sheet-left', px(place.left));
        sheet.style.setProperty('--sheet-right', px(place.right));
        sheet.style.setProperty('--sheet-max-height', `${place.maxHeight}px`);
    }

    // The open sheet's buttons read as selected through aria-expanded alone (css/map-shell.css).
    function setExpanded(sheet, expanded) {
        triggersFor(sheet).forEach(button => {
            button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        });
    }

    function openSheet(sheetOrId, options = {}) {
        const sheet = typeof sheetOrId === 'string' ? doc.getElementById(sheetOrId) : sheetOrId;
        if (!sheet) throw new Error(`MapShell: no sheet ${sheetOrId}`);
        if (!supportsCurrentMode(sheet)) return null;
        if (state.openSheet && state.openSheet !== sheet) closeSheet({ restoreFocus: false });
        const trigger = options.trigger || triggersFor(sheet)[0] || null;
        state.openSheet = sheet;
        state.trigger = trigger;
        if (sheet.id === 'layers-sheet' || sheet.id === 'settings-sheet') {
            sheet.querySelectorAll('details.accordion-section').forEach(section => { section.open = false; });
        }
        sheet.hidden = false;
        positionSheet(sheet, trigger);
        setExpanded(sheet, true);
        doc.body.classList.add('map-sheet-open');
        sheetResizeObserver?.observe(sheet);
        win.requestAnimationFrame?.(updateMapViewportInsets);
        // Sheets that load on demand (Bets) listen for this instead of polling the hidden attribute.
        try { doc.dispatchEvent(new win.CustomEvent('mapshell:sheetopened', { detail: { id: sheet.id } })); } catch (_) { }
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
        sheetResizeObserver?.unobserve(sheet);
        updateMapViewportInsets();
        // byHand: the person closed it (×, Escape, its button), not something that needed the map.
        doc.dispatchEvent(new win.CustomEvent('mapshell:sheetclosed', { detail: { id: sheet.id, byHand: options.byHand === true } }));
        if (options.restoreFocus && trigger && typeof trigger.focus === 'function') {
            try { trigger.focus({ preventScroll: true }); } catch (_) { }
        }
    }

    function toggleSheet(sheetId, trigger) {
        const sheet = doc.getElementById(sheetId);
        if (!sheet) throw new Error(`MapShell: no sheet ${sheetId}`);
        if (state.openSheet === sheet) closeSheet({ restoreFocus: false, byHand: true });
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

    // Open the sheet that holds a control (and the <details> folding it away, e.g. the Simulation
    // settings), scroll it into view and focus it. A control that is not
    // itself focusable while visible (the hidden native city <select> behind the custom dropdown)
    // hands focus to the first visible focusable thing beside it.
    function revealControl(id) {
        const el = doc.getElementById(id);
        if (!el) throw new Error(`MapShell: control #${id} is missing`);
        const sheet = el.closest('.map-sheet');
        if (sheet) openSheet(sheet, { focus: false });
        // A control inside an inactive tab pane cannot be revealed by opening its sheet alone.
        // Activate the pane's labelled tab before resolving the visible focus target.
        const tabPanel = el.closest('[role="tabpanel"]');
        if (tabPanel?.hidden) {
            const tab = doc.getElementById(tabPanel.getAttribute('aria-labelledby'));
            if (typeof tab?.click === 'function') tab.click();
        }
        const folded = el.closest('details');
        if (folded && !folded.open) folded.open = true;
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
        const section = Array.from(doc.querySelectorAll(`[data-section="${sectionName}"]`))
            .find(candidate => candidate.style.display !== 'none');
        if (!section) return null;
        const sheet = section.classList.contains('map-sheet') ? section : section.closest('.map-sheet');
        if (sheet) openSheet(sheet, { focus: false });
        if (section.tagName === 'DETAILS') section.open = true;
        try { section.scrollIntoView({ block: 'nearest' }); } catch (_) { }
        return section;
    }

    // A long-running action locks the section(s) it belongs to (not the whole UI, as the sidebar
    // overlay did): every control in them is disabled and a spinner line says why.
    function setSectionBusy(sectionName, busy, message) {
        doc.querySelectorAll(`[data-section="${sectionName}"]`).forEach(section => {
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

    // A view changes capabilities, not the availability of the app's navigation.
    // The same mode vocabulary is consumed by UiCommands for menus and keyboard commands.
    function currentMode() {
        return doc.body.classList.contains('realistic-mode-active') ? 'photo'
            : doc.body.classList.contains('three-mode-active') ? '3d' : '2d';
    }

    function supportsCurrentMode(el) {
        const modes = el.getAttribute('data-map-modes');
        return !modes || modes.split(/\s+/).includes(currentMode());
    }

    function syncModeAvailability() {
        const mode = currentMode();
        doc.querySelectorAll('[data-map-modes]').forEach(el => {
            const supported = supportsCurrentMode(el);
            // A supported sheet is available to open, not automatically open.
            if (!el.classList.contains('map-sheet') || !supported) el.hidden = !supported;
        });
        if (state.openSheet?.hidden) closeSheet({ restoreFocus: false });
        if (mode === '2d' && win.roadDrawingMode) doc.getElementById('road-info-panel')?.classList.add('visible');
        paintEditLocks();
        observeEditors();
        updateMapViewportInsets();
    }

    const isEditing = () => isEditingDesign(win);

    function paintEditLocks() {
        const locked = isEditing();
        const controls = EDIT_LOCKED_CONTROLS.map(id => doc.getElementById(id)).filter(Boolean)
            .concat(Array.from(doc.querySelectorAll(EDIT_LOCKED_SELECTORS)));
        const title = t('mapShell.modeLocked', 'Not available while you are editing — finish or cancel first');
        if (locked && controls.some(el => !el.hasAttribute('data-edit-locked'))) {
            // Starting to edit folds away what those controls had open.
            if (state.openSheet && EDIT_LOCKED_SHEETS.includes(state.openSheet.id)) closeSheet({ restoreFocus: false });
            win.MapSearch?.close?.();
        }
        controls.forEach(el => setEditLocked(el, locked, title));
    }

    // The profile bubble is a div: being disabled does not stop its clicks, so the shell does.
    function onLockedClickCapture(event) {
        if (!event.target?.closest?.('[data-edit-locked]')) return;
        event.preventDefault();
        event.stopPropagation();
    }

    // Whether the open sheet hides the whole map: a dock sheet on a phone fills the screen above the
    // bar. A list there cannot preview on the map behind it (js/proposals/list-ui.js).
    function coversMap() {
        const sheet = state.openSheet;
        return !!(sheet && !sheet.hidden && isMobile() && sheet.getBoundingClientRect().top < 24);
    }

    // Attribution follows the exposed map when a phone sheet opens. The dock never moves. A sheet
    // that covers the map exposes none of it, so the credits stay where the map will be again.
    function updateMapViewportInsets() {
        let inset = 0;
        if (isMobile() && state.openSheet && !state.openSheet.hidden && !coversMap()) {
            const top = state.openSheet.getBoundingClientRect().top;
            inset = Math.max(0, win.innerHeight - top);
        }
        // Only an editor docked along the bottom lifts the map's bottom corners: the site card
        // stands in the right dock on a wide screen.
        if (currentMode() === '2d') observedEditors.forEach(editor => {
            if (!isVisible(editor)) return;
            const top = editor.getBoundingClientRect().top;
            if (top > win.innerHeight / 2) inset = Math.max(inset, win.innerHeight - top);
        });
        if (inset) doc.body.style.setProperty('--map-visible-bottom', `${Math.round(inset)}px`);
        else doc.body.style.removeProperty('--map-visible-bottom');
    }

    let sheetResizeObserver = null;
    const observedEditors = new Set();
    function observeEditors() {
        if (!sheetResizeObserver) return;
        observedEditors.forEach(editor => {
            if (editor.isConnected) return;
            sheetResizeObserver.unobserve(editor);
            observedEditors.delete(editor);
        });
        doc.querySelectorAll('.map-editor-toolbar, .site-panel, .area-monitor-creation-panel').forEach(editor => {
            if (observedEditors.has(editor)) return;
            observedEditors.add(editor);
            sheetResizeObserver.observe(editor);
        });
    }

    function activeAreaDrawingTool() {
        if (win.AreaMonitorPaint?.isActive()) return win.AreaMonitorPaint;
        if (win.AreaMonitorDraw?.isActive()) return win.AreaMonitorDraw;
        return null;
    }

    function setAreaDrawing(active) {
        doc.body.classList.toggle('area-monitor-drawing-active', active);
        const toolbar = doc.getElementById('area-monitor-drawing-toolbar');
        if (toolbar) toolbar.hidden = !active;
        if (active) {
            closeSheets();
            win.ClickStack?.close();
            win.hideParcelInfoPanel?.();
            win.hideProposalDetailsPanel?.();
        }
        observeEditors();
        updateMapViewportInsets();
    }

    // Lists contains three record types; a design-only count would mislabel its contents.
    function syncProposalsBadge() {
        const badge = doc.getElementById('proposals-button-count');
        if (badge) badge.hidden = true;
        doc.getElementById('proposals-button')?.setAttribute('aria-label', t('lists.title', 'Lists'));
    }

    function watchProposalsBadge() {
        const source = doc.getElementById('showProposalsButton');
        if (!source || typeof win.MutationObserver !== 'function') return;
        new win.MutationObserver(syncProposalsBadge)
            .observe(source, { attributes: true, attributeFilter: [
                'data-i18n-params', 'data-proposal-count-ready', 'data-proposal-area', 'data-proposal-list-opened'
            ] });
        // Its aria-label is translated text: redo it on a language switch too.
        if (win.i18n && typeof win.i18n.onChange === 'function') win.i18n.onChange(syncProposalsBadge);
        win.addEventListener('i18n:translationsLoaded', syncProposalsBadge);
        syncProposalsBadge();
    }

    function onDocumentPointerDown(event) {
        const sheet = state.openSheet;
        if (!sheet) return;
        // The Designs side panel stays available while the map is explored or picks a share row.
        if (sheet.id === 'proposals-sheet') return;
        if (!pointerDownClosesSheet({ sheet, trigger: state.trigger, target: event.target, blockingDialogOpen: isBlockingDialogOpen() })) return;
        closeSheet({ restoreFocus: false });
    }

    // A blocking dialog over the map — a modal, a styled confirm, the globe, the site intro, the
    // palette — as opposed to the non-modal surfaces (sheets, the parcel menu, docked panels, the
    // cross-section editor). `except` leaves one out (the palette asking about everything else).
    // Keyboard shortcuts and Escape chains use it so they never act on what is underneath.
    const BLOCKING_DIALOG_SELECTOR = '[aria-modal="true"], .cb-dialog-overlay:not([hidden]), dialog[open], [role="dialog"]:not(.map-sheet)';

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
        closeSheet({ restoreFocus: true, byHand: true });
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
            button.addEventListener('click', () => closeSheet({ restoreFocus: true, byHand: true }));
        });
        doc.addEventListener('pointerdown', onDocumentPointerDown, true);
        doc.addEventListener('click', onLockedClickCapture, true);
        // On window, not document: window listeners run after every document listener, so a tool
        // or dialog that handles Escape first (Measure, Pinpoint, area drawing, the status log)
        // marks it with preventDefault and the sheet stays open — one Escape, one step. On
        // document the order depended on who registered first, and a tool started from a sheet
        // always registers after the shell.
        (win || doc).addEventListener('keydown', onEscapeCapture, true);
        (win || doc).addEventListener('keydown', onDocumentKeyDown);
        win.addEventListener('resize', () => {
            if (state.openSheet) positionSheet(state.openSheet, state.trigger);
            updateMapViewportInsets();
        });
        if (typeof win.ResizeObserver === 'function') sheetResizeObserver = new win.ResizeObserver(updateMapViewportInsets);
        if (typeof win.MutationObserver === 'function') {
            new win.MutationObserver(syncModeAvailability).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
        }
        doc.addEventListener('corridor-drawing-mode-changed', event => {
            doc.body.classList.toggle('corridor-drawing-active', !!event.detail?.road);
            if (event.detail?.road) closeSheets();
        });
        win.addEventListener('areaMonitorDrawStart', () => setAreaDrawing(true));
        win.addEventListener('areaMonitorDrawCancel', () => setAreaDrawing(false));
        win.addEventListener('areaMonitorDrawComplete', () => setAreaDrawing(false));
        doc.getElementById('area-monitor-drawing-cancel')?.addEventListener('click', () => activeAreaDrawingTool()?.deactivate());
        doc.getElementById('area-monitor-drawing-undo')?.addEventListener('click', () => activeAreaDrawingTool()?.undoLastVertex());
        syncModeAvailability();
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
        coversMap,
        revealControl,
        revealSection,
        setSectionBusy,
        syncModeAvailability,
        syncProposalsBadge,
        isBlockingDialogOpen,
        pointerDownClosesSheet,
        isEditing,
        isEditingDesign,
        setEditLocked,
        EDIT_LOCKED_CONTROLS,
        EDIT_LOCKED_SHEETS,
        // The world view (globe); js/ui/world-entry.js owns it. opts: {} | { focus: place }.
        openWorldView: opts => {
            if (!win || !win.WorldEntry) throw new Error('MapShell.openWorldView: js/ui/world-entry.js is not loaded');
            return win.WorldEntry.open(opts || {});
        }
    };
});
