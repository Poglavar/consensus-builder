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
        designs: ['proposal-details-panel', 'planning-inspector'],
        built: ['planning-inspector'],
        permitted: ['planning-inspector'],
        formed: ['parcel-info-panel'],
        parcels: ['parcel-info-panel']
    });
    const HOSTABLE = ['proposal-details-panel', 'planning-inspector', 'parcel-info-panel'];
    // Right-dock panels the stack never hosts: when one opens, the stack steps aside.
    const DOCKED_ELSEWHERE = ['block-info-panel', 'road-info-panel', 'road-analysis-panel'];
    const ICONS = Object.freeze({ agreements: 'fas fa-file-signature', designs: 'fas fa-drafting-compass', built: 'fas fa-building',
        permitted: 'fas fa-cube', formed: 'fas fa-vector-square', parcels: 'fas fa-border-all', ground: 'fas fa-seedling' });

    const state = { el: null, stack: null, latlng: null, hits: null, hosted: null, expanding: false, lastClick: null, observing: false };

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

    function blocked() {
        try { return global.__mapEditLock ? global.__mapEditLock.blocksSelection() : false; } catch (_) { return false; }
    }

    // ── hosting existing panels ───────────────────────────────────────────────────────────────

    function isShown(el) {
        if (!el) return false;
        return el.id === 'planning-inspector' ? !el.hidden : el.classList.contains('visible');
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
            // (css/map.css) and it is never left minimized. Its proposals are the Designs section,
            // so its Proposals tab is hidden too and the panel shows Design instead.
            global.ParcelsUIParcelPanel?.setParcelInfoPanelMinimized?.(el, false);
            if (el.querySelector('[data-parcel-tab-id="proposals-tab"][aria-selected="true"]')) global.switchParcelTab?.(null, 'propose-tab');
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
        const observer = new global.MutationObserver(() => {
            if (!isOpen() || state.expanding) return;
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
            if (!isOpen()) return;
            const body = doc.body.classList;
            if (body.contains('three-mode-active') || body.contains('map-sheet-open')) close({ keepSelection: true });
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
        el.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
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
            case 'agreements': return section.multi ? t('agreements', 'Agreements ({{count}})', { count: section.count }) : t('agreement.panel.title', 'Agreement');
            case 'designs': return section.multi ? t('designs', 'Designs ({{count}})', { count: section.count }) : t('proposalDrafts.tabs.design', 'Design');
            case 'built': return section.count > 1 ? t('builtMany', 'Built ({{count}})', { count: section.count }) : t('threeMode.controls.built', 'Built');
            case 'permitted': return t('planningViews.permitted', 'Permitted');
            case 'formed': return instance?.designLabel ? t('formedBy', 'Formed by {{design}}', { design: instance.designLabel }) : t('formed', 'Formed parcel');
            case 'parcels': {
                const reference = parcelReference(instance);
                return t('parcelReference', 'Cadastral parcel {{reference}}', { reference });
            }
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
        if (section.kind === 'built' && instance.demolition) {
            const by = instance.demolition.proposalKey || instance.demolition.proposalId;
            const design = by ? global.proposalStorage?.getProposal?.(by) : null;
            return design ? t('demolishedBy', 'Demolished by {{design}}', { design: design.title || by }) : t('demolished', 'Demolished');
        }
        if (section.kind === 'ground' || section.kind === 'parcels') return '';
        if ((section.kind === 'parcels' || section.kind === 'formed') && instance.live !== false && instance.feature) {
            // The facts the parcel popover used to show: number · area · ownership · owners.
            const facts = global.ParcelMenu.factsFor(instance.id, instance.feature);
            return [instance.label, global.ParcelMenu.factsLine(facts)].filter(Boolean).join(' · ');
        }
        return instance.label || '';
    }

    function renderStrip(section) {
        const strip = doc.createElement('div');
        strip.className = 'click-stack__strip';
        strip.setAttribute('role', 'group');
        strip.setAttribute('aria-label', rowTitle(section));
        section.instances.forEach((instance, index) => {
            const chip = button('click-stack__chip', instance.label || instance.id, { action: 'instance', kind: section.kind, id: instance.id });
            chip.setAttribute('aria-pressed', String(index === section.selectedIndex));
            strip.appendChild(chip);
        });
        return strip;
    }

    function render() {
        const el = ensureElement();
        const { stack } = state;
        // The hosted panel goes home (still open) before the old bodies are dropped; the section
        // that expands next hosts it again.
        if (state.hosted) unhost({ hide: false });
        el.textContent = '';
        el.setAttribute('aria-label', t('title', 'At this spot'));
        const list = doc.createElement('div');
        list.className = 'click-stack__sections';
        stack.sections.forEach(section => {
            const expanded = stack.expanded === section.kind;
            const wrap = doc.createElement('section');
            wrap.className = 'click-stack__section';
            wrap.dataset.kind = section.kind;
            wrap.classList.toggle('is-expanded', expanded);
            const row = button('click-stack__row', undefined, { action: 'row', kind: section.kind });
            row.disabled = !section.expandable;
            if (section.expandable) row.setAttribute('aria-expanded', String(expanded));
            const icon = doc.createElement('i');
            icon.className = ICONS[section.kind] || 'fas fa-circle';
            icon.setAttribute('aria-hidden', 'true');
            const name = doc.createElement('span');
            name.className = 'click-stack__row-title';
            name.textContent = rowTitle(section);
            const detail = doc.createElement('span');
            detail.className = 'click-stack__row-detail';
            detail.textContent = rowDetail(section);
            row.append(icon, name, detail);
            if (section.expandable) {
                const chevron = doc.createElement('i');
                chevron.className = 'click-stack__chevron fas fa-chevron-down';
                chevron.setAttribute('aria-hidden', 'true');
                row.appendChild(chevron);
            }
            const heading = doc.createElement('div');
            heading.className = 'click-stack__heading';
            heading.appendChild(row);
            if (section.kind === 'parcels') {
                const reference = parcelReference(section.instances[section.selectedIndex]);
                const copy = button('btn btn-quiet btn-sm btn-icon click-stack__copy-reference', undefined, { action: 'parcel-reference', reference });
                const hint = t('common.copyToClipboard', 'Copy to clipboard');
                copy.setAttribute('aria-label', `${hint}: ${reference}`);
                copy.title = hint;
                const icon = doc.createElement('i');
                icon.className = 'fas fa-copy';
                icon.setAttribute('aria-hidden', 'true');
                copy.appendChild(icon);
                heading.appendChild(copy);
            }
            wrap.appendChild(heading);
            if (section.multi) wrap.appendChild(renderStrip(section));
            if (expanded) {
                const body = doc.createElement('div');
                body.className = 'click-stack__body';
                wrap.appendChild(body);
            }
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

    function designFootprint(key) {
        const proposal = global.proposalStorage?.getProposal?.(key);
        try { return proposal ? global.__planOrder?.footprintOf?.(proposal) || null : null; } catch (_) { return null; }
    }

    function renderAgreement(body, instance) {
        const agreement = instance.agreement;
        const summary = doc.createElement('div');
        summary.className = 'click-stack__summary';
        const name = doc.createElement('strong');
        name.textContent = agreement.title || agreement.id;
        const facts = doc.createElement('span');
        facts.className = 'click-stack__facts';
        facts.textContent = t('designs', 'Designs ({{count}})', { count: agreement.designs.length });
        summary.append(name, facts);
        const actions = doc.createElement('div');
        actions.className = 'cb-actions click-stack__actions';
        actions.append(button('btn btn-sm', t('showDesigns', 'Show its designs'), { action: 'agreement-designs', id: agreement.id }),
            button('btn btn-sm btn-primary', t('proposalDrafts.tabs.details', 'Details'), { action: 'agreement-details', id: agreement.id }));
        body.append(summary, actions);
        showAgreementDesigns(agreement, { fit: false });
    }

    function showAgreementDesigns(agreement, { fit = true } = {}) {
        const features = agreement.designs.map(design => designFootprint(String(design.proposalId))).filter(Boolean);
        global.highlightFeaturesForHover?.(features);
        if (!fit || !features.length || !global.L || !global.map) return;
        try {
            const bounds = global.L.geoJSON({ type: 'FeatureCollection', features }).getBounds();
            if (bounds.isValid() && !global.map.getBounds().contains(bounds)) global.map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
        } catch (error) { console.error('[ClickStack] agreement designs could not be framed', error); }
    }

    // The agreements a design at this spot belongs to, as the same strip the sections use.
    function renderDesignAgreements(body, design) {
        const agreements = (state.hits?.agreements || []).filter(item => item.designIds.includes(String(design.id))
            || item.designIds.includes(String(design.proposal?.proposalId)));
        if (!agreements.length) return;
        const strip = doc.createElement('div');
        strip.className = 'click-stack__strip click-stack__strip--inline';
        const label = doc.createElement('span');
        label.className = 'click-stack__strip-label';
        label.textContent = t('inAgreements', 'In agreements ({{count}})', { count: agreements.length });
        strip.appendChild(label);
        agreements.forEach(item => strip.appendChild(button('click-stack__chip', item.label, { action: 'open-agreement', id: item.id })));
        body.appendChild(strip);
    }

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

    // Selects what the expanded section shows (with its map highlight) and hosts its panel.
    function activate(kind) {
        const section = state.stack.sections.find(item => item.kind === kind);
        const instance = section ? section.instances[section.selectedIndex] : null;
        const body = bodyOf(kind);
        if (!instance || !body) return;
        state.expanding = true;
        try {
            global.highlightFeaturesForHover?.([]);
            if (kind === 'agreements') {
                unhost();
                renderAgreement(body, instance);
            } else if (kind === 'designs' && instance.serverId) {
                openPublishedDesign(instance);
            } else if (kind === 'designs') {
                renderDesignAgreements(body, instance);
                selectDesign(instance.id);
            } else if (kind === 'built') {
                global.PlanningViews.inspectBuilding(instance.feature, instance.id);
            } else if (kind === 'permitted') {
                global.PlanningViews.selectAt(instance.id, state.latlng);
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
            }
        } catch (error) {
            console.error(`[ClickStack] the ${kind} section could not open`, error);
        } finally {
            state.expanding = false;
        }
    }

    // The design's actions panel opens in the section directly (its Overview tab with the actions
    // below it), not the planning inspector's summary with a further "Proposal actions" button.
    function selectDesign(key) {
        global.selectAndHighlightProposal(key, null, false, true, false, { planningActions: true, presentation: 'details' });
        // A proposal's own parcel may open its panel alongside; in the stack it has its section.
        if (doc.getElementById('parcel-info-panel')?.classList.contains('visible')) global.hideParcelInfoPanel?.({ preserveProposalSelection: true });
    }

    // A published proposal on the clicked parcel that this browser holds no copy of: imported first
    // (as the parcel's proposal list does), then shown in the section if it is still the one chosen.
    async function openPublishedDesign(instance) {
        let key;
        try {
            const proposal = global.DesignSync.importDesign(await global.DesignSync.fetchDesign(instance.serverId));
            key = global.getProposalKey(proposal) || proposal.proposalId;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [ClickStack] published proposal ${instance.serverId} could not be loaded`, error);
            global.updateStatus?.(t('modal.roadWidth.proposalList.downloadError', 'Failed to download proposal'));
            return;
        }
        if (!isOpen() || state.stack.expanded !== 'designs' || model.selectedInstance(state.stack, 'designs')?.id !== instance.id) return;
        state.expanding = true;
        try {
            selectDesign(key);
            const target = HOSTS.designs.find(id => isShown(doc.getElementById(id)));
            const body = bodyOf('designs');
            if (target && body) host(body, target);
        } finally {
            state.expanding = false;
        }
    }

    // The published proposals of the clicked parcel arrived after the stack opened: the same spot is
    // shown again with them, keeping the chosen instances and the expanded section.
    function refreshSpot(latlng) {
        if (!isOpen() || state.latlng !== latlng) return;
        const hits = global.ClickStackHits.hitsAt(latlng);
        const selected = Object.fromEntries(state.stack.sections.map(section => [section.kind, section.instances[section.selectedIndex].id]));
        const next = model.buildClickStack(hits, { selected });
        const expanded = state.stack.expanded;
        state.hits = hits;
        state.stack = expanded && next.sections.some(section => section.kind === expanded) ? model.expand(next, expanded) : { ...next, expanded: null };
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

    // ── state changes ─────────────────────────────────────────────────────────────────────────

    function expand(kind) {
        if (!state.stack) return;
        // Another section takes over: the old one's panel closes. Within one section (a strip
        // choice) the panel stays open and is hosted again for the new instance.
        if (state.hosted && state.stack.expanded !== kind) unhost();
        state.stack = model.expand(state.stack, kind);
        remember(state.stack.expanded);
        render();
        activate(state.stack.expanded);
    }

    // The expanded section's header clicked again: everything collapses to rows.
    function collapse() {
        if (!state.stack) return;
        unhost();
        global.highlightFeaturesForHover?.([]);
        state.stack = { ...state.stack, expanded: null };
        render();
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
        state.hits = hits;
        render();
        const el = ensureElement();
        el.hidden = false;
        el.classList.add('visible');
        doc.body.classList.add('click-stack-open');
        if (stack.expanded) activate(stack.expanded);
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
            global.ProposalSelection?.clear?.();
            global.hideProposalDetailsPanel?.(true);
        }
        global.highlightFeaturesForHover?.([]);
        state.stack = null;
        state.hits = null;
        state.el.hidden = true;
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
        if (action === 'parcel-reference') global.copyTextWithFeedback?.(target.dataset.reference);
        else if (action === 'row') {
            // A folded stack unfolds first: its open section's row shows that section again.
            if (state.el.classList.contains('is-folded')) {
                state.el.classList.remove('is-folded');
                if (state.stack.expanded === kind) return;
            }
            if (state.stack.expanded === kind) collapse(); else expand(kind);
        } else if (action === 'instance') {
            state.stack = model.selectInstance(state.stack, kind, id);
            expand(kind);
        } else if (action === 'open-agreement') {
            state.stack = model.selectInstance(state.stack, 'agreements', id);
            expand('agreements');
        } else if (action === 'agreement-designs') {
            const agreement = model.selectedInstance(state.stack, 'agreements')?.agreement;
            if (agreement) showAgreementDesigns(agreement);
        } else if (action === 'agreement-details') {
            global.AgreementPanel.open(id);
        } else if (action === 'coords') {
            const text = target.textContent;
            global.navigator.clipboard?.writeText(text).then(() => global.updateStatus?.(t('copied', 'Coordinates copied')),
                error => console.error('[ClickStack] coordinates could not be copied', error));
        }
    }

    // A proposal just placed opens the stack at a point inside it, its Design section expanded on
    // it, instead of a card of its own. In 3D, where the stack does not open, the proposal is
    // selected as before (the scene shows it).
    function showDesign(key) {
        const proposal = global.getProposalByIdOrHash?.(key) || global.proposalStorage?.getProposal?.(key);
        if (!proposal) throw new Error(`ClickStack: proposal ${key} is not stored`);
        const designKey = String(global.getProposalKey?.(proposal) || proposal.proposalId);
        if (doc.body.classList.contains('three-mode-active')) {
            global.selectAndHighlightProposal(designKey, null, false, true);
            return;
        }
        const footprint = global.__planOrder?.footprintOf?.(proposal);
        if (!footprint) throw new Error(`ClickStack: proposal ${designKey} has no footprint to open at`);
        const [lng, lat] = global.turf.pointOnFeature(footprint).geometry.coordinates;
        const latlng = global.L.latLng(lat, lng);
        const hits = global.ClickStackHits.hitsAt(latlng, { onPublished: () => refreshSpot(latlng) });
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

    // Every map click on the 2D map arrives here, whichever layer received it. One physical click
    // can reach several layers' handlers; only the first counts.
    function handleClick(latlng) {
        if (!latlng) return false;
        // A surface picking designs (js/map-pick.js) takes the topmost design and nothing else. It
        // holds the edit lock itself, so it is asked before the lock refuses the click.
        if (global.MapPick?.active()) {
            const top = global.__drillUi?.stackAt(latlng).find(entry => entry.kind === 'proposal');
            if (top) global.MapPick.pick(top.key);
            return true;
        }
        if (blocked()) return false;
        const now = Date.now();
        // One physical click reaching several layers' handlers arrives within a few milliseconds.
        if (state.lastClick && now - state.lastClick.at < 50
            && state.lastClick.lat === latlng.lat && state.lastClick.lng === latlng.lng) return true;
        state.lastClick = { at: now, lat: latlng.lat, lng: latlng.lng };
        const hits = global.ClickStackHits.hitsAt(latlng, { onPublished: () => refreshSpot(latlng) });
        const stack = model.buildClickStack(hits, { remembered: remembered() });
        const action = model.clickAction(isOpen() ? state.stack?.topRef || null : null, stack);
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
        close();
    });
    global.addEventListener('cityChanged', () => close());
    const relabel = () => { if (isOpen()) { const expanded = state.stack.expanded; render(); if (expanded) activate(expanded); } };
    global.addEventListener('i18n:translationsLoaded', relabel);

    // The agreement section outlines all its designs; map hover leaves that outline alone.
    const holdsHighlight = () => isOpen() && state.stack?.expanded === 'agreements';
    global.ClickStack = Object.freeze({ handleClick, showDesign, fold, close, isOpen, expand, collapse, holdsHighlight,
        current: () => state.stack, point: () => state.latlng });
})(window);
