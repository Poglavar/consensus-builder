// The click stack panel (click-stack.md): one right-docked column of sections for everything under
// a map click. Each section is a one-line row; the expanded one hosts its action view — the
// existing planning inspector, proposal card or parcel info panel is moved into it while it is
// expanded and put back when it is not. Ordering and choices come from click-stack-model.js.
(function (global) {
    'use strict';

    const doc = global.document;
    const model = global.__clickStackModel;
    const PANEL_ID = 'click-stack';
    const MEMORY_KEY = 'cb.clickStack.expanded';
    // The existing panels a section shows when expanded, first visible wins.
    const HOSTS = Object.freeze({
        designs: ['proposal-details-panel'],
        built: ['planning-inspector'],
        permitted: ['planning-inspector'],
        selection: ['parcel-info-panel'],
        formed: ['parcel-info-panel'],
        parcels: ['parcel-info-panel']
    });
    const HOSTABLE = ['proposal-details-panel', 'planning-inspector', 'parcel-info-panel'];
    // Right-dock panels the stack never hosts: when one opens, the stack steps aside.
    const DOCKED_ELSEWHERE = ['block-info-panel', 'road-info-panel', 'road-analysis-panel'];
    const ICONS = Object.freeze({ plans: 'fas fa-layer-group', designs: 'fas fa-drafting-compass', built: 'fas fa-building',
        permitted: 'fas fa-cube', formed: 'fas fa-vector-square', parcels: 'fas fa-border-all', selection: 'fas fa-object-group', ground: 'fas fa-seedling' });

    const state = { el: null, stack: null, latlng: null, hits: null, hosted: null, expanding: false, lastClick: null, observing: false, memberships: null, membershipVersion: 0, membershipDesign: null };

    // A key with a dot is a full key shared with the rest of the app; a bare one is clickStack's own.
    function t(key, fallback, params = {}) {
        const full = key.includes('.') ? key : `clickStack.${key}`;
        const value = global.i18n?.t?.(full, params);
        if (typeof value === 'string' && value && value !== full) return value;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }
    const log = (...args) => console.info(`[${new Date().toISOString()}] [ClickStack]`, ...args);

    function remembered() {
        try { return global.localStorage.getItem(MEMORY_KEY) || null; } catch (_) { return null; }
    }
    function remember(kind) {
        try { if (kind) global.localStorage.setItem(MEMORY_KEY, kind); } catch (_) { /* memory is a convenience */ }
    }

    function blocked(options) {
        try { return global.__mapEditLock ? global.__mapEditLock.blocksSelection(options) : false; } catch (_) { return false; }
    }

    // ── hosting existing panels ───────────────────────────────────────────────────────────────

    function isShown(el) {
        if (!el) return false;
        return el.id === 'planning-inspector' ? !el.hidden : el.classList.contains('visible');
    }

    function isDockOccupied() {
        return DOCKED_ELSEWHERE.some(id => isShown(doc.getElementById(id))) || !!global.AgreementPanel?.isOpen?.();
    }

    function host(slot, id) {
        const el = doc.getElementById(id);
        if (!el || state.hosted?.el === el) return;
        unhost({ hide: false });
        state.hosted = { el, parent: el.parentNode, next: el.nextSibling };
        el.classList.add('is-hosted');
        slot.appendChild(el);
        if (id === 'parcel-info-panel') {
            // The section's row folds and the stack closes, so the panel's − and × are hidden there
            // (css/map.css) and it is never left minimized. Point-specific proposals have their
            // own Designs section; a selected set keeps Proposals to list designs on all its land.
            global.ParcelsUIParcelPanel?.setParcelInfoPanelMinimized?.(el, false);
            const selected = model.selectedInstance(state.stack, state.stack.selectedKind);
            if (state.stack.selectedKind === 'parcels' && selected?.live === false) global.switchParcelTab?.(null, 'info-tab');
            else if (state.stack?.expanded !== 'selection' && el.querySelector('[data-parcel-tab-id="proposals-tab"][aria-selected="true"]')) global.switchParcelTab?.(null, 'propose-tab');
        }
        // A design's panel has no − in the stack either: it is never left minimized there.
        if (id === 'proposal-details-panel' && el.classList.contains('is-minimized')) global.toggleProposalDetailsPanelMinimized?.();
    }

    // Puts the hosted panel back where it lives; hide also closes it (the section collapsed or the
    // stack closed), which its own hide function does with the right cleanup.
    function unhost({ hide = true } = {}) {
        const hosted = state.hosted;
        if (!hosted) return;
        state.hosted = null;
        hosted.el.classList.remove('is-hosted');
        hosted.el.querySelector('.click-stack__actions--parcel')?.remove();
        if (hosted.parent) hosted.parent.insertBefore(hosted.el, hosted.next && hosted.next.parentNode === hosted.parent ? hosted.next : null);
        if (!hide) return;
        if (hosted.el.id === 'planning-inspector') global.PlanningViews?.select(null);
        else if (hosted.el.id === 'proposal-details-panel') global.hideProposalDetailsPanel?.(true);
        else if (hosted.el.id === 'parcel-info-panel') global.hideParcelInfoPanel?.();
    }

    // A panel the stack did not open (a list, a route, an editor) takes the dock: the stack steps
    // aside. A hosted panel closing itself collapses its section.
    function observePanels() {
        if (state.observing || typeof global.MutationObserver !== 'function') return;
        state.observing = true;
        const observer = new global.MutationObserver(mutations => {
            if (state.expanding) return;
            if (!isOpen()) {
                // A docked panel may have made the stack step aside. When that panel closes,
                // restore the selected-parcels stack; while it remains open, syncSelection's
                // guard keeps the two surfaces from reopening each other.
                const dockChanged = mutations?.some(mutation => [...DOCKED_ELSEWHERE, 'agreement-panel'].some(id => doc.getElementById(id) === mutation.target));
                if (dockChanged && !isDockOccupied()) syncSelection();
                return;
            }
            // The agreement panel (an agreement's Details) is a full dock of its own.
            if (global.AgreementPanel?.isOpen?.()) { close({ keepPanels: true }); return; }
            const expanded = state.stack?.expanded;
            // The expanded section's view moved on inside its own kind (a design's summary opened
            // its full card): the section hosts the new panel.
            const own = (HOSTS[expanded] || []).map(id => doc.getElementById(id)).find(isShown);
            if (own && own !== state.hosted?.el) { host(bodyOf(expanded), own.id); return; }
            // An outsider is checked before a closed hosted panel: opening one often closes ours,
            // and collapsing then would run our panel's cleanup over the panel that just opened.
            const outsider = [...HOSTABLE, ...DOCKED_ELSEWHERE].map(id => doc.getElementById(id))
                .find(el => el && isShown(el) && !el.classList.contains('is-hosted'));
            if (outsider) { close({ keepPanels: true }); return; }
            if (state.hosted && !isShown(state.hosted.el)) collapse();
        });
        [...HOSTABLE, ...DOCKED_ELSEWHERE, 'agreement-panel'].forEach(id => {
            const el = doc.getElementById(id);
            if (el) observer.observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] });
        });
        // The 3D view and the map's own sheets (tools, layers) take the screen: the 2D stack closes.
        new global.MutationObserver(() => {
            const body = doc.body.classList;
            if (body.contains('three-mode-active') || body.contains('map-sheet-open') || body.contains('on-map-editing')) {
                if (isOpen()) close({ keepSelection: true });
            } else if ((global.multiParcelSelection?.isActive || global.multiParcelSelection?.selectedParcels?.size) && !isOpen()) syncSelection();
        }).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    }

    // ── the element ───────────────────────────────────────────────────────────────────────────

    function ensureElement() {
        if (state.el && doc.body.contains(state.el)) return state.el;
        const el = doc.createElement('aside');
        el.id = PANEL_ID;
        el.className = 'click-stack right-dock-panel';
        el.hidden = true;
        el.addEventListener('click', onPanelClick);
        el.addEventListener('change', onPanelChange);
        el.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (state.stack?.topRef === 'selection:current') dismissSelection();
            else close();
        });
        (doc.getElementById('map-container') || doc.body).appendChild(el);
        state.el = el;
        return el;
    }

    function button(className, text, data = {}) {
        const node = doc.createElement('button');
        node.type = 'button';
        node.className = className;
        if (text !== undefined) node.textContent = text;
        Object.entries(data).forEach(([key, value]) => { node.dataset[key] = value; });
        return node;
    }

    function parcelReference(instance) {
        return global.ParcelMenuModel?.displayParcelId?.(instance?.feature?.properties || {}, instance?.id) || instance?.id || '';
    }

    function rowTitle(section) {
        const instance = section.instances[section.selectedIndex];
        switch (section.kind) {
            case 'selection': return t('selectedParcels.count', 'Selected parcels ({{count}})', { count: section.count });
            case 'plans': return t('designMemberships.plan', 'Plan');
            case 'designs': return section.count > 1 ? t('designs', 'Designs ({{count}})', { count: section.count }) : t('proposalDrafts.tabs.design', 'Design');
            case 'built': return section.count > 1 ? t('buildings', 'Buildings ({{count}})', { count: section.count }) : t('building', 'Building');
            case 'permitted': return section.multi ? t('permittedMany', 'Permitted ({{count}})', { count: section.count }) : t('planningViews.permitted', 'Permitted');
            case 'formed': return section.multi ? t('formedMany', 'Formed parcels ({{count}})', { count: section.count }) : t('formed', 'Formed parcel');
            case 'parcels': return section.count > 1 ? t('parcels', 'Parcels ({{count}})', { count: section.count })
                : t('parcel', 'Cadastral parcel');
            case 'ground': {
                const text = global.GroundMenuModel?.describeGround(global.GroundMenu?.factsAt(state.latlng)?.kind) || {};
                return text.titleKey ? global.i18n.t(text.titleKey) : t('groundMenu.title.noCadastre', 'Open ground');
            }
            default: return instance?.label || '';
        }
    }

    function rowDetail(section) {
        const instance = section.instances[section.selectedIndex];
        if (!instance) return '';
        if (section.kind === 'selection') return instance.area === null ? '' : global.CbFormat.formatArea(instance.area);
        if (section.kind === 'built' && instance.demolition) {
            const by = instance.demolition.proposalKey || instance.demolition.proposalId;
            const design = by ? global.proposalStorage?.getProposal?.(by) : null;
            return design ? t('demolishedBy', 'Demolished by {{design}}', { design: design.title || by }) : t('demolished', 'Demolished');
        }
        if (section.kind === 'ground') return '';
        if (section.kind === 'parcels' || section.kind === 'formed') return parcelReference(instance);
        return instance.label || '';
    }

    function render({ keepBody = null } = {}) {
        const el = ensureElement();
        const { stack } = state;
        // The hosted panel goes home (still open) before the old bodies are dropped; the section
        // that expands next hosts it again.
        if (state.hosted && !keepBody) unhost({ hide: false });
        el.textContent = '';
        el.setAttribute('aria-label', stack.topRef === 'selection:current'
            ? t('selectedParcels.label', 'Selected parcels') : t('title', 'At this spot'));
        const list = doc.createElement('div');
        list.className = 'click-stack__sections';
        stack.sections.forEach(section => {
            const expanded = stack.expanded === section.kind;
            const wrap = doc.createElement('section');
            wrap.className = 'click-stack__section';
            wrap.dataset.kind = section.kind;
            wrap.classList.toggle('is-expanded', expanded);
            wrap.classList.toggle('is-selected', stack.selectedKind === section.kind);
            const instance = section.instances[section.selectedIndex];
            const card = doc.createElement('div');
            card.className = 'click-stack__card';
            card.id = `click-stack-${section.kind}-card`;
            const row = button('click-stack__row', undefined, { action: 'row', kind: section.kind });
            row.disabled = !section.expandable;
            if (section.expandable) row.setAttribute('aria-expanded', String(expanded));
            const icon = doc.createElement('i');
            icon.className = ICONS[section.kind] || 'fas fa-circle';
            icon.setAttribute('aria-hidden', 'true');
            const name = doc.createElement('span');
            name.className = 'click-stack__row-title';
            // The selector counts the collection; the card always describes one selected item.
            name.textContent = rowTitle(section.multi ? { ...section, multi: false, count: 1 } : section);
            if (section.multi && (section.kind !== 'designs' || expanded)) name.textContent += ` (${section.count})`;
            const detail = doc.createElement('span');
            detail.className = 'click-stack__row-detail';
            detail.textContent = rowDetail(section);
            row.append(icon, name);
            if (section.kind === 'designs' && expanded) {
                const pill = global.ClickStackRelations?.renderDesignType(instance, doc, global);
                if (pill) row.appendChild(pill);
            }
            row.appendChild(detail);
            if (section.expandable) {
                const chevron = doc.createElement('i');
                chevron.className = 'click-stack__chevron fas fa-chevron-down';
                chevron.setAttribute('aria-hidden', 'true');
                row.appendChild(chevron);
            }
            const heading = doc.createElement('div');
            heading.className = 'click-stack__heading';
            heading.appendChild(row);
            card.appendChild(heading);
            if (expanded) {
                const body = keepBody || doc.createElement('div');
                body.className = 'click-stack__body';
                const selector = global.ClickStackRelations?.renderSelector(section, doc, global);
                if (selector && !keepBody) body.appendChild(selector);
                card.appendChild(body);
            }
            wrap.appendChild(card);
            list.appendChild(wrap);
        });
        el.appendChild(list);
        if (state.latlng) {
            const coords = button('click-stack__coords', `${state.latlng.lat.toFixed(6)}, ${state.latlng.lng.toFixed(6)}`, { action: 'coords' });
            coords.title = t('copyCoordinates', 'Copy coordinates');
            el.appendChild(coords);
        }
    }

    function bodyOf(kind) {
        return state.el?.querySelector(`.click-stack__section[data-kind="${kind}"] .click-stack__body`) || null;
    }

    // ── section bodies ────────────────────────────────────────────────────────────────────────

    // The main action of a section: what a person most often came to the spot to do.
    const MAIN_COMMANDS = new Set(['ground.drawSite']);

    function renderCommands(body, surface, context, className) {
        const translate = key => global.i18n?.t?.(key) || key;
        const actions = doc.createElement('div');
        actions.className = `cb-actions click-stack__actions ${className || ''}`;
        global.UiCommands.commandsFor(surface, context).forEach(entry => {
            const node = button(MAIN_COMMANDS.has(entry.id) ? 'btn btn-sm btn-primary' : 'btn btn-sm', undefined, { command: entry.id });
            const icon = doc.createElement('i');
            icon.className = entry.icon;
            icon.setAttribute('aria-hidden', 'true');
            const label = doc.createElement('span');
            label.textContent = global.UiCommands.labelOf(entry, translate);
            node.append(icon, label);
            actions.appendChild(node);
        });
        if (actions.childElementCount) body.appendChild(actions);
        return actions;
    }

    function withoutCameraMoves(run) {
        const previous = global.suppressCameraMoves;
        global.suppressCameraMoves = true;
        try { return run(); } finally { global.suppressCameraMoves = previous; }
    }

    function focusStyle() {
        return global.MapHighlight.style({ weight: 5, className: 'click-stack-map-focus' });
    }

    function highlightSection(kind, instance) {
        const features = global.ClickStackHits.featuresFor?.(kind, instance) || [];
        global.highlightFeaturesForHover?.(features, focusStyle());
    }

    // Selects what the expanded section shows (with its map highlight) and hosts its panel.
    function activate(kind) {
        const section = state.stack.sections.find(item => item.kind === kind);
        const instance = section ? section.instances[section.selectedIndex] : null;
        const body = bodyOf(kind);
        if (!instance || !body) return;
        state.expanding = true;
        try {
            global.highlightFeaturesForHover?.([]);
            if (kind !== 'designs' && kind !== 'selection') {
                global.clearProposalHighlights?.();
                global.ProposalSelection?.clear?.();
            }
            if (kind === 'plans') {
                unhost();
                const version = state.membershipVersion;
                const mount = () => {
                    if (body.isConnected) global.DesignMemberships.mountSection(body, kind, instance, state.memberships, global, {
                        hits: state.hits, onFocus: item => {
                            if (state.membershipVersion === version && state.stack?.selectedKind === kind
                                && model.selectedInstance(state.stack, kind)?.id === item.id) highlightSection(kind, item);
                        }
                    });
                };
                if (global.DesignMemberships) mount();
                else global.ensureOptionalTool('designMemberships').then(mount).catch(error => global.showStyledAlert(error.message));
            } else if (kind === 'designs' && instance.serverId) {
                openPublishedDesign(instance);
            } else if (kind === 'designs') {
                selectDesign(instance.id);
            } else if (kind === 'built') {
                global.PlanningViews.inspectBuilding(instance.feature, instance.id);
            } else if (kind === 'permitted') {
                global.PlanningViews.selectAt(instance.id, state.latlng);
            } else if (kind === 'selection') {
                renderCommands(body, 'parcel-selection', global.UiCommands.createBrowserContext(global));
                if (section.count) global.multiParcelSelection.showSelectionInPanel();
                else {
                    unhost();
                    global.hideParcelInfoPanel?.();
                    const hint = doc.createElement('p');
                    hint.className = 'click-stack__facts';
                    hint.textContent = t('selectedParcels.empty', 'Click parcels to select them');
                    body.appendChild(hint);
                }
            } else if (kind === 'parcels' || kind === 'formed') {
                selectParcel(instance);
                // Only live ground takes new designs: an original a design has consumed is shown
                // for its record and history, and building happens on the pieces that replaced it.
                const facts = instance.live !== false && instance.feature ? global.ParcelMenu.factsFor(instance.id, instance.feature) : null;
                if (facts) renderCommands(body, 'parcel-menu', global.UiCommands.createBrowserContext(global, { parcel: facts }), 'click-stack__actions--parcel');
            } else if (kind === 'ground') {
                unhost();
                const facts = global.GroundMenu.factsAt(state.latlng);
                const text = global.GroundMenuModel.describeGround(facts.kind);
                const line = doc.createElement('p');
                line.className = 'click-stack__facts';
                line.textContent = global.i18n.t(text.factsKey);
                body.appendChild(line);
                renderCommands(body, 'ground-menu', global.UiCommands.createBrowserContext(global, { ground: facts, parcel: null }));
            }
            const target = (HOSTS[kind] || []).find(id => isShown(doc.getElementById(id)));
            if (target) host(body, target);
            else if (HOSTS[kind]) unhost();
            if (target === 'parcel-info-panel') {
                const toolbar = doc.getElementById(target)?.querySelector('.parcel-context-actions');
                const actions = body.querySelector('.click-stack__actions--parcel');
                if (toolbar && actions) toolbar.appendChild(actions);
                const customSite = body.querySelector('[data-command="selection.useAsSite"]');
                if (toolbar && customSite) {
                    const wrap = doc.createElement('div');
                    wrap.className = 'cb-actions click-stack__actions--parcel';
                    wrap.appendChild(customSite);
                    toolbar.appendChild(wrap);
                }
            }
            if (kind !== 'plans') {
                const relations = model.visibleContextFor(kind, instance, state.hits);
                for (const group of relations) body.appendChild(global.ClickStackRelations.renderGroup(group, doc, global));
            }
            if (!instance.serverId) highlightSection(kind, instance);
        } catch (error) {
            console.error(`[ClickStack] the ${kind} section could not open`, error);
        } finally {
            state.expanding = false;
        }
    }

    // The design's actions panel opens in the section directly (its Overview tab with the actions
    // below it), not the planning inspector's summary with a further "Proposal actions" button.
    function selectDesign(key) {
        global.selectAndHighlightProposal(key, null, false, true, false, { hosted: true, presentation: 'details' });
    }

    // A published proposal on the clicked parcel that this browser holds no copy of: imported first
    // (as the parcel's proposal list does), then shown in the section if it is still the one chosen.
    async function openPublishedDesign(instance) {
        let key;
        try {
            const proposal = await global.DesignSync.importDesign(await global.DesignSync.fetchDesign(instance.serverId));
            key = global.getProposalKey(proposal) || proposal.proposalId;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [ClickStack] published proposal ${instance.serverId} could not be loaded`, error);
            global.updateStatus?.(t('modal.roadWidth.proposalList.downloadError', 'Failed to download proposal'));
            return;
        }
        if (!isOpen() || state.stack.selectedKind !== 'designs' || model.selectedInstance(state.stack, 'designs')?.id !== instance.id) return;
        state.expanding = true;
        try {
            if (state.stack.expanded === 'designs') {
                selectDesign(key);
                const target = HOSTS.designs.find(id => isShown(doc.getElementById(id)));
                const body = bodyOf('designs');
                if (target && body) host(body, target);
            } else global.selectAndHighlightProposal(key, null, false, false, true);
            highlightSection('designs', { ...instance, id: key });
        } finally {
            state.expanding = false;
        }
    }

    // The published proposals of the clicked parcel arrived after the stack opened: the same spot is
    // shown again with them, keeping the chosen instances and the expanded section.
    function refreshSpot(latlng) {
        if (!isOpen() || state.latlng !== latlng) return;
        const hits = { ...global.ClickStackHits.hitsAt(latlng) };
        delete hits.agreements;
        if (state.memberships) {
            hits.plans = state.memberships.instances('plans', state.stack.selectedKind === 'plans');
            hits.designs = hits.designs.map(item => String(item.proposal?.proposalId) === state.memberships.proposalId
                ? { ...item, cid: state.memberships.cid } : item);
        }
        // A list can open a design that is not a geometry hit here.
        // A background lookup adds choices; it must not discard the object being inspected.
        const selectedKind = state.stack.selectedKind;
        const focused = model.selectedInstance(state.stack, selectedKind);
        if (focused && !(hits[selectedKind] || []).some(item => item.id === focused.id)) {
            hits[selectedKind] = [focused, ...(hits[selectedKind] || [])];
        }
        const selected = Object.fromEntries(state.stack.sections.map(section => [section.kind, section.instances[section.selectedIndex].id]));
        const next = model.buildClickStack(hits, { selected });
        const expanded = state.stack.expanded;
        state.hits = { ...hits };
        state.stack = expanded && next.sections.some(section => section.kind === expanded) ? model.expand(next, expanded)
            : { ...next, expanded: null, selectedKind: next.sections.some(section => section.kind === selectedKind) ? selectedKind : next.selectedKind };
        render();
        if (state.stack.expanded) activate(state.stack.expanded);
    }

    function selectParcel(instance) {
        if (instance.live !== false && global.LiveParcelFabric?.get?.(instance.id)) {
            withoutCameraMoves(() => global.ParcelsUISelection.selectParcelFromStack(instance.id));
        } else {
            // A consumed cadastral parcel: its panel opens from the registry.
            global.__claimsUi?.openBaseParcel?.(instance.id);
        }
    }

    // Multi-selection has no single click point. Its section replaces the point's parcel view
    // while picking or retaining selected land. The active mode also has an empty state.
    function dismissSelection() {
        const multi = global.multiParcelSelection;
        if (multi?.isActive) multi.finish();
        else global.cancelMultiParcelSelection();
    }

    function syncSelection() {
        const multi = global.multiParcelSelection;
        const wasSelection = state.stack?.topRef === 'selection:current';
        if (!multi?.isActive && !multi?.selectedParcels?.size) {
            if (wasSelection) close({ keepSelection: true });
            return;
        }
        const body = doc.body.classList;
        if (body.contains('three-mode-active') || body.contains('map-sheet-open') || body.contains('on-map-editing')
            || isDockOccupied()) return;
        const summary = model.summarizeSelection(Array.from(multi.selectedParcels), {
            featureFor: id => global.LiveParcelFabric?.get(String(id)),
            areaOf: feature => global.turf.area(feature)
        });
        const stack = model.buildSelectionStack(summary, { expanded: !wasSelection || state.stack.expanded === 'selection' });
        if (!wasSelection) show(stack, null, {});
        else {
            state.stack = stack;
            render();
            if (stack.expanded) activate('selection');
        }
    }

    // ── state changes ─────────────────────────────────────────────────────────────────────────

    function expand(kind) {
        if (!state.stack) return;
        if (!state.hosted && state.stack.selectedKind !== kind) {
            if (['parcels', 'formed'].includes(state.stack.selectedKind)) global.hideParcelInfoPanel?.();
            if (['built', 'permitted'].includes(state.stack.selectedKind)) global.PlanningViews?.select(null);
        }
        // Another section takes over: the old one's panel closes. Within one section (a strip
        // choice) the panel stays open and is hosted again for the new instance.
        if (state.hosted && state.stack.expanded !== kind) unhost();
        state.stack = model.expand(state.stack, kind);
        if (kind !== 'selection') remember(state.stack.expanded);
        render();
        activate(state.stack.expanded);
        if (kind === 'designs') syncMemberships();
    }

    // The expanded section's header clicked again: everything collapses to rows.
    function collapse() {
        if (!state.stack) return;
        const panel = state.hosted?.el;
        unhost({ hide: false });
        if (panel?.id === 'planning-inspector') panel.hidden = true;
        else if (panel) panel.classList.remove('visible');
        state.stack = { ...state.stack, expanded: null };
        render();
        highlightSection(state.stack.selectedKind, model.selectedInstance(state.stack, state.stack.selectedKind));
    }

    function show(stack, latlng, hits) {
        observePanels();
        ensureElement().classList.remove('is-folded');
        state.expanding = true;
        try {
            // Panels another surface opened step aside; the stack is now what describes the map.
            unhost();
            if (doc.getElementById('proposal-details-panel')?.classList.contains('visible')) global.hideProposalDetailsPanel?.(true);
            if (doc.getElementById('parcel-info-panel')?.classList.contains('visible')) global.hideParcelInfoPanel?.();
            if (global.PlanningViews?.isInspecting?.()) global.PlanningViews.select(null);
            if (global.AgreementPanel?.isOpen?.()) global.AgreementPanel.close();
        } finally { state.expanding = false; }
        state.stack = stack;
        state.latlng = latlng;
        state.hits = { ...hits };
        delete state.hits.agreements;
        render();
        const el = ensureElement();
        el.hidden = false;
        el.classList.add('visible');
        doc.body.classList.add('click-stack-open');
        if (stack.expanded) activate(stack.expanded);
        else highlightSection(stack.selectedKind, model.selectedInstance(stack, stack.selectedKind));
        syncMemberships(true);
    }

    function close({ keepPanels = false, keepSelection = false } = {}) {
        if (!isOpen()) return;
        if (keepPanels) {
            // Another surface took a hostable panel: release ours without closing theirs.
            if (state.hosted) unhost({ hide: false });
        } else if (keepSelection) {
            // A map sheet or the 3D view takes the screen: the panel goes out of sight, but what
            // was selected stays selected, so the sheet's tools (Detect block, isolation) act on it.
            const hosted = state.hosted?.el;
            if (hosted) {
                unhost({ hide: false });
                if (hosted.id === 'planning-inspector') hosted.hidden = true;
                else hosted.classList.remove('visible');
            }
        } else {
            unhost();
            if (['parcels', 'formed'].includes(state.stack?.selectedKind)) global.hideParcelInfoPanel?.();
            if (['built', 'permitted'].includes(state.stack?.selectedKind)) global.PlanningViews?.select(null);
            global.ProposalSelection?.clear?.();
            global.hideProposalDetailsPanel?.(true);
        }
        global.highlightFeaturesForHover?.([]);
        state.memberships?.dispose();
        state.memberships = null;
        state.membershipDesign = null;
        state.membershipVersion++;
        state.stack = null;
        state.hits = null;
        state.latlng = null;
        state.el.hidden = true;
        state.el.textContent = '';
        state.el.classList.remove('is-folded');
        state.el.classList.remove('visible');
        doc.body.classList.remove('click-stack-open');
    }

    // Before / after needs the map: the stack folds to its rows. The expanded section keeps its
    // panel hosted (hidden), so the comparison it started keeps running; a row click unfolds.
    function fold() {
        if (isOpen()) state.el.classList.add('is-folded');
    }

    function isOpen() {
        return !!(state.el && !state.el.hidden);
    }

    // ── input ─────────────────────────────────────────────────────────────────────────────────

    function onPanelClick(event) {
        const target = event.target.closest('[data-action], [data-command]');
        if (!target || !state.el.contains(target)) return;
        if (target.dataset.command) {
            const parcel = state.stack && model.selectedInstance(state.stack, state.stack.expanded === 'formed' ? 'formed' : 'parcels');
            const facts = state.stack?.expanded === 'ground'
                ? { ground: global.GroundMenu.factsAt(state.latlng), parcel: null }
                : { parcel: parcel ? global.ParcelMenu.factsFor(parcel.id, parcel.feature) : null };
            global.UiCommands.runCommand(target.dataset.command, global.UiCommands.createBrowserContext(global, facts));
            return;
        }
        const { action, kind, id } = target.dataset;
        if (action === 'row') {
            // A folded stack unfolds first: its open section's row shows that section again.
            if (state.el.classList.contains('is-folded')) {
                state.el.classList.remove('is-folded');
                if (state.stack.expanded === kind) return;
            }
            if (state.stack.expanded === kind) collapse(); else expand(kind);
        } else if (action === 'related') {
            const section = state.stack.sections.find(section => section.kind === kind);
            if (section?.instances.some(instance => instance.id === id)) {
                state.stack = model.selectInstance(state.stack, kind, id);
                expand(kind);
            } else if (kind === 'designs') {
                const related = model.selectedInstance(state.stack, state.stack.selectedKind)?.members?.find(item => item.id === id);
                if (related?.serverId) {
                    global.DesignSync.fetchDesign(related.serverId).then(row => global.DesignSync.importDesign(row))
                        .then(proposal => showDesign(proposal.proposalId)).catch(error => global.showStyledAlert(error.message));
                } else showDesign(id);
            }
            state.el.querySelector(`.click-stack__section[data-kind="${kind}"]`)?.scrollIntoView?.({ block: 'nearest' });
        } else if (action === 'coords') {
            const text = target.textContent;
            global.navigator.clipboard?.writeText(text).then(() => global.updateStatus?.(t('copied', 'Coordinates copied')),
                error => console.error('[ClickStack] coordinates could not be copied', error));
        }
    }

    function onPanelChange(event) {
        const target = event.target;
        if (target.dataset.action !== 'instance') return;
        state.stack = model.selectInstance(state.stack, target.dataset.kind, target.value);
        expand(target.dataset.kind);
    }

    function syncMemberships(force = false) {
        if (!global.loadDesignMemberships) return;
        const design = model.selectedInstance(state.stack, 'designs');
        const proposal = global.proposalStorage?.getProposal?.(design?.id) || design?.proposal;
        if (!proposal) return;
        const key = `${design.id}:${global.DesignSync?.publishedCid(proposal) || ''}`;
        if (!force && state.membershipDesign === key) return;
        state.memberships?.dispose();
        state.memberships = null;
        state.membershipDesign = key;
        const version = ++state.membershipVersion;
        global.loadDesignMemberships(proposal, session => {
            if (!isOpen() || version !== state.membershipVersion) return;
            const current = model.selectedInstance(state.stack, 'designs');
            const currentProposal = global.proposalStorage?.getProposal?.(current?.id) || current?.proposal;
            if (current?.id !== design.id || (global.DesignSync?.publishedCid(currentProposal) || null) !== session.cid) {
                session.dispose();
                syncMemberships(true);
                return;
            }
            state.memberships = session;
            const selected = Object.fromEntries(state.stack.sections.map(section => [section.kind, section.instances[section.selectedIndex].id]));
            const previous = state.stack;
            state.hits = { ...state.hits, plans: session.instances('plans', previous.selectedKind === 'plans') };
            // Annotate only the exact inspected revision for relationship matching.
            state.hits.designs = state.hits.designs.map(item => item.id === design.id ? { ...item, cid: session.cid } : item);
            const next = model.buildClickStack(state.hits, { selected });
            const has = kind => next.sections.some(section => section.kind === kind);
            state.stack = { ...next, expanded: previous.expanded && has(previous.expanded) ? previous.expanded : null,
                selectedKind: has(previous.selectedKind) ? previous.selectedKind : next.selectedKind, topRef: previous.topRef };
            const keepBody = previous.expanded !== 'plans' ? bodyOf(previous.expanded) : null;
            render({ keepBody });
            if (keepBody) {
                [...keepBody.children].filter(child => child.classList.contains('click-stack__choices')).forEach(child => child.remove());
                for (const group of model.visibleContextFor(previous.expanded, model.selectedInstance(state.stack, previous.expanded), state.hits)) {
                    keepBody.appendChild(global.ClickStackRelations.renderGroup(group, doc, global));
                }
            } else if (state.stack.expanded) activate(state.stack.expanded);
        }).then(session => {
            if (version !== state.membershipVersion) session?.dispose();
        }).catch(error => console.error(`[${new Date().toISOString()}] [ClickStack] memberships could not load`, error));
    }

    // Every entry point (a route, list, editor or click) uses its view's Design section.
    function showDesign(key) {
        const proposal = global.getProposalByIdOrHash?.(key) || global.proposalStorage?.getProposal?.(key);
        if (!proposal) throw new Error(`ClickStack: proposal ${key} is not stored`);
        const designKey = String(global.getProposalKey?.(proposal) || proposal.proposalId);
        if (doc.body.classList.contains('three-mode-active')) {
            return global.showThreeModeDesign(designKey);
        }
        const footprint = global.__planOrder?.footprintOf?.(proposal);
        const coordinates = footprint ? global.turf.pointOnFeature(footprint).geometry.coordinates : null;
        const latlng = coordinates ? global.L.latLng(coordinates[1], coordinates[0]) : null;
        const hits = latlng ? global.ClickStackHits.hitsAt(latlng, { onPublished: () => refreshSpot(latlng) }) : { designs: [] };
        // The new design is the one shown, also where something else stands above it at that point.
        if (!hits.designs.some(design => String(design.id) === designKey)) {
            hits.designs.unshift({ id: designKey, label: String(proposal.title || proposal.name || designKey),
                createdAt: proposal.createdAt, proposal, goal: proposal.goal || '' });
        }
        const stack = model.expand(model.buildClickStack(hits, { selected: { designs: designKey } }), 'designs');
        state.lastClick = null;
        log(`placed ${designKey}: ${stack.sections.map(section => `${section.kind}×${section.count}`).join(' ')}`);
        // No click opened this spot, so the first click on the design is a new one (it selects what
        // it hits, such as a road's stretch), not "the same spot again", which would close the stack.
        show({ ...stack, topRef: null }, latlng, hits);
    }

    function showParcel(feature) {
        const id = String(global.LiveParcelFabric.featureId(feature));
        if (doc.body.classList.contains('three-mode-active')) return global.showThreeModeParcel(id);
        const [lng, lat] = global.turf.pointOnFeature(feature).geometry.coordinates;
        const latlng = global.L.latLng(lat, lng);
        const hits = global.ClickStackHits.hitsAt(latlng);
        const kind = hits.formed?.some(item => item.id === id) ? 'formed' : 'parcels';
        hits[kind] = hits[kind] || [];
        if (!hits[kind].some(item => item.id === id)) hits[kind].unshift({ id, feature,
            label: global.ClickStackHits.parcelLabel(id, feature), live: !!global.LiveParcelFabric.get(id) });
        const stack = model.expand(model.buildClickStack(hits, { selected: { [kind]: id } }), kind);
        state.lastClick = null;
        show({ ...stack, topRef: null }, latlng, hits);
    }

    // Every map click on the 2D map arrives here, whichever layer received it. One physical click
    // can reach several layers' handlers; only the first counts.
    function handleClick(latlng, { allowUrbanBlocks = false } = {}) {
        if (!latlng) return false;
        // A surface picking designs (js/map-pick.js) takes the topmost design and nothing else. It
        // holds the edit lock itself, so it is asked before the lock refuses the click.
        if (global.MapPick?.active()) {
            const top = global.__drillUi?.stackAt(latlng).find(entry => entry.kind === 'proposal');
            if (top) global.MapPick.pick(top.key);
            return true;
        }
        if (blocked({ allowUrbanBlocks })) return false;
        const now = Date.now();
        // One physical click reaching several layers' handlers arrives within a few milliseconds.
        if (state.lastClick && now - state.lastClick.at < 50
            && state.lastClick.lat === latlng.lat && state.lastClick.lng === latlng.lng) return true;
        const click = { at: now, lat: latlng.lat, lng: latlng.lng };
        state.lastClick = click;
        // Bubbling handlers run in this event turn. A second physical click, even a quick one,
        // must still toggle the selection; a 50 ms window alone swallowed fast deselections.
        global.setTimeout?.(() => { if (state.lastClick === click) state.lastClick = null; }, 0);
        // Manual parcel selection owns the click through buildings, permitted massing and designs.
        // Resolve current live ground, never a proposal's source cadastral reference. Keep this
        // after deduplication so a bubbling surface click cannot toggle the parcel twice.
        if (global.multiParcelSelection?.isActive) {
            const parcel = global.__drillUi?.stackAt(latlng).find(entry => entry.kind === 'parcel'
                && global.LiveParcelFabric?.get(entry.id));
            const layer = parcel && global.ParcelPresenter?.getLayer(parcel.id);
            if (layer) global.multiParcelSelection.toggleParcel(layer);
            return true;
        }
        // An ordinary map click replaces the retained selection with the new point context.
        if (global.multiParcelSelection?.selectedParcels?.size) global.multiParcelSelection.clearSelection();
        const hits = global.ClickStackHits.hitsAt(latlng, { onPublished: () => refreshSpot(latlng) });
        const stack = model.buildClickStack(hits, { remembered: remembered() });
        const previous = isOpen() ? model.selectedInstance(state.stack, state.stack.selectedKind)?.ref : null;
        const next = model.selectedInstance(stack, stack.selectedKind)?.ref;
        const action = model.clickAction(previous || null, { ...stack, topRef: next || stack.topRef });
        log(`click ${latlng.lat.toFixed(6)},${latlng.lng.toFixed(6)}: ${stack.sections.map(section => `${section.kind}×${section.count}`).join(' ') || 'nothing'} → ${action}`);
        if (action === 'close') close();
        else if (action === 'open') show(stack, latlng, hits);
        else if (global.GroundMenu?.factsAt(latlng)?.kind === 'not-loaded') {
            global.updateStatus?.(global.i18n.t('groundMenu.notLoaded'));
        }
        return true;
    }

    doc.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.defaultPrevented || !isOpen()) return;
        if (global.isEditableTarget?.(event.target) || global.isAnyModalOpen?.()) return;
        event.preventDefault();
        if (state.stack?.topRef === 'selection:current') dismissSelection();
        else close();
    });
    doc.addEventListener('multi-parcel-selection-change', syncSelection);
    global.addEventListener('cityChanged', () => close());
    const relabel = () => { if (isOpen()) { const expanded = state.stack.expanded; render(); if (expanded) activate(expanded); } };
    global.addEventListener('i18n:translationsLoaded', relabel);

    // Selection owns the map focus, including while its details are collapsed.
    const holdsHighlight = () => isOpen() && !!state.stack?.selectedKind;
    global.ClickStack = Object.freeze({ handleClick, showDesign, showParcel, isDriving: () => state.expanding, syncSelection, fold, close, isOpen, expand, collapse, holdsHighlight,
        current: () => state.stack, point: () => state.latlng });
})(window);
