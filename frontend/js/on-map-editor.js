// Shared frame and ownership for geometry tools working on the main map.
(function attachOnMapEditor(global) {
    'use strict';

    function createRuntime(env) {
        const doc = env.document;
        let active = null;
        const pane = 'onMapEditorPane';
        const handlePane = 'onMapEditorHandles';
        const modeButtons = { '2d': 'mode-2d-toggle', model: 'mode-3d-toggle', photo: 'mode-realistic-toggle', ai: 'mode-ai-toggle' };

        function text(key, fallback) {
            const translated = env.i18n?.t?.(`onMapEditor.${key}`);
            return translated && translated !== `onMapEditor.${key}` ? translated : fallback;
        }

        function node(tag, className, parent, value) {
            const element = doc.createElement(tag);
            if (className) element.className = className;
            if (value !== undefined) element.textContent = value;
            if (parent) parent.appendChild(element);
            return element;
        }

        function appendContent(target, content) {
            if (typeof content === 'string') target.innerHTML = content;
            else if (content) target.appendChild(content);
        }

        function announce() {
            doc.dispatchEvent(new env.CustomEvent('on-map-editor-preview-change', { detail: active?.preview || null }));
        }

        function open(options) {
            if (active || !env.map || !options?.owner) return null;
            if (env.roadDrawingMode && options.owner !== 'corridor-editor') return null;
            if (!env.__mapEditLock?.claim(options.owner, options.title || options.owner)) return null;
            const modes = options.modes?.length ? options.modes.slice() : ['2d', 'model'];
            const root = node('section', 'on-map-editor');
            root.id = options.id || `${options.owner}-editor`;
            root.setAttribute('aria-label', options.title || '');
            const panel = node('aside', `on-map-editor__panel${options.wide ? ' on-map-editor__panel--wide' : ''}`, root);
            const header = node('header', 'on-map-editor__header', panel);
            const title = node('div', 'on-map-editor__heading', header);
            node('span', 'on-map-editor__state', title, text('editing', 'Editing'));
            const heading = node('h2', '', title, options.title || '');
            heading.id = `${root.id}-title`;
            heading.title = options.title || '';
            panel.setAttribute('aria-labelledby', heading.id);
            const toggle = node('button', 'btn btn-sm on-map-editor__toggle', header);
            toggle.type = 'button';
            node('span', '', toggle, text('controls', 'Controls'));
            node('i', 'fas fa-chevron-up', toggle).setAttribute('aria-hidden', 'true');
            toggle.addEventListener('click', () => setCollapsed(!collapsed));
            const cancel = node('button', 'close-circle-btn', header, '×');
            cancel.type = 'button';
            cancel.setAttribute('aria-label', text('cancel', 'Cancel'));
            cancel.addEventListener('click', () => options.onCancel?.());
            const content = node('div', 'on-map-editor__content', panel);
            const hint = node('p', 'on-map-editor__hint', content);
            const body = node('div', 'on-map-editor__body', content);
            body.id = `on-map-editor-controls-${root.id}`;
            toggle.setAttribute('aria-controls', body.id);
            appendContent(body, options.content);
            const footer = node('footer', 'on-map-editor__footer', panel);
            appendContent(footer, options.footer);
            footer.hidden = !options.footer;
            const tools = node('div', 'on-map-editor__tools', root);
            appendContent(tools, options.tools);
            tools.hidden = true; // Anchored tools appear once geometry supplies a position.
            const map = env.map;
            const mapContainer = map.getContainer();
            const popupPane = map.getPane('popupPane');
            const popupHome = popupPane ? {
                parent: popupPane.parentNode,
                next: popupPane.nextSibling,
                left: popupPane.style.left,
                top: popupPane.style.top
            } : null;
            const disabledButtons = Object.entries(modeButtons).filter(([mode]) => !modes.includes(mode))
                .map(([, id]) => doc.getElementById(id)).filter(Boolean)
                .map(button => ({ button, disabled: button.disabled }));
            const suspended = [...doc.querySelectorAll('.create-proposal-modal, #proposal-editor-shell.is-open')]
                .map(element => ({ element, display: element.style.display }));
            const focusReturn = doc.activeElement;
            let controls = null;
            let closed = false;
            let collapsed = false;
            let customHint = null;
            let anchor = null;
            let preview = null;
            let pendingFit = null;
            let openPopup = null;
            let popupPadding = null;

            // Leaflet's transformed map pane traps popups below the editor. Keep the native
            // popup pane in the map container, mirroring its old origin so pan/zoom and auto-pan
            // still use Leaflet coordinates, while its own stacking level clears the controls.
            function positionPopupPane() {
                if (!popupHome?.parent) return;
                const origin = popupHome.parent.getBoundingClientRect();
                const bounds = mapContainer.getBoundingClientRect();
                popupPane.style.left = `${origin.left - bounds.left}px`;
                popupPane.style.top = `${origin.top - bounds.top}px`;
            }
            function onPopupOpen(event) {
                openPopup = event.popup;
                positionPopupPane();
                const popupRect = openPopup.getElement?.()?.getBoundingClientRect();
                if (!popupRect) return;
                popupPadding = {
                    autoPanPaddingTopLeft: openPopup.options.autoPanPaddingTopLeft,
                    autoPanPaddingBottomRight: openPopup.options.autoPanPaddingBottomRight
                };
                const bounds = mapContainer.getBoundingClientRect();
                const panelRect = panel.getBoundingClientRect();
                const toolsRect = tools.getBoundingClientRect();
                const mobile = env.innerWidth < 640;
                const belowTools = tools.hidden ? 76 : toolsRect.bottom - bounds.top + 12;
                const top = !mobile && bounds.height - 100 - belowTools >= popupRect.height
                    ? Math.max(76, belowTools) : 76;
                const panelIsLeft = panelRect.left < bounds.left + bounds.width / 2;
                const clearPanel = !mobile && bounds.width - panelRect.width - 48 >= popupRect.width
                    ? panelRect.width + 24 : 12;
                openPopup.options.autoPanPaddingTopLeft = [panelIsLeft ? clearPanel : 12, top];
                openPopup.options.autoPanPaddingBottomRight = [panelIsLeft ? 100 : clearPanel, 100];
                openPopup.update();
            }
            function onPopupClose(event) {
                if (openPopup !== event.popup) return;
                if (popupPadding) Object.assign(openPopup.options, popupPadding);
                openPopup = null;
                popupPadding = null;
            }

            function positionTools() {
                if (!options.tools || !anchor || closed) return;
                let point;
                if (env.isThreeModeActive?.()) {
                    const view = env.getThreeModeInternals?.();
                    if (!view || !env.THREE) { tools.hidden = true; return; }
                    const [x, y] = view.latLngToXY(anchor.lat, anchor.lng);
                    const projected = new env.THREE.Vector3(x, y, anchor.height || 0).project(view.camera);
                    if (projected.z < -1 || projected.z > 1) { tools.hidden = true; return; }
                    const rect = view.renderer.domElement.getBoundingClientRect();
                    point = { x: rect.left + (projected.x + 1) * rect.width / 2, y: rect.top + (1 - projected.y) * rect.height / 2 };
                } else {
                    const rect = map.getContainer().getBoundingClientRect();
                    const pixel = map.latLngToContainerPoint(anchor);
                    point = { x: rect.left + pixel.x, y: rect.top + pixel.y };
                }
                if (point.x < 0 || point.x > env.innerWidth || point.y < 0 || point.y > env.innerHeight) {
                    tools.hidden = true;
                    return;
                }
                tools.hidden = false;
                const rect = panel.getBoundingClientRect();
                const mobile = env.innerWidth < 640;
                const panelIsLeft = !mobile && rect.left < env.innerWidth / 2;
                const modeStripRight = doc.getElementById(modeButtons['2d'])?.getBoundingClientRect().right || 0;
                const left = panelIsLeft ? rect.right + 12 : Math.max(12, modeStripRight + 8);
                const right = mobile ? env.innerWidth - 12 : panelIsLeft ? env.innerWidth - 12 : rect.left - 12;
                const bottom = mobile ? rect.top - 12 : env.innerHeight - 100;
                const width = tools.offsetWidth || 160;
                const height = tools.offsetHeight || 44;
                tools.style.left = `${Math.max(left, Math.min(point.x - width / 2, right - width))}px`;
                tools.style.top = `${Math.max(76, Math.min(point.y + 28, bottom - height))}px`;
            }

            function updateHint() {
                const mode = env.__mapModeState?.desired || (env.isThreeModeActive?.() ? 'model' : '2d');
                hint.textContent = customHint ?? options.hints?.[mode] ?? '';
                hint.hidden = !hint.textContent;
            }

            // Folding controls changes only their visibility: the live geometry, current tool,
            // contextual hint and completion actions stay available on the same map.
            function setCollapsed(value) {
                if (closed) return;
                collapsed = value === true;
                if (collapsed && body.contains(doc.activeElement)) toggle.focus({ preventScroll: true });
                body.hidden = collapsed;
                root.classList.toggle('is-collapsed', collapsed);
                toggle.setAttribute('aria-expanded', String(!collapsed));
                const label = collapsed ? text('showControls', 'Show controls') : text('hideControls', 'Hide controls');
                toggle.setAttribute('aria-label', label);
                toggle.title = label;
                positionTools();
            }

            const panelResize = env.ResizeObserver ? new env.ResizeObserver(positionTools) : null;

            function syncMode(notify = true) {
                const mode = env.__mapModeState?.desired || (env.isThreeModeActive?.() ? 'model' : '2d');
                updateHint();
                disabledButtons.forEach(({ button }) => { button.disabled = true; });
                const nextControls = env.getThreeModeInternals?.()?.controls || null;
                if (nextControls !== controls) {
                    controls?.removeEventListener('change', positionTools);
                    controls = nextControls;
                    controls?.addEventListener('change', positionTools);
                }
                positionTools();
                if (pendingFit && mode === '2d' && !env.isThreeModeActive?.()) {
                    const { feature, settings } = pendingFit;
                    session.fitFeature(feature, settings);
                }
                if (notify) options.onModeChange?.(mode);
            }

            function onModeChange() { syncMode(); }
            function onKeydown(event) {
                if (event.defaultPrevented || event.key !== 'Escape') return;
                // A nested confirmation or specialized popup gets first use of Escape.
                if ([...doc.querySelectorAll('.cb-dialog-overlay')]
                    .some(element => !element.hidden && element.getClientRects().length > 0)) return;
                // Sheets opened during editing sit above this frame; MapShell owns their Escape.
                if ([...doc.querySelectorAll('.map-sheet:not([hidden])')]
                    .some(element => element.getClientRects().length > 0)) return;
                if (openPopup) {
                    event.preventDefault();
                    event.stopPropagation();
                    map.closePopup(openPopup);
                    return;
                }
                if (options.handleEscape === false) return;
                event.preventDefault();
                options.onCancel?.();
            }
            function close() {
                if (closed) return;
                closed = true;
                map.off('move zoom resize', positionTools);
                map.off('move zoom resize', positionPopupPane);
                map.off('popupopen', onPopupOpen);
                map.off('popupclose', onPopupClose);
                if (openPopup) onPopupClose({ popup: openPopup });
                if (popupHome?.parent) {
                    map.closePopup();
                    popupHome.parent.insertBefore(popupPane, popupHome.next);
                    popupPane.style.left = popupHome.left;
                    popupPane.style.top = popupHome.top;
                    popupPane.classList.remove('on-map-editor-popups');
                }
                env.removeEventListener('resize', positionTools);
                env.removeEventListener('mapmodechange', onModeChange);
                env.removeEventListener('threeModeReady', onModeChange);
                doc.removeEventListener('keydown', onKeydown);
                controls?.removeEventListener('change', positionTools);
                panelResize?.disconnect();
                session.placement?.destroy();
                disabledButtons.forEach(({ button, disabled }) => { button.disabled = disabled; });
                suspended.forEach(({ element, display }) => { if (element.isConnected) element.style.display = display; });
                root.remove();
                if (active === session) active = null;
                doc.body.classList.remove('on-map-editing');
                env.__mapEditLock.release(options.owner);
                announce();
                if (focusReturn?.isConnected) focusReturn.focus?.({ preventScroll: true });
                map.invalidateSize?.({ pan: false });
            }

            const session = {
                root, panel, content, body, footer, tools, map, pane, handlePane, modes,
                owner: options.owner,
                get collapsed() { return collapsed; },
                setCollapsed,
                setHint(value) {
                    if (closed) return;
                    customHint = value == null ? null : String(value);
                    updateHint();
                },
                get preview() { return preview; },
                setPreview(detail) { if (closed) return; preview = detail || null; announce(); },
                setAnchor(value) { anchor = value; if (!anchor) tools.hidden = true; else positionTools(); },
                fitFeature(feature, settings = {}) {
                    if (!feature) return;
                    if (env.isThreeModeActive?.()) { pendingFit = { feature, settings }; return; }
                    pendingFit = null;
                    map.invalidateSize?.({ pan: false });
                    const bounds = env.L.geoJSON(feature).getBounds();
                    if (!bounds?.isValid?.()) return;
                    const mobile = env.innerWidth < 640;
                    const panelRect = panel.getBoundingClientRect();
                    // A host whose tool card floats over the top of the map (reserveToolsSpace) gets the
                    // shape fitted below it on every screen size, not only phones: on desktop the
                    // card covered the top of the land being edited. The extra room on desktop is
                    // for the card's drawing row, which appears while a line or plot is drawn.
                    const toolsBottom = options.reserveToolsSpace ? tools.getBoundingClientRect().bottom : 0;
                    map.fitBounds(bounds, {
                        paddingTopLeft: [48, toolsBottom ? Math.max(90, toolsBottom + (mobile ? 8 : 56)) : 90],
                        paddingBottomRight: mobile
                            ? [24, Math.min(env.innerHeight * 0.62, env.innerHeight - panelRect.top + 24)]
                            : [panelRect.width + 48, 100],
                        maxZoom: settings.maxZoom || 21,
                        animate: false
                    });
                },
                close
            };
            active = session;
            try {
                for (const [name, z] of [[pane, 655], [handlePane, 675]]) {
                    const layerPane = map.getPane(name) || map.createPane(name);
                    layerPane.style.zIndex = String(z);
                }
                if (popupHome?.parent) {
                    map.closePopup();
                    mapContainer.appendChild(popupPane);
                    popupPane.classList.add('on-map-editor-popups');
                    positionPopupPane();
                }
                suspended.forEach(({ element }) => { element.style.display = 'none'; });
                doc.body.appendChild(root);
                doc.body.classList.add('on-map-editing');
                env.hideProposalDetailsPanel?.(true);
                env.hideParcelInfoPanel?.();
                env.clearParcelHover?.();
                env.releaseEditorSeededMultiSelection?.();
                env.ClickStack?.close();
                env.MapShell?.closeSheet?.({ restoreFocus: false });
                map.on('move zoom resize', positionTools);
                map.on('move zoom resize', positionPopupPane);
                map.on('popupopen', onPopupOpen);
                map.on('popupclose', onPopupClose);
                env.addEventListener('resize', positionTools);
                env.addEventListener('mapmodechange', onModeChange);
                env.addEventListener('threeModeReady', onModeChange);
                doc.addEventListener('keydown', onKeydown);
                panelResize?.observe(panel);
                if (options.placement) {
                    if (!env.OnMapPlacement?.create) throw new Error('Placement controls are unavailable.');
                    session.placement = env.OnMapPlacement.create({ ...options.placement, session }, env);
                }
                setCollapsed(false);
                syncMode(false);
                const desired = env.__mapModeState?.desired || '2d';
                if (!modes.includes(desired)) Promise.resolve().then(() => { if (!closed) env.requestMapMode?.(modes[0]); });
                return session;
            } catch (error) {
                close();
                throw error;
            }
        }

        return {
            open,
            isActive: () => !!active,
            getOwner: () => active?.owner || null,
            getPreview: () => active?.preview || null,
            allowsMode: mode => !active || active.modes.includes(mode)
        };
    }

    if (global.document) global.OnMapEditor = createRuntime(global);
    if (typeof module !== 'undefined' && module.exports) module.exports = { createRuntime };
})(typeof window !== 'undefined' ? window : globalThis);
