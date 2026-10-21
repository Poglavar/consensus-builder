// The "Compare proposals here" dialog: two designs side by side, for ONE parcel only — what each
// takes of it, what stands on it afterwards and where the ownership goes. A design asks nobody for
// consent and carries no terms or funding (plan-design-agreement.md, M2: those are its agreement's).
// Opened from the parcel panel's Proposals tab (two ticked), the parcel menu / command palette, and
// the "At this spot" stack. All figures come from the pure proposals/parcel-compare.js; this file
// only gathers the inputs and renders. window.ParcelCompare.
(function (global) {
    'use strict';

    const doc = global.document;
    const DIALOG_ID = 'parcel-compare-dialog';
    const SIDES = ['a', 'b'];

    const state = { parcelId: null, parcel: null, candidates: [], picked: [null, null] };

    function t(key, fallback, params) {
        const i18n = global.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params || {});
            if (typeof value === 'string' && value && value !== key) return value;
        }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (params && name in params ? params[name] : match));
    }

    const api = () => {
        if (!global.__parcelCompare) throw new Error('ParcelCompare: proposals/parcel-compare.js is not loaded');
        return global.__parcelCompare;
    };
    const storage = () => (global.Proposals && global.Proposals.storage) || global.proposalStorage || null;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const DASH = '—';

    // ── inputs ──────────────────────────────────────────────────────────────────────────────

    function allRecords() {
        const store = storage();
        if (!store) return [];
        const list = typeof store.peekAllProposals === 'function' ? store.peekAllProposals() : store.getAllProposals();
        // Canton records live in their own section of the panel, as in the Proposals tab.
        const canton = global.CantonMode && global.CantonMode.isCantonProposal;
        return typeof canton === 'function' ? list.filter(p => !canton(p)) : list;
    }

    // The parcel as the owner holds it: its cadastral ground (the repository's immutable geometry)
    // when known, else the live piece on the map.
    function parcelContext(parcelId) {
        const id = String(parcelId);
        const fabric = global.LiveParcelFabric;
        const live = fabric && typeof fabric.get === 'function' ? fabric.get(id) : null;
        let cadastreIds = [];
        try { if (fabric && live) cadastreIds = fabric.explicitCadastreIds(live) || []; } catch (_) { cadastreIds = []; }
        if (!cadastreIds.length && !live) cadastreIds = [id];
        const repo = global.CadastralParcelRepository;
        const base = cadastreIds.map(cid => (repo && typeof repo.get === 'function' ? repo.get(String(cid)) : null)).filter(Boolean);
        let feature = null;
        if (base.length === cadastreIds.length && base.length) {
            feature = base[0];
            for (let i = 1; i < base.length; i++) {
                try { feature = global.turf.union(feature, base[i]) || feature; } catch (error) {
                    // Was: compare against the union so far, part of the parcel missing. Use the
                    // live piece instead (as when the cadastral parcels are not all known), and
                    // report the failure (clipHealth(), parcel-arrangement.js).
                    const clips = global.__parcelArrangement;
                    if (!clips || typeof clips.reportClipFailure !== 'function') throw error;
                    clips.reportClipFailure('union', error, { site: 'parcel-compare-ui.parcelContext', parcelId: id }, [feature, base[i]]);
                    feature = live;
                    break;
                }
            }
        } else {
            feature = live;
        }
        const props = (feature && feature.properties) || (live && live.properties) || {};
        const model = global.ParcelMenuModel;
        let geometryArea = null;
        try { geometryArea = feature ? global.turf.area(feature) : null; } catch (_) { geometryArea = null; }
        return {
            id,
            cadastreIds: cadastreIds.map(String),
            feature,
            areaM2: model ? model.parcelArea(base.length === 1 ? props : {}, geometryArea) : geometryArea,
            displayId: model ? model.displayParcelId(props, cadastreIds.length === 1 ? cadastreIds[0] : id) : id,
            isGround: !!(global.__openGround && live && global.__openGround.isGroundPiece(live))
        };
    }

    function candidatesFor(parcel, options) {
        if (!parcel || parcel.isGround) return [];
        return api().proposalsTouchingParcel(parcel, allRecords(), options);
    }

    // How many proposals could be compared on this parcel, for the parcel menu. Declared ones are
    // counted from the storage index first; the geometric scan only runs when they are not enough.
    function countFor(parcelId) {
        const store = storage();
        const declared = store && typeof store.getProposalsForParcel === 'function' ? store.getProposalsForParcel(String(parcelId)) : [];
        if (declared.length >= 2) return declared.length;
        const parcel = parcelContext(parcelId);
        return candidatesFor(parcel, { measure: false }).length;
    }

    function keyOf(proposal) {
        if (typeof global.getProposalKey === 'function') {
            const key = global.getProposalKey(proposal);
            if (key) return String(key);
        }
        return String(proposal.proposalId);
    }

    function titleOf(proposal) {
        const names = [proposal.title, proposal.name, proposal.metadata && proposal.metadata.title]
            .map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
        if (names[0]) return names[0];
        const type = typeof global.getProposalDisplayTypeLabel === 'function' ? global.getProposalDisplayTypeLabel(proposal) : '';
        return type || t('panel.parcel.proposalsSection.fallbackTitle', 'Proposal');
    }

    function typeOf(proposal) {
        return typeof global.getProposalDisplayTypeLabel === 'function' ? global.getProposalDisplayTypeLabel(proposal) : '';
    }

    function effectFor(entry, parcel) {
        const proposal = entry.proposal;
        return api().parcelEffect(proposal, parcel, {
            applied: typeof global.isProposalApplied === 'function' ? !!global.isProposalApplied(proposal) : undefined,
            isTrack: typeof global.isTrackProposal === 'function' ? global.isTrackProposal : undefined
        });
    }

    // ── formatting (null → "—", never 0), through the shared formatter (js/format.js) ──────────

    const number = (value, digits) => CbFormat.formatNumber(value, { maxFractionDigits: digits || 0 });
    const m2 = value => (finite(value) ? CbFormat.formatArea(value) : DASH);
    const pct = share => (finite(share) ? CbFormat.formatPercent(share, { maxFractionDigits: share < 0.1 ? 1 : 0 }) : DASH);
    const range = (r, unit) => (r ? (r.min === r.max ? `${number(r.min, 1)}${unit}` : `${number(r.min, 1)}–${number(r.max, 1)}${unit}`) : DASH);

    function takeText(e) {
        const extentLabels = {
            whole: t('parcelCompare.extent.whole', 'Whole parcel'),
            edge: t('parcelCompare.extent.edge', 'Edge only'),
            part: t('parcelCompare.extent.part', 'Part of the parcel'),
            none: t('parcelCompare.extent.none', 'None')
        };
        const lines = [e.take.extent ? extentLabels[e.take.extent] : DASH];
        if (e.take.extent !== 'none' && (finite(e.take.areaM2) || finite(e.take.share))) {
            lines.push(`${m2(e.take.areaM2)} · ${pct(e.take.share)}`);
        }
        if (finite(e.take.intrusionM) && e.take.extent !== 'none') {
            lines.push(t('parcelCompare.intrusion', 'reaches {{width}} m in', { width: number(e.take.intrusionM, 2) }));
        }
        if (e.relation === 'intrudes') lines.push(t('parcelCompare.relation.intrudes', 'Its site reaches in without naming this parcel'));
        return lines;
    }

    function buildingsText(b) {
        if (!b || b.count === null) return [DASH];
        if (b.count === 0) return [t('parcelCompare.none', 'None')];
        return [
            t('blockify.modal.messages.buildingCount', 'Buildings: {{count}}', { count: b.count }),
            t('parcelCompare.buildings.footprint', 'footprint {{area}}', { area: m2(b.footprintM2) }),
            t('parcelCompare.buildings.floorArea', 'floor area {{area}}', { area: m2(b.floorAreaM2) }),
            t('parcelCompare.buildings.height', '{{floors}} floors · {{height}}', { floors: range(b.floors, ''), height: range(b.heightM, ' m') })
        ];
    }

    function structureText(s) {
        if (!s) return [DASH];
        const kinds = {
            park: t('parcelCompare.structure.park', 'Park'),
            square: t('parcelCompare.structure.square', 'Square'),
            lake: t('parcelCompare.structure.lake', 'Lake'),
            station: t('parcelCompare.structure.station', 'Station')
        };
        return [`${kinds[s.kind] || s.kind} · ${m2(s.areaM2)}`];
    }

    function corridorText(c) {
        if (!c) return [DASH];
        const kind = c.kind === 'track' ? t('parcelCompare.corridor.track', 'Track') : t('parcelCompare.corridor.road', 'Road');
        const width = finite(c.widthM) ? t('parcelCompare.corridor.width', '{{width}} m wide', { width: number(c.widthM, 1) }) : null;
        return [[kind, width, m2(c.areaM2)].filter(Boolean).join(' · ')];
    }

    function plotsText(plots) {
        if (!plots) return [DASH];
        if (!plots.length) return [t('parcelCompare.none', 'None')];
        // A layout's plots carry no owners: who holds a plot is its agreement's to say.
        return plots.map(p => t('parcelCompare.plots.line', 'Plot {{number}} ({{area}}): {{overlap}} of this parcel', {
            number: p.number, area: m2(p.areaM2), overlap: m2(p.overlapM2)
        }));
    }

    function destinationText(destination) {
        const labels = {
            public: t('panel.parcel.dossier.destination.public', 'public'),
            proposer: t('panel.parcel.dossier.destination.proposer', 'the proposer'),
            'carry-over': t('panel.parcel.dossier.destination.carryOver', 'stays with its owners')
        };
        return labels[destination] || destination || DASH;
    }

    function ownershipText(o) {
        if (!o) return [DASH];
        return [t('parcelCompare.ownership.ceded', '{{area}} → {{destination}}', { area: m2(o.cededM2), destination: destinationText(o.destination) })];
    }

    function statusText(e, proposal) {
        const display = global.__proposalDisplayState;
        const lines = [e.status.key === 'local'
            ? t('parcelCompare.status.local', 'Local (this browser)')
            : display.rungLabel(e.status.key, t)];
        if (e.status.key === 'executed') lines.push(display.rungHint('executed', t));
        if (e.status.lifecycle && e.status.key !== 'executed' && typeof global.getProposalLifecycleLabel === 'function') {
            lines.push(global.getProposalLifecycleLabel(e.status.lifecycle));
        }
        if (e.status.applied) {
            lines.push(t('panel.parcel.proposalsSection.badges.applied', 'Applied'));
        }
        return lines;
    }

    // ── rendering ───────────────────────────────────────────────────────────────────────────

    function el(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    // A native <dialog> (showModal) that wears the dialog primitive's classes (css/primitives.css):
    // card, header with one close button, body; the backdrop is the token's (css/proposals.css).
    function ensureDialog() {
        let dialog = doc.getElementById(DIALOG_ID);
        if (dialog) return dialog;
        dialog = el('dialog', 'cb-dialog cb-dialog--lg parcel-compare');
        dialog.id = DIALOG_ID;
        dialog.setAttribute('aria-labelledby', `${DIALOG_ID}-title`);
        // A click on the backdrop (the dialog box itself, outside its content) closes it.
        dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
        doc.body.appendChild(dialog);
        return dialog;
    }

    function renderValueCell(lines, side, extraClass) {
        const cell = el('div', `parcel-compare__cell parcel-compare__cell--${side}${extraClass ? ` ${extraClass}` : ''}`);
        const marker = el('span', `parcel-compare__marker parcel-compare__marker--${side}`, side.toUpperCase());
        marker.setAttribute('aria-hidden', 'true');
        cell.appendChild(marker);
        const body = el('span', 'parcel-compare__value');
        lines.forEach((line, i) => {
            if (i) body.appendChild(doc.createElement('br'));
            body.appendChild(doc.createTextNode(line));
        });
        cell.appendChild(body);
        return cell;
    }

    function row(grid, label, values, options) {
        const r = el('div', 'parcel-compare__row');
        r.setAttribute('role', 'row');
        const head = el('div', 'parcel-compare__label', label);
        head.setAttribute('role', 'rowheader');
        r.appendChild(head);
        values.forEach((lines, i) => {
            const cell = renderValueCell(lines, SIDES[i], options && options.cellClass);
            cell.setAttribute('role', 'cell');
            if (options && options.dataKey) cell.dataset.compareCell = `${options.dataKey}-${SIDES[i]}`;
            r.appendChild(cell);
        });
        grid.appendChild(r);
    }

    function section(grid, title) {
        const s = el('div', 'parcel-compare__section');
        s.setAttribute('role', 'row');
        const head = el('span', null, title);
        head.setAttribute('role', 'columnheader');
        s.appendChild(head);
        grid.appendChild(s);
    }

    function pickerOptions(select, selectedKey, otherKey) {
        select.textContent = '';
        state.candidates.forEach(entry => {
            const key = keyOf(entry.proposal);
            const relation = entry.relation === 'intrudes' ? ` · ${t('parcelCompare.relation.short', 'reaches in')}` : '';
            const option = el('option', null, `${titleOf(entry.proposal)}${relation}`);
            option.value = key;
            option.disabled = key === otherKey;
            option.selected = key === selectedKey;
            select.appendChild(option);
        });
    }

    function render() {
        const dialog = ensureDialog();
        const parcel = state.parcel;
        dialog.textContent = '';

        const header = el('div', 'cb-dialog__header parcel-compare__head');
        const title = el('h2', 'cb-dialog__title parcel-compare__title', t('parcelCompare.title', 'Compare proposals on parcel {{number}}', { number: parcel.displayId }));
        title.id = `${DIALOG_ID}-title`;
        const close = el('button', 'close-circle-btn parcel-compare__close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', t('modal.common.close', 'Close'));
        close.addEventListener('click', () => dialog.close());
        header.appendChild(title);
        header.appendChild(close);
        dialog.appendChild(header);
        const content = el('div', 'cb-dialog__body parcel-compare__body');
        dialog.appendChild(content);

        const picked = state.picked.map(key => state.candidates.find(c => keyOf(c.proposal) === key) || null);
        if (picked.some(p => !p)) {
            content.appendChild(el('p', 'parcel-compare__empty', t('parcelCompare.needTwo', 'At least two proposals must touch this parcel to compare them.')));
            return;
        }
        const effects = picked.map(entry => effectFor(entry, parcel));

        // Pickers + preview.
        const top = el('div', 'parcel-compare__top');
        const pickers = el('div', 'parcel-compare__pickers');
        SIDES.forEach((side, i) => {
            const wrap = el('label', `parcel-compare__picker parcel-compare__picker--${side}`);
            const caption = el('span', `parcel-compare__marker parcel-compare__marker--${side}`, side.toUpperCase());
            caption.setAttribute('aria-hidden', 'true');
            const select = el('select', 'parcel-compare__select');
            select.setAttribute('aria-label', t('parcelCompare.pick', 'Proposal {{side}}', { side: side.toUpperCase() }));
            pickerOptions(select, state.picked[i], state.picked[1 - i]);
            select.addEventListener('change', () => {
                state.picked[i] = select.value;
                render();
                const again = dialog.querySelector(`.parcel-compare__picker--${side} select`);
                if (again) again.focus();
            });
            const type = typeOf(picked[i].proposal);
            wrap.appendChild(caption);
            wrap.appendChild(select);
            if (type) wrap.appendChild(el('span', 'parcel-compare__type', type));
            const details = el('button', 'btn btn-sm parcel-compare__details', t('parcelCompare.openDetails', 'Details'));
            details.type = 'button';
            details.addEventListener('click', event => {
                event.preventDefault();
                dialog.close();
                if (typeof global.showProposalDetails === 'function') global.showProposalDetails(picked[i].proposal.proposalId, parcel.id);
            });
            wrap.appendChild(details);
            pickers.appendChild(wrap);
        });
        top.appendChild(pickers);
        const svg = api().previewSvg(parcel.feature && parcel.feature.geometry, effects.map((e, i) => ({
            geometry: e.clip, className: `parcel-compare-svg__take parcel-compare-svg__take--${SIDES[i]}`
        })), { label: t('parcelCompare.previewLabel', 'Parcel outline with each proposal’s ground on it'), size: 160 });
        if (svg) {
            const figure = el('div', 'parcel-compare__preview');
            figure.innerHTML = svg;
            top.appendChild(figure);
        }
        content.appendChild(top);

        // The comparison grid.
        const grid = el('div', 'parcel-compare__grid');
        grid.setAttribute('role', 'table');
        grid.setAttribute('aria-label', t('parcelCompare.tableLabel', 'Comparison for this parcel'));
        const both = fn => effects.map((e, i) => fn(e, picked[i].proposal));

        section(grid, t('parcelCompare.sections.ground', 'Your ground'));
        row(grid, t('parcelCompare.rows.take', 'Takes of this parcel'), both(takeText));
        section(grid, t('parcelCompare.sections.after', 'On this parcel afterwards'));
        row(grid, t('parcelCompare.rows.buildings', 'Buildings'), both(e => buildingsText(e.buildings)));
        row(grid, t('parcelCompare.rows.structure', 'Park / square / lake'), both(e => structureText(e.structure)));
        row(grid, t('parcelCompare.rows.corridor', 'Road / track'), both(e => corridorText(e.corridor)));
        row(grid, t('parcelCompare.rows.plots', 'Plots it becomes'), both(e => plotsText(e.plots)));
        section(grid, t('parcelCompare.sections.ownership', 'Ownership'));
        row(grid, t('parcelCompare.rows.ceded', 'Ceded ground → to'), both(e => ownershipText(e.ownership)));
        row(grid, t('parcelCompare.rows.status', 'Status'), both(statusText), { dataKey: 'status' });
        content.appendChild(grid);
    }

    // ── public ──────────────────────────────────────────────────────────────────────────────

    function resolveKey(value) {
        if (value === undefined || value === null) return null;
        const wanted = String(value);
        const hit = state.candidates.find(c => keyOf(c.proposal) === wanted || String(c.proposal.proposalId) === wanted);
        return hit ? keyOf(hit.proposal) : null;
    }

    /**
     * Open the comparison for a parcel. `proposalIds` (optional) preselects the two columns;
     * otherwise the first two proposals touching the parcel (declared first) are shown.
     */
    function open(parcelId, proposalIds) {
        if (parcelId === undefined || parcelId === null) throw new Error('ParcelCompare.open: parcelId is required');
        state.parcelId = String(parcelId);
        state.parcel = parcelContext(parcelId);
        state.candidates = candidatesFor(state.parcel);
        const wanted = (Array.isArray(proposalIds) ? proposalIds : []).map(resolveKey).filter(Boolean);
        const defaults = state.candidates.map(c => keyOf(c.proposal)).filter(key => !wanted.includes(key));
        const picks = wanted.concat(defaults);
        state.picked = [picks[0] || null, picks.find(key => key !== picks[0]) || null];
        if (global.ParcelMenu && typeof global.ParcelMenu.close === 'function') global.ParcelMenu.close();
        render();
        const dialog = ensureDialog();
        if (!dialog.open) dialog.showModal();
        const first = dialog.querySelector('.parcel-compare__select') || dialog.querySelector('.parcel-compare__close');
        if (first) first.focus();
    }

    function close() {
        const dialog = doc.getElementById(DIALOG_ID);
        if (dialog && dialog.open) dialog.close();
    }

    // The parcel panel's Proposals tab: a tick box on each listed proposal and a Compare button
    // that opens the dialog when exactly two are ticked. `container` is #proposals-content.
    function decoratePanelList(container, parcelId) {
        if (!container) return;
        const items = Array.from(container.querySelectorAll('.parcel-proposals-list .proposal-item[data-proposal-id]'));
        if (items.length < 2) return;
        const bar = el('div', 'parcel-compare-bar');
        const hint = el('span', 'parcel-compare-bar__hint', t('parcelCompare.bar.hint', 'Tick two proposals to compare them on this parcel'));
        hint.id = 'parcel-compare-bar-hint';
        const button = el('button', 'btn btn-sm parcel-compare-bar__run', t('parcelCompare.bar.compare', 'Compare'));
        button.type = 'button';
        button.disabled = true;
        button.setAttribute('aria-describedby', hint.id);
        bar.appendChild(hint);
        bar.appendChild(button);
        const list = container.querySelector('.parcel-proposals-list');
        list.parentNode.insertBefore(bar, list);

        const ticked = () => items.map(item => item.querySelector('.proposal-item-compare input')).filter(box => box && box.checked);
        const update = () => {
            const count = ticked().length;
            button.disabled = count !== 2;
            hint.textContent = count === 2
                ? t('parcelCompare.bar.ready', 'Two selected')
                : t('parcelCompare.bar.hint', 'Tick two proposals to compare them on this parcel');
        };
        items.forEach(item => {
            const label = el('label', 'proposal-item-compare');
            const box = el('input');
            box.type = 'checkbox';
            box.value = item.dataset.proposalId;
            box.setAttribute('aria-label', t('parcelCompare.bar.tick', 'Select to compare'));
            label.appendChild(box);
            // The item itself opens the proposal's details; ticking must not.
            label.addEventListener('click', event => event.stopPropagation());
            box.addEventListener('change', update);
            item.insertBefore(label, item.firstChild);
        });
        button.addEventListener('click', () => {
            const ids = ticked().map(box => box.value);
            if (ids.length === 2) open(parcelId, ids);
        });
    }

    global.ParcelCompare = { open, close, countFor, decoratePanelList };
})(window);
