// proposals/epoch.js — epoch buckets for the plan timeline ("Kumulativno do godine").
// A proposal may carry epochYear (e.g. 2035/2045/2055): which stage of the plan's
// growth it belongs to. Deliberately PRESENTATION metadata: apply order stays
// created_at via plan-order.js, and the timeline never applies or unapplies
// anything itself — it filters the list cumulatively and reports the diff
// against the current applied state, so the user stays the one pressing apply.
// Pure logic is DOM-free and exported for node tests; the DOM/net helpers hang
// off window.__proposalEpoch (UMD, namespaced global — never a bare top-level).

(function (global) {
    'use strict';

    const MIN_YEAR = 2026;
    const MAX_YEAR = 2966;
    // Ponuđene godine u izborniku; proizvoljna godina i dalje prolazi kroz "Druga…".
    const DEFAULT_CHOICES = Object.freeze([2035, 2045, 2055, 2066]);

    /** Vraća cijelu godinu u dopuštenom rasponu ili null — nikad 0 iz krivog ulaza. */
    function parseEpochYear(value) {
        const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
        if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) return null;
        return (n >= MIN_YEAR && n <= MAX_YEAR) ? n : null;
    }

    function epochOf(proposal) {
        if (!proposal || typeof proposal !== 'object') return null;
        return parseEpochYear(proposal.epochYear ?? proposal.epoch_year);
    }

    /** Rastuće sortirane različite epohe iz liste prijedloga. */
    function distinctEpochs(proposals) {
        const skup = new Set();
        for (const p of proposals || []) {
            const g = epochOf(p);
            if (g !== null) skup.add(g);
        }
        return [...skup].sort((a, b) => a - b);
    }

    /** Kumulativna pripadnost: bez epohe = uvijek unutra (postojeće stanje). */
    function belongsCumulative(proposal, year) {
        const g = epochOf(proposal);
        return g === null || g <= year;
    }

    /** Filtrira {proposal, metrics} zapise liste za odabranu godinu (null = sve). */
    function filterEntriesCumulative(entries, year) {
        const g = parseEpochYear(year);
        if (g === null) return entries;
        return (entries || []).filter(e => belongsCumulative(e && e.proposal, g));
    }

    /** Razlika prema trenutačnom applied stanju: što još primijeniti, što maknuti.
        isAppliedFn se injektira da ostane čisto i testabilno. */
    function epochDiff(proposals, year, isAppliedFn) {
        const g = parseEpochYear(year);
        const primijeni = [], makni = [];
        if (g === null) return { toApply: primijeni, toUnapply: makni };
        for (const p of proposals || []) {
            const applied = !!isAppliedFn(p);
            if (belongsCumulative(p, g)) {
                if (!applied) primijeni.push(p);
            } else if (applied) {
                makni.push(p);
            }
        }
        return { toApply: primijeni, toUnapply: makni };
    }

    const pure = { MIN_YEAR, MAX_YEAR, DEFAULT_CHOICES, parseEpochYear, epochOf, distinctEpochs, belongsCumulative, filterEntriesCumulative, epochDiff };
    if (typeof module === 'object' && module.exports) module.exports = pure;
    if (typeof window === 'undefined') return;   // node test: samo čisti dio

    /* ------------------------------ DOM + mreža ------------------------------ */

    let selectedYear = null;   // null = bez vremenskog filtra ("Sve")

    // Zadnja upisana epoha, da autor koji crta pet stvari za 2045. ne bira 2045.
    // pet puta. Preživljava reload; "Bez epohe" je isto pamćenje (prazan string).
    const ZADNJA_KLJUC = 'cb.epoch.lastUsed';
    function lastUsedEpoch() {
        try {
            const raw = localStorage.getItem(ZADNJA_KLJUC);
            if (raw === '') return null;
            return parseEpochYear(raw);
        } catch (_) { return null; }
    }
    function rememberEpoch(year) {
        try { localStorage.setItem(ZADNJA_KLJUC, year === null ? '' : String(year)); } catch (_) { }
    }

    function t(key, fallback, params) {
        // isti ugovor kao getProposalI18nHelper (storage.js): prijevod ako postoji,
        // inače interpolirani fallback — i18n.t NE prima fallback argument
        if (typeof getProposalI18nHelper === 'function') {
            return getProposalI18nHelper()(key, fallback, params);
        }
        return String(fallback || '').replace(/\{(\w+)\}/g, (m, k) =>
            (params && Object.prototype.hasOwnProperty.call(params, k)) ? params[k] : m);
    }
    const esc = (s) => (typeof escapeHtml === 'function') ? escapeHtml(String(s)) : String(s);

    function getSelectedYear() { return selectedYear; }

    function setSelectedYear(year) {
        selectedYear = parseEpochYear(year);
        try { document.dispatchEvent(new CustomEvent('proposal-epoch-timeline', { detail: { year: selectedYear } })); } catch (_) { }
        try { if (typeof renderProposalListModal === 'function') renderProposalListModal(); } catch (_) { }
    }

    /** Značka na kartici prijedloga; prazno kad prijedlog nema epohu. */
    function epochBadgeHtml(proposal) {
        const g = epochOf(proposal);
        if (g === null) return '';
        const naslov = t('modal.roadWidth.proposalList.epoch.badgeTooltip', 'Plan epoch (timeline year)');
        return `<span class="proposal-epoch-badge" title="${esc(naslov)}">${g}.</span>`;
    }

    /** Popuni <select> godinama; `trenutna` se doda i kad nije među ponuđenima. */
    function fillYearOptions(select, trenutna, { customOption = true } = {}) {
        const godine = [...new Set([...DEFAULT_CHOICES, ...(trenutna !== null ? [trenutna] : [])])]
            .sort((a, b) => a - b);
        const opcije = [
            { v: '', txt: t('modal.roadWidth.proposalList.epoch.none', 'No epoch') },
            ...godine.map(g => ({ v: String(g), txt: `${g}.` })),
            ...(customOption ? [{ v: 'custom', txt: t('modal.roadWidth.proposalList.epoch.custom', 'Other year…') }] : [])
        ];
        select.innerHTML = '';
        for (const o of opcije) {
            const el = document.createElement('option');
            el.value = o.v; el.textContent = o.txt;
            select.appendChild(el);
        }
        select.value = trenutna !== null ? String(trenutna) : '';
    }

    /** Zajednička obrada "Druga godina…": vrati godinu, null (obriši) ili
        undefined kad je korisnik odustao (pozivatelj tada vraća staru vrijednost). */
    function askCustomYear() {
        const unos = prompt(t('modal.roadWidth.proposalList.epoch.customPrompt', 'Timeline year (2026–2966):'), '2077');
        if (unos === null) return undefined;
        const g = parseEpochYear(unos);
        return g === null ? undefined : g;
    }

    /** Ožiči <select> u dijalogu za izradu: pamti zadnji izbor kao sljedeći
        prijedlog. Vrijednost se čita s readCreateDialogEpoch() pri slanju. */
    function initCreateDialogSelect(select) {
        if (!select) return;
        fillYearOptions(select, lastUsedEpoch());
        select.addEventListener('change', () => {
            if (select.value === 'custom') {
                const g = askCustomYear();
                if (g === undefined) { fillYearOptions(select, lastUsedEpoch()); return; }
                fillYearOptions(select, g);
            }
            rememberEpoch(select.value === '' ? null : parseEpochYear(select.value));
        });
    }

    /** Epoha odabrana u dijalogu za izradu (ili null). */
    function readCreateDialogEpoch() {
        const select = document.getElementById('proposalEpochYear');
        if (!select) return null;
        return select.value === '' || select.value === 'custom' ? null : parseEpochYear(select.value);
    }

    /** PATCH na server (ako je prijedlog uploadan) + lokalna pohrana. */
    async function setEpoch(proposal, year) {
        const g = parseEpochYear(year);
        const serverId = proposal.serverProposalId
            ?? (typeof proposal.id === 'number' ? proposal.id : null)
            ?? (/^\d+$/.test(String(proposal.id || '')) ? proposal.id : null);
        if (serverId !== null && typeof resolveBackendBaseUrl === 'function') {
            const resp = await fetch(`${resolveBackendBaseUrl()}/proposals/${encodeURIComponent(serverId)}/epoch`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ epochYear: g })
            });
            if (!resp.ok) throw new Error(`PATCH epoch: HTTP ${resp.status}`);
        }
        proposal.epochYear = g;
        try {
            if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.setProposalEpochYear === 'function') {
                proposalStorage.setProposalEpochYear(proposal.proposalId || proposal.id, g);
            }
        } catch (_) { }
        rememberEpoch(g);
        try { if (typeof renderProposalListModal === 'function') renderProposalListModal(); } catch (_) { }
        return g;
    }

    /* ------------------------------ skupna dodjela ------------------------------ */

    // proposalId-evi označeni kvačicom u listi. Živi samo dok je lista otvorena.
    const oznaceni = new Set();

    function toggleSelected(proposalId, on) {
        if (!proposalId) return;
        if (on) oznaceni.add(proposalId); else oznaceni.delete(proposalId);
        refreshBulkBar();
    }
    function clearSelected() { oznaceni.clear(); refreshBulkBar(); }
    function selectedCount() { return oznaceni.size; }

    /** Nađi prijedlog po ključu i lokalno i u serverskom kešu. */
    function findProposal(proposalId) {
        try {
            if (typeof proposalStorage !== 'undefined') {
                const p = proposalStorage.getProposal(proposalId);
                if (p) return p;
            }
        } catch (_) { }
        try {
            if (typeof serverProposalCache !== 'undefined' && Array.isArray(serverProposalCache.proposals)) {
                return serverProposalCache.proposals.find(p => (
                    (typeof getProposalKey === 'function' ? getProposalKey(p) : p.proposalId) === proposalId
                )) || null;
            }
        } catch (_) { }
        return null;
    }

    /** Postavi epohu svima označenima. Jedan po jedan (PATCH je jeftin), ali
        greške se skupljaju i prijavljuju zajedno — tiho preskočen prijedlog je
        gori od poruke. */
    async function applyEpochToSelected(year) {
        const g = parseEpochYear(year);
        const kljucevi = [...oznaceni];
        const greske = [];
        let uspjelo = 0;
        for (const kljuc of kljucevi) {
            const p = findProposal(kljuc);
            if (!p) { greske.push(`${kljuc}: nije nađen`); continue; }
            try { await setEpoch(p, g); uspjelo++; } catch (err) { greske.push(`${kljuc}: ${err.message}`); }
        }
        if (greske.length) {
            console.error('[epoch] skupna dodjela — neuspjeli:', greske);
            alert(t('modal.roadWidth.proposalList.epoch.bulkPartial',
                '{ok} of {total} updated; {failed} failed (see console).',
                { ok: uspjelo, total: kljucevi.length, failed: greske.length }));
        }
        clearSelected();
        try { if (typeof renderProposalListModal === 'function') renderProposalListModal(); } catch (_) { }
        return { uspjelo, neuspjelo: greske.length };
    }

    /** Kvačica na kartici (samo markup; klik hvata delegirani listener). */
    function selectCheckboxHtml(proposalId) {
        const oznacen = oznaceni.has(proposalId) ? ' checked' : '';
        const naslov = t('modal.roadWidth.proposalList.epoch.selectForBulk', 'Select for bulk epoch assignment');
        return `<input type="checkbox" class="proposal-bulk-check" data-proposal-id="${esc(proposalId)}"`
            + `${oznacen} title="${esc(naslov)}" aria-label="${esc(naslov)}">`;
    }

    /** Traka skupne dodjele — pojavi se tek kad je nešto označeno. */
    function refreshBulkBar() {
        const modal = document.querySelector('.proposal-list-modal');
        if (!modal) return;
        const staro = modal.querySelector('.proposal-epoch-bulk');
        if (!oznaceni.size) { if (staro) staro.remove(); return; }

        const traka = staro || document.createElement('div');
        traka.className = 'proposal-epoch-bulk';
        traka.innerHTML = '';

        const broj = document.createElement('span');
        broj.className = 'proposal-epoch-bulk-count';
        broj.textContent = t('modal.roadWidth.proposalList.epoch.selectedCount', '{n} selected', { n: oznaceni.size });
        traka.appendChild(broj);

        // Bez zasebnog natpisa: panel je ~420 px, a natpis + select + dva gumba
        // se prelome. Gumb "Dodijeli" desno od izbornika ionako kaže što radi,
        // pa natpis živi kao aria-label umjesto kao još 56 px teksta.
        const select = document.createElement('select');
        select.className = 'proposal-epoch-bulk-select';
        const natpis = t('modal.roadWidth.proposalList.epoch.assignTo', 'Assign to:');
        select.setAttribute('aria-label', natpis);
        select.title = natpis;
        fillYearOptions(select, lastUsedEpoch());
        traka.appendChild(select);

        const primijeni = document.createElement('button');
        primijeni.type = 'button';
        primijeni.className = 'proposal-epoch-bulk-apply';
        primijeni.textContent = t('modal.roadWidth.proposalList.epoch.assign', 'Assign');
        primijeni.addEventListener('click', async () => {
            let g;
            if (select.value === 'custom') {
                g = askCustomYear();
                if (g === undefined) return;
            } else {
                g = select.value === '' ? null : parseEpochYear(select.value);
            }
            primijeni.disabled = true;
            try { await applyEpochToSelected(g); } finally { primijeni.disabled = false; }
        });
        traka.appendChild(primijeni);

        const odustani = document.createElement('button');
        odustani.type = 'button';
        odustani.className = 'proposal-epoch-bulk-clear';
        odustani.textContent = t('modal.roadWidth.proposalList.epoch.clearSelection', 'Clear');
        odustani.addEventListener('click', clearSelected);
        traka.appendChild(odustani);

        if (!staro) {
            const body = modal.querySelector('.proposal-list-modal-body');
            if (body) body.parentNode.insertBefore(traka, body);
        }
    }

    // Delegirani listener: kartice se preciju na svakom renderu, pa se veže
    // jednom na dokument umjesto na svaku kvačicu.
    document.addEventListener('change', (e) => {
        const box = e.target.closest && e.target.closest('.proposal-bulk-check');
        if (!box) return;
        toggleSelected(box.dataset.proposalId, box.checked);
    });
    document.addEventListener('click', (e) => {
        // kvačica ne smije otvoriti prijedlog
        if (e.target.closest && e.target.closest('.proposal-bulk-check')) e.stopPropagation();
    }, true);

    /** Redak u panelu detalja: natpis + izbornik godine. */
    function injectEpochRow(detailsContent, proposal) {
        if (!detailsContent || !proposal) return;
        if (detailsContent.querySelector('.proposal-epoch-row')) return;

        const row = document.createElement('div');
        row.className = 'proposal-epoch-row';
        const label = document.createElement('label');
        label.textContent = t('modal.roadWidth.proposalList.epoch.rowLabel', 'Plan epoch');
        const select = document.createElement('select');
        select.className = 'proposal-epoch-select';

        const trenutna = epochOf(proposal);
        fillYearOptions(select, trenutna);

        select.addEventListener('change', async () => {
            let cilj;
            if (select.value === 'custom') {
                cilj = askCustomYear();
                if (cilj === undefined) { fillYearOptions(select, epochOf(proposal)); return; }
            } else {
                cilj = select.value === '' ? null : parseEpochYear(select.value);
            }
            try {
                await setEpoch(proposal, cilj);
                fillYearOptions(select, cilj);
            } catch (err) {
                console.error('[epoch] spremanje nije uspjelo:', err);
                alert(t('modal.roadWidth.proposalList.epoch.saveError', 'Failed to save the epoch.'));
                fillYearOptions(select, epochOf(proposal));
            }
        });

        row.appendChild(label);
        row.appendChild(select);
        detailsContent.appendChild(row);
    }

    /** Traka vremenske crte na vrhu liste prijedloga. Crta se samo kad bar
        jedan prijedlog ima epohu — do tada ne zauzima ni piksel. */
    function injectTimeline(modal, proposals) {
        if (!modal) return;
        const staro = modal.querySelector('.proposal-epoch-timeline');
        if (staro) staro.remove();

        // Unija lokalnih i keširanih serverskih prijedloga: traka mora vidjeti
        // epohe i na Server kartici, ne samo u lokalnoj pohrani.
        const lista = proposals || [
            ...(typeof proposalStorage !== 'undefined' ? proposalStorage.getAllProposals() : []),
            ...((typeof serverProposalCache !== 'undefined' && Array.isArray(serverProposalCache.proposals))
                ? serverProposalCache.proposals : [])
        ];
        const epohe = distinctEpochs(lista);
        if (!epohe.length) return;

        // odabrana godina koje više nema (obrisana zadnja epoha) — očisti filtar
        if (selectedYear !== null && !epohe.includes(selectedYear)) selectedYear = null;

        const body = modal.querySelector('.proposal-list-modal-body');
        if (!body) return;

        const traka = document.createElement('div');
        traka.className = 'proposal-epoch-timeline';

        const naslov = document.createElement('span');
        naslov.className = 'proposal-epoch-timeline-label';
        naslov.textContent = t('modal.roadWidth.proposalList.epoch.timelineLabel', 'Timeline');
        traka.appendChild(naslov);

        const gumbi = [{ v: null, txt: t('modal.roadWidth.proposalList.epoch.all', 'All') },
                       ...epohe.map(g => ({ v: g, txt: `${g}.` }))];
        for (const g of gumbi) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'proposal-epoch-year' + (g.v === selectedYear ? ' is-active' : '');
            b.textContent = g.txt;
            b.addEventListener('click', () => setSelectedYear(g.v));
            traka.appendChild(b);
        }

        if (selectedYear !== null) {
            const isAppliedFn = (typeof isProposalApplied === 'function') ? isProposalApplied
                : (p => p && p.applied === true);
            const diff = epochDiff(lista, selectedYear, isAppliedFn);
            const info = document.createElement('span');
            info.className = 'proposal-epoch-diff';
            info.textContent = t('modal.roadWidth.proposalList.epoch.cumulative', 'Cumulative to {year}.', { year: selectedYear })
                + ` · ${t('modal.roadWidth.proposalList.epoch.toApply', 'to apply: {n}', { n: diff.toApply.length })}`
                + ` · ${t('modal.roadWidth.proposalList.epoch.toUnapply', 'to remove: {n}', { n: diff.toUnapply.length })}`;
            traka.appendChild(info);
        }

        body.parentNode.insertBefore(traka, body);
    }

    global.__proposalEpoch = {
        ...pure,
        getSelectedYear, setSelectedYear,
        epochBadgeHtml, setEpoch, injectEpochRow, injectTimeline,
        lastUsedEpoch, rememberEpoch, fillYearOptions,
        initCreateDialogSelect, readCreateDialogEpoch,
        selectCheckboxHtml, refreshBulkBar, clearSelected, selectedCount, applyEpochToSelected
    };
}(typeof globalThis !== 'undefined' ? globalThis : this));
