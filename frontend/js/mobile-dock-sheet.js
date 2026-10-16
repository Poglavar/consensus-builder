// Resize the phone version of the parcel/road dock without giving each panel its own
// touch implementation. The geometry helpers are deliberately DOM-free so they can be tested in
// Node; the rest is only event wiring around one CSS custom property.
(function (global, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (global) global.MobileDockSheet = api;
})(typeof window !== 'undefined' ? window : globalThis, function mobileDockSheetFactory() {
    'use strict';

    // The drill stack also shares the desktop dock width, but it stays a compact top-row card on
    // phones. Only the actual info panels become bottom sheets.
    const PANEL_SELECTOR = '.info-panel.right-dock-panel:not(#proposal-details-panel)';
    const HANDLE_CLASS = 'mobile-dock-sheet-handle';
    const DEFAULT_RATIO = 0.66;
    const MIN_RATIO = 0.42;
    const MAX_RATIO = 0.82;
    const MIN_PIXELS = 240;

    function finiteNumber(value, fallback = 0) {
        return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function limits(viewportHeight, topClearance, bottomClearance) {
        const viewport = Math.max(0, finiteNumber(viewportHeight));
        const available = Math.max(0, viewport - Math.max(0, finiteNumber(topClearance))
            - Math.max(0, finiteNumber(bottomClearance)) - 8);
        const max = Math.min(available, viewport * MAX_RATIO);
        const min = Math.min(max, Math.max(MIN_PIXELS, viewport * MIN_RATIO));
        return { min, max, available };
    }

    function sheetHeight({ viewportHeight, topClearance = 0, bottomClearance = 0, desiredHeight }) {
        const range = limits(viewportHeight, topClearance, bottomClearance);
        const desired = finiteNumber(desiredHeight, finiteNumber(viewportHeight) * DEFAULT_RATIO);
        return clamp(desired, range.min, range.max);
    }

    function draggedHeight({ startHeight, deltaY, viewportHeight, topClearance = 0, bottomClearance = 0 }) {
        return sheetHeight({
            viewportHeight,
            topClearance,
            bottomClearance,
            desiredHeight: finiteNumber(startHeight) - finiteNumber(deltaY)
        });
    }

    function numberProperty(style, name) {
        const value = Number.parseFloat(style.getPropertyValue(name));
        return Number.isFinite(value) ? value : 0;
    }

    function viewportHeight(win) {
        return win.visualViewport?.height || win.innerHeight || 0;
    }

    function resolvedCustomLength(win, name) {
        const doc = win.document;
        if (!doc?.body) return 0;
        const probe = doc.createElement('div');
        probe.style.cssText = `position:fixed; visibility:hidden; pointer-events:none; height:var(${name});`;
        doc.body.appendChild(probe);
        const value = probe.getBoundingClientRect().height;
        probe.remove();
        return finiteNumber(value);
    }

    function clearances(win, panel) {
        const style = win.getComputedStyle(panel);
        return {
            // getComputedStyle returns the custom property's literal `calc(...)`, not its resolved
            // length. Resolve it through a temporary box so a tall drag cannot cover the top row.
            topClearance: resolvedCustomLength(win, '--map-shell-top-clearance'),
            bottomClearance: numberProperty(style, 'bottom')
        };
    }

    function setHeight(win, panel, desiredHeight) {
        const viewport = viewportHeight(win);
        const { topClearance, bottomClearance } = clearances(win, panel);
        const height = sheetHeight({ viewportHeight: viewport, topClearance, bottomClearance, desiredHeight });
        panel.style.setProperty('--mobile-dock-sheet-height', `${Math.round(height)}px`);
        // Attribution needs the same clearance while the parcel card is open. The sheet variable
        // normally lives on the panel, so mirror a dragged value onto the shared map ancestor.
        win.document.getElementById('map-container')?.style.setProperty('--mobile-dock-sheet-height', `${Math.round(height)}px`);
        return height;
    }

    // ---- What the bottom sheets occupy ----------------------------------------------------------
    //
    // On a phone the Leaflet corners (the basemap credit, the scale bar) sit on the top edge of
    // whichever bottom sheet is open, so they stay in the map (css/map-shell.css reads
    // --map-sheet-occupied off #map-container). The road panel also sits on the Undo / Finish /
    // Cancel bar, whose measured height is --map-editor-toolbar-height. Both are reported from
    // what is on screen (a ResizeObserver on each sheet and on the bar), never from CSS values the
    // sheet's content decides.
    const TOOLBAR_ID = 'road-drawing-controls';

    function occupiedBottom({ viewportHeight, top }) {
        if (!Number.isFinite(viewportHeight) || !Number.isFinite(top)) return 0;
        return Math.max(0, Math.round(viewportHeight - top));
    }

    function reportOccupancy(win) {
        const doc = win.document;
        const container = doc?.getElementById?.('map-container');
        if (!container?.style) return;
        const viewport = viewportHeight(win);
        let occupied = 0;
        if (win.matchMedia?.('(max-width: 767.98px)').matches) {
            // The compact proposal card (not a draggable sheet, but a bottom sheet all the same).
            const card = doc.querySelector?.('#proposal-details-panel.is-minimized');
            [...doc.querySelectorAll(PANEL_SELECTOR), ...(card ? [card] : [])].forEach(panel => {
                const box = panel.getBoundingClientRect();
                if (box.height > 0) occupied = Math.max(occupied, occupiedBottom({ viewportHeight: viewport, top: box.top }));
            });
        }
        if (occupied > 0) container.style.setProperty('--map-sheet-occupied', `${occupied}px`);
        else container.style.removeProperty('--map-sheet-occupied');
        const toolbar = doc.getElementById(TOOLBAR_ID);
        const toolbarHeight = toolbar && !toolbar.hidden ? Math.round(toolbar.getBoundingClientRect().height) : 0;
        if (toolbarHeight > 0) container.style.setProperty('--map-editor-toolbar-height', `${toolbarHeight}px`);
        else container.style.removeProperty('--map-editor-toolbar-height');
    }

    function observeOccupancy(win, element) {
        if (!element || element.__mobileDockSheetSizeObserver || typeof win.ResizeObserver !== 'function') return;
        element.__mobileDockSheetSizeObserver = new win.ResizeObserver(() => reportOccupancy(win));
        element.__mobileDockSheetSizeObserver.observe(element);
    }

    function makeHandle(win, panel) {
        const handle = win.document.createElement('button');
        handle.type = 'button';
        handle.className = HANDLE_CLASS;
        handle.setAttribute('data-i18n-key', 'sidebar.areaMonitor.resizePanel');
        handle.setAttribute('data-i18n-attr', 'aria-label,title');
        handle.setAttribute('aria-controls', panel.id);
        if (typeof win.i18n?.applyTranslations === 'function') win.i18n.applyTranslations(handle);
        panel.insertBefore(handle, panel.firstChild);
        return handle;
    }

    function wirePanel(win, panel) {
        if (!panel || panel.id === 'proposal-details-panel' || panel.querySelector(`:scope > .${HANDLE_CLASS}`)) return;
        const handle = makeHandle(win, panel);
        let drag = null;

        handle.addEventListener('pointerdown', event => {
            if (!win.matchMedia('(max-width: 767.98px)').matches || panel.classList.contains('is-minimized')) return;
            drag = { pointerId: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height };
            handle.setPointerCapture?.(event.pointerId);
            handle.classList.add('is-dragging');
            event.preventDefault();
        });

        handle.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            setHeight(win, panel, draggedHeight({
                startHeight: drag.height,
                deltaY: event.clientY - drag.y,
                viewportHeight: viewportHeight(win),
                ...clearances(win, panel)
            }));
            event.preventDefault();
        });

        const finishDrag = event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            handle.releasePointerCapture?.(event.pointerId);
            handle.classList.remove('is-dragging');
            drag = null;
        };
        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', finishDrag);
        handle.addEventListener('keydown', event => {
            if (!win.matchMedia('(max-width: 767.98px)').matches || panel.classList.contains('is-minimized')) return;
            const current = panel.getBoundingClientRect().height;
            const viewport = viewportHeight(win);
            const step = Math.max(32, Math.round(viewport * 0.08));
            let next = null;
            if (event.key === 'ArrowUp') next = current + step;
            else if (event.key === 'ArrowDown') next = current - step;
            else if (event.key === 'Home') next = limits(viewport, clearances(win, panel).topClearance, clearances(win, panel).bottomClearance).min;
            else if (event.key === 'End') next = limits(viewport, clearances(win, panel).topClearance, clearances(win, panel).bottomClearance).max;
            if (next === null) return;
            setHeight(win, panel, next);
            event.preventDefault();
        });

        // Parcel/proposal renderers replace a panel's children. Keep this control attached to the
        // panel itself, then restore it after those renders instead of asking every renderer to
        // remember a sheet-only detail. Inserting the handle triggers this observer once; the
        // query at the top makes that pass a no-op.
        if (!panel.__mobileDockSheetObserver && typeof win.MutationObserver === 'function') {
            panel.__mobileDockSheetObserver = new win.MutationObserver(() => wirePanel(win, panel));
            panel.__mobileDockSheetObserver.observe(panel, { childList: true });
        }
        observeOccupancy(win, panel);
    }

    function wireAddedPanelNode(win, node) {
        if (!node || node.nodeType !== 1) return;
        if (node.matches?.(PANEL_SELECTOR)) wirePanel(win, node);
        node.querySelectorAll?.(PANEL_SELECTOR).forEach(panel => wirePanel(win, panel));
    }

    function observeAddedPanels(win) {
        if (win.__mobileDockSheetPanelObserver || typeof win.MutationObserver !== 'function') return;
        // Proposal details is created lazily by Explore. Scope this observer to the map container,
        // rather than document.body, so unrelated page mutations never wake the sheet wiring.
        const container = win.document.getElementById('map-container');
        if (!container) return;
        win.__mobileDockSheetPanelObserver = new win.MutationObserver(mutations => {
            mutations.forEach(mutation => mutation.addedNodes.forEach(node => wireAddedPanelNode(win, node)));
        });
        win.__mobileDockSheetPanelObserver.observe(container, { childList: true, subtree: true });
    }

    function install(win = globalThis) {
        if (!win?.document || win.__mobileDockSheetInstalled) return;
        win.__mobileDockSheetInstalled = true;
        const attach = () => win.document.querySelectorAll(PANEL_SELECTOR).forEach(panel => wirePanel(win, panel));
        const reclamp = () => win.document.querySelectorAll(PANEL_SELECTOR).forEach(panel => {
            const desired = Number.parseFloat(panel.style.getPropertyValue('--mobile-dock-sheet-height'));
            if (Number.isFinite(desired)) setHeight(win, panel, desired);
        });
        const attachToolbar = () => {
            observeOccupancy(win, win.document.getElementById(TOOLBAR_ID));
            observeOccupancy(win, win.document.getElementById('proposal-details-panel'));
        };
        const onResize = () => { reclamp(); reportOccupancy(win); };
        if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', () => { attach(); attachToolbar(); }, { once: true });
        else { attach(); attachToolbar(); }
        observeAddedPanels(win);
        win.addEventListener?.('resize', onResize);
        win.visualViewport?.addEventListener?.('resize', onResize);
    }

    const api = { clamp, limits, sheetHeight, draggedHeight, occupiedBottom, reportOccupancy, wirePanel, wireAddedPanelNode, install };
    if (typeof window !== 'undefined') install(window);
    return api;
});
