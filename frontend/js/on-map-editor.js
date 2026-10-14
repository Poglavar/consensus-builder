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
            if (!env.__mapEditLock?.claim(options.owner, options.title || options.owner)) return null;
            const modes = options.modes?.length ? options.modes.slice() : ['2d', 'model'];
            const root = node('section', 'on-map-editor');
            root.id = options.id || `${options.owner}-editor`;
            root.setAttribute('aria-label', options.title || '');
            const panel = node('aside', `on-map-editor__panel${options.wide ? ' on-map-editor__panel--wide' : ''}`, root);
            const header = node('header', 'on-map-editor__header', panel);
            const heading = node('h2', '', header, options.title || '');
            heading.id = `${root.id}-title`;
            panel.setAttribute('aria-labelledby', heading.id);
            const cancel = node('button', 'close-circle-btn', header, '×');
            cancel.type = 'button';
            cancel.setAttribute('aria-label', text('cancel', 'Cancel'));
            cancel.addEventListener('click', () => options.onCancel?.());
            const content = node('div', 'on-map-editor__content', panel);
            const views = node('div', 'on-map-editor__views', content);
            views.hidden = modes.length < 2;
            views.setAttribute('role', 'group');
            views.setAttribute('aria-label', text('view', 'View'));
            modes.forEach(mode => {
                const button = node('button', 'btn btn-quiet', views,
                    mode === '2d' ? text('mapView', '2D map') : text('modelView', '3D model'));
                button.type = 'button';
                button.dataset.editorView = mode;
                button.addEventListener('click', () => env.requestMapMode?.(mode));
            });
            const hint = node('p', 'on-map-editor__hint', content);
            const body = node('div', 'on-map-editor__body', content);
            appendContent(body, options.content);
            const footer = node('footer', 'on-map-editor__footer', panel);
            appendContent(footer, options.footer);
            footer.hidden = !options.footer;
            const tools = node('div', 'on-map-editor__tools', root);
            appendContent(tools, options.tools);
            tools.hidden = !options.tools;
            const map = env.map;
            const disabledButtons = Object.entries(modeButtons).filter(([mode]) => !modes.includes(mode))
                .map(([, id]) => doc.getElementById(id)).filter(Boolean)
                .map(button => ({ button, disabled: button.disabled }));
            const suspended = [...doc.querySelectorAll('.create-proposal-modal, #proposal-editor-shell.is-open')]
                .map(element => ({ element, display: element.style.display }));
            const focusReturn = doc.activeElement;
            let controls = null;
            let closed = false;
            let anchor = null;
            let preview = null;
            let pendingFit = null;

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
                const right = mobile ? env.innerWidth - 12 : rect.left - 12;
                const bottom = mobile ? rect.top - 12 : env.innerHeight - 100;
                const width = tools.offsetWidth || 160;
                const height = tools.offsetHeight || 44;
                tools.style.left = `${Math.max(12, Math.min(point.x - width / 2, right - width))}px`;
                tools.style.top = `${Math.max(76, Math.min(point.y + 28, bottom - height))}px`;
            }

            function syncMode(notify = true) {
                const mode = env.__mapModeState?.desired || (env.isThreeModeActive?.() ? 'model' : '2d');
                views.querySelectorAll('[data-editor-view]').forEach(button => {
                    button.setAttribute('aria-pressed', String(button.dataset.editorView === mode));
                });
                hint.textContent = options.hints?.[mode] || '';
                hint.hidden = !hint.textContent;
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
                if (options.handleEscape === false || event.defaultPrevented || event.key !== 'Escape') return;
                // A nested confirmation or specialized popup gets first use of Escape.
                if ([...doc.querySelectorAll('.cb-dialog-overlay')]
                    .some(element => !element.hidden && element.getClientRects().length > 0)) return;
                event.preventDefault();
                options.onCancel?.();
            }
            function close() {
                if (closed) return;
                closed = true;
                map.off('move zoom resize', positionTools);
                env.removeEventListener('resize', positionTools);
                env.removeEventListener('mapmodechange', onModeChange);
                env.removeEventListener('threeModeReady', onModeChange);
                doc.removeEventListener('keydown', onKeydown);
                controls?.removeEventListener('change', positionTools);
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
                get preview() { return preview; },
                setPreview(detail) { if (closed) return; preview = detail || null; announce(); },
                setAnchor(value) { anchor = value; positionTools(); },
                fitFeature(feature, settings = {}) {
                    if (!feature) return;
                    if (env.isThreeModeActive?.()) { pendingFit = { feature, settings }; return; }
                    pendingFit = null;
                    map.invalidateSize?.({ pan: false });
                    const bounds = env.L.geoJSON(feature).getBounds();
                    if (!bounds?.isValid?.()) return;
                    const mobile = env.innerWidth < 640;
                    const panelRect = panel.getBoundingClientRect();
                    map.fitBounds(bounds, {
                        paddingTopLeft: [48, mobile && options.reserveToolsSpace
                            ? Math.max(90, tools.getBoundingClientRect().bottom + 8) : 90],
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
                suspended.forEach(({ element }) => { element.style.display = 'none'; });
                doc.body.appendChild(root);
                doc.body.classList.add('on-map-editing');
                env.hideProposalDetailsPanel?.(true);
                env.hideParcelInfoPanel?.();
                env.clearParcelHover?.();
                env.releaseEditorSeededMultiSelection?.();
                env.__drillUi?.hidePanel?.();
                env.MapShell?.closeSheet?.({ restoreFocus: false });
                map.on('move zoom resize', positionTools);
                env.addEventListener('resize', positionTools);
                env.addEventListener('mapmodechange', onModeChange);
                env.addEventListener('threeModeReady', onModeChange);
                doc.addEventListener('keydown', onKeydown);
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
