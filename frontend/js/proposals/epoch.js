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

    /** Godine ponuđene u izborniku: zadane + trenutačna, rastuće i bez ponavljanja.
        Trenutačna se dodaje i kad nije među zadanima, inače bi izbornik tiho
        pokazivao krivu godinu za prijedlog upisan kroz "Druga godina…". */
    function epochYearChoices(current) {
        const g = parseEpochYear(current);
        return [...new Set([...DEFAULT_CHOICES, ...(g !== null ? [g] : [])])].sort((a, b) => a - b);
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

    /** Deterministički PRNG (mulberry32), da se ista raspodjela može ponoviti sa
        `seed`. Bez seeda je stvarno slučajna. */
    function makeRandom(seed) {
        if (seed === undefined || seed === null) return Math.random;
        let a = (Number(seed) >>> 0) || 1;
        return function random() {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** Fisher–Yates, pa round-robin po godinama: razlika među košaricama je
        najviše jedan prijedlog, a raspored je slučajan. Sortiranje po slučajnom
        ključu ne bi jamčilo ni jedno ni drugo. */
    function planEpochSpread(proposals, years, random) {
        const order = (proposals || []).slice();
        for (let i = order.length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            const swap = order[i]; order[i] = order[j]; order[j] = swap;
        }
        return order.map((proposal, index) => ({ proposal, year: years[index % years.length] }));
    }

    const pure = { MIN_YEAR, MAX_YEAR, DEFAULT_CHOICES, parseEpochYear, epochOf, epochYearChoices, distinctEpochs, belongsCumulative, filterEntriesCumulative, epochDiff, makeRandom, planEpochSpread };
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

    /** Lista se sama precrtava — kartice su HTML stringovi, pa je ponovni render
        jedini način da izbornik na kartici pokaže stvarno spremljenu godinu. */
    function renderList() {
        try { if (typeof renderProposalListModal === 'function') renderProposalListModal(); } catch (_) { }
    }

    function setSelectedYear(year) {
        selectedYear = parseEpochYear(year);
        try { document.dispatchEvent(new CustomEvent('proposal-epoch-timeline', { detail: { year: selectedYear } })); } catch (_) { }
        renderList();
    }

    /** Opcije izbornika godina: "Bez epohe", ponuđene godine, "Druga godina…". */
    function yearOptionList(trenutna, { customOption = true } = {}) {
        return [
            { v: '', txt: t('modal.roadWidth.proposalList.epoch.none', 'No epoch') },
            ...epochYearChoices(trenutna).map(g => ({ v: String(g), txt: `${g}.` })),
            ...(customOption ? [{ v: 'custom', txt: t('modal.roadWidth.proposalList.epoch.custom', 'Other year…') }] : [])
        ];
    }

    /** Popuni <select> godinama; `trenutna` se doda i kad nije među ponuđenima. */
    function fillYearOptions(select, trenutna, { customOption = true } = {}) {
        const opcije = yearOptionList(trenutna, { customOption });
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
    // `render: false` lets a batch write many epochs and redraw the list once at the end; the card
    // menu leaves it alone and keeps redrawing after its single change.
    async function setEpoch(proposal, year, options = {}) {
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
        if (options.render !== false) renderList();
        return g;
    }

    /* ------------------------- raspodjela po epohama --------------------------- */

    /**
     * Svakom prijedlogu dodijeli jednu od četiri epohe, nasumično i ravnomjerno.
     *
     * Piše kroz setEpoch — isti put kojim piše izbornik na kartici — pa raspodjela
     * ne može odlutati od onoga što radi klik: i server PATCH i lokalna pohrana i
     * pamćenje zadnje epohe idu istim redom.
     *
     * Lista se precrtava JEDNOM na kraju, ne 621 puta; a između zapisa se prepušta
     * red pregledniku, jer bi inače cijela raspodjela bila jedan zamrznuti frame.
     *
     * @param {object} [options]
     * @param {number[]} [options.years] košarice (zadano: četiri ponuđene godine)
     * @param {number} [options.seed] ponovljiva raspodjela
     * @param {boolean} [options.dryRun] samo prebroji, ne piši ništa
     * @param {boolean} [options.onlyUnset] preskoči prijedloge koji već imaju epohu
     */
    async function distributeEpochs(options = {}) {
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') {
            console.error('[epoch] proposalStorage nije dostupan');
            return null;
        }
        const years = Array.isArray(options.years) && options.years.length
            ? options.years.map(parseEpochYear).filter(y => y !== null)
            : DEFAULT_CHOICES.slice();
        if (!years.length) {
            console.error('[epoch] nema valjanih godina za raspodjelu');
            return null;
        }

        const all = proposalStorage.getAllProposals() || [];
        const targets = options.onlyUnset ? all.filter(p => epochOf(p) === null) : all.slice();
        const plan = planEpochSpread(targets, years, makeRandom(options.seed));

        const counts = {};
        years.forEach(year => { counts[year] = 0; });
        plan.forEach(entry => { counts[entry.year] += 1; });

        if (options.dryRun) {
            console.log(`[epoch] dry run: ${plan.length} prijedlog(a) u ${years.length} košarice`, counts);
            return { attempted: plan.length, counts, written: 0, failed: [], dryRun: true };
        }

        const failed = [];
        let written = 0;
        for (const entry of plan) {
            try {
                await setEpoch(entry.proposal, entry.year, { render: false });
                written += 1;
            } catch (error) {
                failed.push({
                    proposal: entry.proposal.proposalId || entry.proposal.id || '?',
                    year: entry.year,
                    reason: String(error && error.message || error)
                });
            }
            if (written % 25 === 0 && typeof updateStatus === 'function') {
                updateStatus(`Epochs: ${written}/${plan.length} assigned…`);
            }
            if (typeof window !== 'undefined' && typeof window.yieldToBrowser === 'function') {
                await window.yieldToBrowser();
            }
        }

        renderList();
        const summary = { attempted: plan.length, written, counts, failed };
        console.log(`[epoch] ${written}/${plan.length} prijedloga dobilo epohu`, summary);
        if (failed.length) console.table(failed.slice(0, 25));
        if (typeof updateStatus === 'function') {
            updateStatus(`${written} proposal(s) given an epoch: `
                + years.map(y => `${y}×${counts[y]}`).join(', ')
                + (failed.length ? ` · ${failed.length} failed` : ''));
        }
        return summary;
    }

    /* --------------------------- izbornik na kartici --------------------------- */

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

    /** Izbornik epohe na kartici u listi: pokazuje godinu I postavlja je, pa
        kartica ne treba zasebnu značku, a prijedlog ne treba otvoriti da mu se
        epoha promijeni. Kartice se grade kao HTML string, pa je i ovo markup;
        promjenu hvata delegirani listener niže. */
    function cardEpochSelectHtml(proposal, proposalId) {
        const trenutna = epochOf(proposal);
        const naslov = t('modal.roadWidth.proposalList.epoch.rowLabel', 'Plan epoch');
        const odabrana = trenutna === null ? '' : String(trenutna);
        const opcije = yearOptionList(trenutna).map(o =>
            `<option value="${esc(o.v)}"${o.v === odabrana ? ' selected' : ''}>${esc(o.txt)}</option>`).join('');
        return `<select class="proposal-epoch-card-select${trenutna === null ? ' is-empty' : ''}"`
            + ` data-proposal-id="${esc(proposalId)}" title="${esc(naslov)}" aria-label="${esc(naslov)}">`
            + `${opcije}</select>`;
    }

    /** Odabir s kartice: prazno briše epohu, "Druga godina…" pita, sve ostalo je
        godina. Svaki izlaz koji NIJE uspješan spremljeni odabir precrta listu, da
        izbornik nikad ne ostane pokazivati godinu koja nigdje nije zapisana. */
    async function handleCardEpochChange(select) {
        const proposal = findProposal(select.dataset.proposalId);
        if (!proposal) {
            console.error('[epoch] prijedlog nije nađen:', select.dataset.proposalId);
            renderList();
            return;
        }
        let cilj;
        if (select.value === 'custom') {
            cilj = askCustomYear();
            if (cilj === undefined) { renderList(); return; }   // odustao — vrati stari prikaz
        } else {
            cilj = select.value === '' ? null : parseEpochYear(select.value);
        }
        select.disabled = true;
        try {
            await setEpoch(proposal, cilj);   // sam precrta listu s novom godinom
        } catch (err) {
            console.error('[epoch] spremanje s kartice nije uspjelo:', err);
            alert(t('modal.roadWidth.proposalList.epoch.saveError', 'Failed to save the epoch.'));
            renderList();                     // vrati izbornik na stvarno spremljenu godinu
        }
    }

    // Delegirani listeneri: kartice se precrtavaju na svakom renderu, pa se veže
    // jednom na dokument umjesto na svaki izbornik.
    document.addEventListener('change', (e) => {
        const select = e.target.closest && e.target.closest('.proposal-epoch-card-select');
        if (select) handleCardEpochChange(select);
    });
    document.addEventListener('click', (e) => {
        // izbornik epohe ne smije otvoriti prijedlog
        if (e.target.closest && e.target.closest('.proposal-epoch-card-select')) e.stopPropagation();
    }, true);

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
        setEpoch, injectTimeline,
        lastUsedEpoch, rememberEpoch, fillYearOptions, yearOptionList,
        initCreateDialogSelect, readCreateDialogEpoch,
        cardEpochSelectHtml, findProposal,
        distributeEpochs
    };
    // Console-reachable: assigning several hundred epochs by hand is not a use of anyone's time.
    global.distributeEpochs = distributeEpochs;
}(typeof globalThis !== 'undefined' ? globalThis : this));
