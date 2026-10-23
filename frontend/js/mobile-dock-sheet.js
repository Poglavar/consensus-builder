// Shared phone resizing and dismissal for map panels, navigation sheets and task dialogs. The geometry helpers are deliberately DOM-free so they can be tested in
// Node; the rest is only event wiring around one CSS custom property.
(function (global, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (global) global.MobileDockSheet = api;
})(typeof window !== 'undefined' ? window : globalThis, function mobileDockSheetFactory() {
    'use strict';

    // Info panels in the right dock become bottom sheets on phones (the click stack among them);
    // a panel hosted inside the click stack is part of that sheet, not a sheet of its own.
    const PANEL_SELECTOR = '.info-panel.right-dock-panel:not(.is-hosted)';
    const SURFACE_SELECTOR = PANEL_SELECTOR + ', .map-sheet, .cb-dialog:not(.cb-dialog--message), .share-plan-panel:not(.share-plan-panel--embedded), .on-map-editor__panel, #click-stack, #three-click-stack, #grain-score-panel, #area-monitor-detail-panel, #urban-block-panel, .site-panel';
    const HANDLE_CLASS = 'mobile-dock-sheet-handle';
    const DEFAULT_RATIO = 0.5;
    const MIN_RATIO = 0.25;
    const MAX_RATIO = 1;
    const MIN_PIXELS = 200;
    let sequence = 0;

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

    function clearances(win, panel) {
        const style = win.getComputedStyle(panel);
        return {
            // Expanded sheets may cover the map chrome; the bottom navigation stays reachable.
            topClearance: 0,
            // The keyboard gap is outside the visual viewport; do not subtract it twice.
            bottomClearance: Math.max(0, numberProperty(style, 'bottom') - Math.max(0,
                (win.innerHeight || viewportHeight(win)) - viewportHeight(win) - (win.visualViewport?.offsetTop || 0)))
        };
    }

    function setHeight(win, panel, desiredHeight) {
        const viewport = viewportHeight(win);
        const { topClearance, bottomClearance } = clearances(win, panel);
        const height = sheetHeight({ viewportHeight: viewport, topClearance, bottomClearance, desiredHeight });
        panel.style.setProperty('--mobile-dock-sheet-height', `${Math.round(height)}px`);
        panel.style.setProperty('--mobile-sheet-height', `${Math.round(height)}px`);
        // Attribution needs the same clearance while the parcel card is open. The sheet variable
        // normally lives on the panel, so mirror a dragged value onto the shared map ancestor.
        win.document.getElementById('map-container')?.style.setProperty('--mobile-dock-sheet-height', `${Math.round(height)}px`);
        return height;
    }

    // ---- What the bottom sheets occupy ----------------------------------------------------------
    //
    // On a phone the Leaflet corners (the basemap credit, the scale bar) sit on the top edge of
    // whichever bottom sheet is open, so they stay in the map (css/map-shell.css reads
    // --map-sheet-occupied off #map-container). It is reported from what is on screen (a
    // ResizeObserver on each sheet), never from CSS values the sheet's content decides.

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
        handle.setAttribute('data-i18n-key', 'mobileSheet.resize');
        handle.setAttribute('aria-label', 'Resize panel. Drag up or down; drag to the bottom to close.');
        handle.setAttribute('title', 'Resize panel. Drag up or down; drag to the bottom to close.');
        handle.setAttribute('data-i18n-attr', 'aria-label,title');
        handle.setAttribute('aria-controls', panel.id);
        if (typeof win.i18n?.applyTranslations === 'function') win.i18n.applyTranslations(handle);
        panel.insertBefore(handle, panel.firstChild);
        return handle;
    }

    function wirePanel(win, panel, options = {}) {
        if (!panel || panel.classList?.contains('is-hosted') || panel.querySelector(`:scope > .${HANDLE_CLASS}`)) return;
        if (!panel.id) panel.id = `mobile-sheet-${++sequence}`;
        const handle = makeHandle(win, panel);
        panel.classList.add('mobile-sheet-ready');
        if (options.expanded || panel.matches?.('.map-sheet--dock, #settings-sheet, .cb-dialog--lg, .cb-dialog--xl, .cb-dialog--fixed, .proposal-modal-content, .lens-modal, .share-plan-panel, .agreement-list-dialog, .area-monitor-list-modal') || panel.querySelector('form')) panel.classList.add('mobile-sheet-expanded');
        const close = () => {
            if (options.close) return options.close();
            if (panel.id === 'click-stack') return win.ClickStack?.close();
            if (panel.id === 'three-click-stack') return win.ThreeClickStack?.close();
            const button = panel.querySelector('[data-sheet-close], [data-agreement-action="close"], .close-button, .close-circle-btn:not([aria-expanded])');
            if (button) return button.click();
        };
        let drag = null;
        let suppressClick = false;
        handle.addEventListener('click', () => {
            if (suppressClick) { suppressClick = false; return; }
            const viewport = viewportHeight(win), available = limits(viewport, 0, clearances(win, panel).bottomClearance).max;
            setHeight(win, panel, panel.getBoundingClientRect().height > available * 0.75 ? viewport * 0.5 : available);
        });

        handle.addEventListener('pointerdown', event => {
            if (!win.matchMedia('(max-width: 767.98px)').matches || panel.classList.contains('is-minimized')) return;
            drag = { pointerId: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height, deltaY: 0 };
            handle.setPointerCapture?.(event.pointerId);
            handle.classList.add('is-dragging');
            event.preventDefault();
        });

        handle.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            drag.deltaY = event.clientY - drag.y;
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
            suppressClick = event.type !== 'pointercancel' && Math.abs(drag.deltaY) > 5;
            if (event.type !== 'pointercancel' && drag.height - drag.deltaY < limits(viewportHeight(win), 0, clearances(win, panel).bottomClearance).min - 48) close();
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
            if (event.key === 'Escape') { close(); event.preventDefault(); event.stopPropagation?.(); return; }
            if (event.key === 'ArrowUp') next = current + step;
            else if (event.key === 'ArrowDown') next = current - step;
            else if (event.key === 'Home') next = limits(viewport, clearances(win, panel).topClearance, clearances(win, panel).bottomClearance).min;
            else if (event.key === 'End') next = limits(viewport, clearances(win, panel).topClearance, clearances(win, panel).bottomClearance).max;
            if (next === null) return;
            setHeight(win, panel, next);
            event.preventDefault();
            event.stopPropagation?.();
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
        if (node.matches?.(SURFACE_SELECTOR)) wirePanel(win, node);
        node.querySelectorAll?.(SURFACE_SELECTOR).forEach(panel => wirePanel(win, panel));
    }

    function observeAddedPanels(win) {
        if (win.__mobileDockSheetPanelObserver || typeof win.MutationObserver !== 'function') return;
        // Dialogs may live outside the map. Only added/removed surface nodes need wiring;
        // disconnected observers must not retain a closed form.
        const container = win.document.body;
        if (!container) return;
        win.__mobileDockSheetPanelObserver = new win.MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => wireAddedPanelNode(win, node));
                mutation.removedNodes?.forEach(node => {
                    if (node.nodeType !== 1 || node.isConnected) return;
                    const panels = [...(node.matches?.('.mobile-sheet-ready') ? [node] : []), ...(node.querySelectorAll?.('.mobile-sheet-ready') || [])];
                    panels.forEach(panel => {
                        panel.__mobileDockSheetObserver?.disconnect();
                        panel.__mobileDockSheetSizeObserver?.disconnect();
                    });
                });
            });
        });
        win.__mobileDockSheetPanelObserver.observe(container, { childList: true, subtree: true });
    }

    function install(win = globalThis) {
        if (!win?.document || win.__mobileDockSheetInstalled) return;
        win.__mobileDockSheetInstalled = true;
        const attach = () => win.document.querySelectorAll(SURFACE_SELECTOR).forEach(panel => wirePanel(win, panel));
        const reclamp = () => win.document.querySelectorAll(SURFACE_SELECTOR).forEach(panel => {
            const desired = Number.parseFloat(panel.style.getPropertyValue('--mobile-dock-sheet-height'));
            if (Number.isFinite(desired)) setHeight(win, panel, desired);
        });
        const attachCard = () => observeOccupancy(win, win.document.getElementById('proposal-details-panel'));
        const onResize = () => {
            const height = viewportHeight(win);
            if (height > 0) {
                const style = win.document.documentElement?.style;
                style?.setProperty('--mobile-visual-height', `${Math.round(height)}px`);
                style?.setProperty('--mobile-visual-bottom', `${Math.round(Math.max(0, (win.innerHeight || height) - height - (win.visualViewport?.offsetTop || 0)))}px`);
            }
            reclamp(); reportOccupancy(win);
        };
        if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', () => { attach(); attachCard(); }, { once: true });
        else { attach(); attachCard(); }
        observeAddedPanels(win);
        onResize();
        win.addEventListener?.('resize', onResize);
        win.visualViewport?.addEventListener?.('resize', onResize);
        win.visualViewport?.addEventListener?.('scroll', onResize);
    }

    const api = { clamp, limits, sheetHeight, draggedHeight, occupiedBottom, reportOccupancy, wirePanel, wireAddedPanelNode, install };
    if (typeof window !== 'undefined') install(window);
    return api;
});
