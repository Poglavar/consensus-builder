// Standalone devnet transaction explorer for the "Agents functionality for UGT" flows: every
// transaction the agent / x402 / proposal-market pipeline signs, with block-explorer links, decoded
// amounts and who-is-who labels. Everything above the DOM layer is pure and unit-tested headlessly
// (backend/test/tx-explorer-render.test.js); the wiring at the bottom only binds it to
// tx-explorer.html. Published as ONE global, `TxExplorer` — the classic scripts share a global
// lexical scope, so nothing else here may live at the top level.
(function attachTxExplorer(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TxExplorer = api;
    const doc = root && root.document;
    if (!doc) return; // node (tests): pure API only, no wiring
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', api.boot);
    else api.boot();
})(typeof window !== 'undefined' ? window : globalThis, function txExplorerFactory(root) {
    'use strict';

    // Every user-facing string on the page. Internal ops surface, English only — no i18n.
    const STRINGS = {
        title: 'Transactions (devnet)',
        subtitle: 'Every devnet transaction the agent pipeline signs: who paid whom, which program, which instruction.',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        autoRefresh: 'Auto-refresh (30 s)',
        limit: 'Limit',
        filterPlaceholder: 'Filter by signature, label, summary, program, action or address',
        filterLabel: 'Filter',
        clearFilters: 'Clear filters',
        programs: 'Programs',
        actions: 'Actions',
        legendTitle: 'Who is who',
        legendEmpty: 'No watched addresses reported.',
        copy: 'Copy address',
        copied: 'Copied',
        explorer: 'Solana Explorer',
        solscan: 'Solscan',
        colTime: 'Time',
        colStatus: 'Status',
        colSummary: 'What happened',
        colTags: 'Program / action',
        colAmounts: 'Amounts',
        colFeePayer: 'Fee payer',
        colFee: 'Fee (SOL)',
        colSignature: 'Signature',
        details: 'Instructions',
        detailsAccounts: 'Accounts',
        detailsArgs: 'Args',
        detailsNoArgs: 'no args',
        detailsNoAccounts: 'no accounts',
        innerOf: 'inner of #',
        signer: 'signer',
        writable: 'writable',
        empty: 'No transactions yet.',
        emptyFiltered: 'No transactions match the filter.',
        loading: 'Loading…',
        fetchedAt: 'Fetched',
        neverFetched: 'not fetched yet',
        cachedNote: 'cached',
        storedCount: 'stored',
        syncNew: 'new since last sync',
        syncFailed: 'sync failed',
        syncing: 'Syncing with devnet…',
        sampleActive: 'sample data (?sample=1) — the chain was not queried',
        errorPrefix: 'Could not load transactions',
        unknownTime: 'unknown time',
        unknownParty: 'unknown',
        noSummary: '(no summary)',
        statusSuccess: 'success',
        statusFailed: 'failed',
        solSymbol: 'SOL',
        showing: 'Showing',
        of: 'of',
        transactions: 'transactions',
        kindLabels: {
            wallet: 'Wallets',
            program: 'Programs',
            mint: 'Mints',
            'token-account': 'Token accounts',
            'fee-payer': 'Fee payers',
            other: 'Other'
        }
    };

    const AUTO_REFRESH_MS = 30000;
    const LIMIT_OPTIONS = [25, 50, 100, 200];
    const DEFAULT_LIMIT = 25;
    const SAMPLE_URL = 'data/tx-explorer-sample.json';
    // Legend order. Anything with an unrecognised kind is appended after these, alphabetically.
    const KIND_ORDER = ['wallet', 'program', 'mint', 'token-account', 'fee-payer'];

    // ---------------------------------------------------------------- pure model helpers

    function isObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function trimmed(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    // "CKPKq4F1…dWYp5" -> "CKPK…WYp5". The backend already sends `short`; this is the fallback so a
    // row never renders a 88-character blob when it does not.
    function shortAddress(address, existing) {
        const given = trimmed(existing);
        if (given) return given;
        const value = trimmed(address);
        if (!value) return '';
        return value.length <= 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
    }

    // Best human name for an `{ address, label, kind, short }` party: label, else short, else the
    // address, else a placeholder. Never the empty string, so a row can always be read.
    function partyLabel(party) {
        if (!isObject(party)) return STRINGS.unknownParty;
        const label = trimmed(party.label);
        if (label) return label;
        return shortAddress(party.address, party.short) || STRINGS.unknownParty;
    }

    function partyAddress(party) {
        return isObject(party) ? trimmed(party.address) : '';
    }

    // Local wall-clock rendering, built from the date parts rather than toLocaleString: the ops page
    // is read next to server logs, so a stable YYYY-MM-DD HH:MM:SS beats a locale-shaped string, and
    // it is assertable in a test. `iso` is what the row's title attribute carries.
    function formatTime(iso) {
        const raw = typeof iso === 'string' ? iso.trim() : (typeof iso === 'number' ? iso : '');
        const date = raw === '' ? null : new Date(raw);
        if (!date || Number.isNaN(date.getTime())) {
            return { valid: false, local: STRINGS.unknownTime, iso: '' };
        }
        const pad = (n) => String(n).padStart(2, '0');
        const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
            + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        return { valid: true, local, iso: date.toISOString() };
    }

    function fillTemplate(template, token, value) {
        const tpl = trimmed(template);
        const raw = trimmed(value);
        if (!tpl || !raw || tpl.indexOf(token) === -1) return null;
        return tpl.split(token).join(encodeURIComponent(raw));
    }

    // Block-explorer links for a signature, from the templates the API hands us. Never guessed
    // locally: the cluster lives in the template, so a devnet/mainnet mix-up cannot happen here.
    function explorerLinks(explorer, signature) {
        const cfg = isObject(explorer) ? explorer : {};
        return {
            explorer: fillTemplate(cfg.tx, '{sig}', signature),
            solscan: fillTemplate(cfg.solscanTx, '{sig}', signature)
        };
    }

    function addressLink(explorer, address) {
        const cfg = isObject(explorer) ? explorer : {};
        return {
            explorer: fillTemplate(cfg.address, '{addr}', address),
            solscan: fillTemplate(cfg.solscanAddress, '{addr}', address)
        };
    }

    function symbolFor(amount) {
        if (!isObject(amount)) return '';
        const symbol = trimmed(amount.symbol);
        if (symbol) return symbol;
        if (amount.kind === 'sol') return STRINGS.solSymbol;
        return shortAddress(amount.mint);
    }

    // "0.05 USDC · agent densifier-01 USDC account → treasury USDC account"
    function amountText(amount) {
        const value = isObject(amount) && amount.amount != null ? String(amount.amount) : '';
        const head = [value, symbolFor(amount)].filter(Boolean).join(' ');
        const from = partyLabel(isObject(amount) ? amount.from : null);
        const to = partyLabel(isObject(amount) ? amount.to : null);
        return `${head} · ${from} → ${to}`;
    }

    function ownerNote(party) {
        if (!isObject(party) || !isObject(party.owner)) return '';
        const label = partyLabel(party.owner);
        return label === STRINGS.unknownParty ? '' : label;
    }

    function amountModel(amount) {
        const from = isObject(amount) ? amount.from : null;
        const to = isObject(amount) ? amount.to : null;
        const fromAddress = partyAddress(from);
        const toAddress = partyAddress(to);
        return {
            kind: isObject(amount) ? (amount.kind || null) : null,
            mint: isObject(amount) ? (amount.mint || null) : null,
            symbol: symbolFor(amount),
            amount: isObject(amount) && amount.amount != null ? String(amount.amount) : '',
            amountAtomic: isObject(amount) && amount.amountAtomic != null ? String(amount.amountAtomic) : '',
            text: amountText(amount),
            // The title attribute carries the raw accounts, so hovering a row answers "which account
            // exactly" without expanding it.
            title: [fromAddress, toAddress].filter(Boolean).join(' → '),
            from: { label: partyLabel(from), address: fromAddress, owner: ownerNote(from) },
            to: { label: partyLabel(to), address: toAddress, owner: ownerNote(to) }
        };
    }

    function argEntries(args) {
        if (!isObject(args)) return [];
        return Object.keys(args).map((key) => {
            const value = args[key];
            const text = (value === null || value === undefined)
                ? 'null'
                : (typeof value === 'object' ? JSON.stringify(value) : String(value));
            return { key, value: text };
        });
    }

    function accountModel(account) {
        const address = partyAddress(account);
        const flags = [];
        if (account && account.signer) flags.push(STRINGS.signer);
        if (account && account.writable) flags.push(STRINGS.writable);
        return {
            role: isObject(account) ? trimmed(account.role) : '',
            label: partyLabel(account),
            address,
            short: shortAddress(address, isObject(account) ? account.short : ''),
            signer: !!(account && account.signer),
            writable: !!(account && account.writable),
            flags
        };
    }

    function instructionModel(instruction) {
        const ix = isObject(instruction) ? instruction : {};
        const program = isObject(ix.program) ? ix.program : {};
        const index = Number.isFinite(Number(ix.index)) ? Number(ix.index) : null;
        const parentIndex = Number.isFinite(Number(ix.parentIndex)) ? Number(ix.parentIndex) : null;
        const indexLabel = index === null ? '#?' : `#${index}`;
        return {
            index,
            inner: !!ix.inner,
            parentIndex,
            indexLabel: ix.inner && parentIndex !== null
                ? `${indexLabel} (${STRINGS.innerOf}${parentIndex})`
                : indexLabel,
            programLabel: trimmed(program.label) || shortAddress(program.address) || STRINGS.unknownParty,
            programName: trimmed(program.name),
            programAddress: trimmed(program.address),
            action: trimmed(ix.action),
            args: argEntries(ix.args),
            accounts: Array.isArray(ix.accounts) ? ix.accounts.map(accountModel) : []
        };
    }

    // Programs/actions a transaction is filterable by. The top-level arrays are authoritative, but
    // an instruction list that mentions more (an inner program the summariser missed) still filters.
    function programsOf(tx) {
        const names = new Set();
        if (isObject(tx)) {
            if (Array.isArray(tx.programs)) tx.programs.forEach((p) => { const v = trimmed(p); if (v) names.add(v); });
            if (Array.isArray(tx.instructions)) {
                tx.instructions.forEach((ix) => {
                    const name = isObject(ix) && isObject(ix.program) ? trimmed(ix.program.name) : '';
                    if (name) names.add(name);
                });
            }
        }
        return [...names];
    }

    function actionsOf(tx) {
        const names = new Set();
        if (isObject(tx)) {
            if (Array.isArray(tx.actions)) tx.actions.forEach((a) => { const v = trimmed(a); if (v) names.add(v); });
            if (Array.isArray(tx.instructions)) {
                tx.instructions.forEach((ix) => {
                    const action = isObject(ix) ? trimmed(ix.action) : '';
                    if (action) names.add(action);
                });
            }
        }
        return [...names];
    }

    // The text-filter haystack: every string anywhere in the transaction, lowercased. Collecting
    // recursively rather than naming fields is deliberate — signature, summary, program, action,
    // every label and every address are all covered, and a new field the backend adds is searchable
    // the day it appears instead of silently not matching.
    function searchText(tx) {
        const parts = [];
        const seen = new Set();
        const walk = (node) => {
            if (node === null || node === undefined) return;
            if (typeof node === 'string') { parts.push(node); return; }
            if (typeof node === 'number' || typeof node === 'boolean') { parts.push(String(node)); return; }
            if (typeof node !== 'object') return;
            if (seen.has(node)) return;
            seen.add(node);
            if (Array.isArray(node)) { node.forEach(walk); return; }
            Object.keys(node).forEach((key) => walk(node[key]));
        };
        walk(tx);
        return parts.join(' ').toLowerCase();
    }

    // The plain data one table row renders. No DOM, no formatting decisions left to the caller.
    function renderRowModel(tx) {
        const row = isObject(tx) ? tx : {};
        const programs = programsOf(row);
        const actions = actionsOf(row);
        const failed = row.status === 'failed' || (row.status !== 'success' && !!row.error);
        const feePayer = isObject(row.feePayer) ? row.feePayer : null;
        const feeSol = row.feeSol != null ? String(row.feeSol) : '';
        const summary = trimmed(row.summary)
            || (actions.length || programs.length
                ? `${actions.join(', ') || '?'}${programs.length ? ` · ${programs.join(', ')}` : ''}`
                : STRINGS.noSummary);
        return {
            signature: trimmed(row.signature),
            signatureShort: shortAddress(row.signature),
            slot: Number.isFinite(Number(row.slot)) ? Number(row.slot) : null,
            time: formatTime(row.time),
            blockTime: Number.isFinite(Number(row.blockTime)) ? Number(row.blockTime) : null,
            failed,
            status: failed ? 'failed' : 'success',
            statusLabel: failed ? STRINGS.statusFailed : STRINGS.statusSuccess,
            error: row.error == null ? null : (typeof row.error === 'string' ? row.error : JSON.stringify(row.error)),
            summary,
            programs,
            actions,
            tags: programs.map((text) => ({ kind: 'program', text }))
                .concat(actions.map((text) => ({ kind: 'action', text }))),
            amounts: Array.isArray(row.amounts) ? row.amounts.map(amountModel) : [],
            feePayer: {
                label: feePayer ? partyLabel(feePayer) : STRINGS.unknownParty,
                address: partyAddress(feePayer),
                short: shortAddress(partyAddress(feePayer), feePayer ? feePayer.short : '')
            },
            feeSol,
            feeLamports: Number.isFinite(Number(row.feeLamports)) ? Number(row.feeLamports) : null,
            instructions: Array.isArray(row.instructions) ? row.instructions.map(instructionModel) : [],
            searchText: searchText(row)
        };
    }

    // Cache the haystack per transaction object so typing in the filter box does not re-walk every
    // transaction tree on every keystroke. Keyed by identity: a refetch makes new objects.
    const haystackCache = typeof WeakMap === 'function' ? new WeakMap() : null;
    function haystackOf(tx) {
        if (!isObject(tx)) return '';
        if (!haystackCache) return searchText(tx);
        if (!haystackCache.has(tx)) haystackCache.set(tx, searchText(tx));
        return haystackCache.get(tx);
    }

    function toList(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value.map(trimmed).filter(Boolean);
        if (typeof value.forEach === 'function') { // Set
            const out = [];
            value.forEach((item) => { const v = trimmed(item); if (v) out.push(v); });
            return out;
        }
        const single = trimmed(value);
        return single ? [single] : [];
    }

    // AND across facets, OR within one: text AND (any selected program) AND (any selected action).
    // An empty facet is not a filter.
    function applyFilters(transactions, filters) {
        const list = Array.isArray(transactions) ? transactions : [];
        const opts = isObject(filters) ? filters : {};
        const text = trimmed(opts.text).toLowerCase();
        const programs = toList(opts.programs);
        const actions = toList(opts.actions);
        if (!text && !programs.length && !actions.length) return list.slice();
        return list.filter((tx) => {
            if (text && haystackOf(tx).indexOf(text) === -1) return false;
            if (programs.length) {
                const have = programsOf(tx);
                if (!programs.some((name) => have.indexOf(name) !== -1)) return false;
            }
            if (actions.length) {
                const have = actionsOf(tx);
                if (!actions.some((name) => have.indexOf(name) !== -1)) return false;
            }
            return true;
        });
    }

    // The "Who is who" legend: watched addresses grouped by kind, in a fixed order so the legend
    // does not reshuffle between refreshes.
    function groupWatched(watched) {
        const list = Array.isArray(watched) ? watched : [];
        const byKind = new Map();
        list.forEach((entry) => {
            if (!isObject(entry)) return;
            const address = trimmed(entry.address);
            if (!address) return;
            const kind = trimmed(entry.kind) || 'other';
            if (!byKind.has(kind)) byKind.set(kind, []);
            byKind.get(kind).push({
                address,
                label: trimmed(entry.label) || null,
                kind: trimmed(entry.kind) || null,
                short: shortAddress(address, entry.short)
            });
        });
        const known = KIND_ORDER.filter((kind) => byKind.has(kind));
        const extra = [...byKind.keys()].filter((kind) => KIND_ORDER.indexOf(kind) === -1).sort();
        return known.concat(extra).map((kind) => ({
            kind,
            label: STRINGS.kindLabels[kind] || kind,
            entries: byKind.get(kind)
        }));
    }

    // Newest first, by block time. The API already sorts, but the table's ordering is a stated
    // property of this page, so it is enforced here rather than trusted: a transaction with no
    // blockTime (not yet finalised) sorts last instead of jumping to the top as a 0.
    function sortNewestFirst(transactions) {
        const list = Array.isArray(transactions) ? transactions.slice() : [];
        return list
            .map((tx, position) => ({ tx, position }))
            .sort((a, b) => {
                const at = isObject(a.tx) && Number.isFinite(Number(a.tx.blockTime)) ? Number(a.tx.blockTime) : null;
                const bt = isObject(b.tx) && Number.isFinite(Number(b.tx.blockTime)) ? Number(b.tx.blockTime) : null;
                if (at === bt) return a.position - b.position; // stable: keep the API's order on ties
                if (at === null) return 1;
                if (bt === null) return -1;
                return bt - at;
            })
            .map((entry) => entry.tx);
    }

    // Backend base URL. Copied rule-for-rule from js/data-source.js (getDevBackendOverride +
    // LOCAL_BASE + UGT_BASE) because this page does not load that file: `?backend=<url>` override,
    // localhost/file only and persisted, else localhost:3000 in dev, else the production API.
    function resolveBackendBase(location, storage) {
        const loc = isObject(location) ? location : {};
        const host = trimmed(loc.hostname).toLowerCase();
        const protocol = trimmed(loc.protocol);
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || protocol === 'file:';
        if (isLocal) {
            let override = null;
            try {
                const param = new URLSearchParams(trimmed(loc.search)).get('backend');
                if (param) {
                    override = param;
                    if (storage) storage.setItem('cb_dev_backend_base', param);
                } else if (storage) {
                    override = storage.getItem('cb_dev_backend_base') || null;
                }
            } catch (_) { override = null; }
            if (override) return String(override).replace(/\/+$/, '');
            if (host === '127.0.0.1') return 'http://127.0.0.1:3000';
            return 'http://localhost:3000';
        }
        return 'https://api.urbangametheory.xyz';
    }

    const pureApi = {
        STRINGS,
        AUTO_REFRESH_MS,
        LIMIT_OPTIONS,
        DEFAULT_LIMIT,
        shortAddress,
        partyLabel,
        formatTime,
        explorerLinks,
        addressLink,
        amountText,
        renderRowModel,
        applyFilters,
        groupWatched,
        sortNewestFirst,
        programsOf,
        actionsOf,
        searchText,
        resolveBackendBase
    };

    // ---------------------------------------------------------------- DOM layer (thin)

    const doc = root && root.document;

    const state = {
        payload: null,
        error: null,
        loading: false,
        syncing: false,
        syncError: null,
        sample: false,
        limit: DEFAULT_LIMIT,
        auto: false,
        timer: null,
        expanded: new Set(),
        filters: { text: '', programs: new Set(), actions: new Set() }
    };

    const dom = {};

    function el(tag, attrs, children) {
        const node = doc.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach((key) => {
                const value = attrs[key];
                if (value === null || value === undefined || value === false) return;
                if (key === 'class') node.className = value;
                else if (key === 'text') node.textContent = String(value);
                else if (key === 'dataset') Object.keys(value).forEach((d) => { node.dataset[d] = value[d]; });
                else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2), value);
                else if (value === true) node.setAttribute(key, '');
                else node.setAttribute(key, String(value));
            });
        }
        (Array.isArray(children) ? children : (children ? [children] : []))
            .filter(Boolean)
            .forEach((child) => node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child));
        return node;
    }

    function clear(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
    }

    function copyButton(address) {
        if (!address) return null;
        return el('button', {
            type: 'button',
            class: 'tx-copy',
            title: STRINGS.copy,
            'aria-label': `${STRINGS.copy} ${address}`,
            dataset: { copy: address }
        }, '⧉');
    }

    function linkPair(links, labelPrefix) {
        const out = [];
        if (links.explorer) {
            out.push(el('a', {
                class: 'tx-link', href: links.explorer, target: '_blank', rel: 'noopener',
                title: `${STRINGS.explorer}${labelPrefix ? ` — ${labelPrefix}` : ''}`
            }, STRINGS.explorer));
        }
        if (links.solscan) {
            out.push(el('a', {
                class: 'tx-link', href: links.solscan, target: '_blank', rel: 'noopener',
                title: `${STRINGS.solscan}${labelPrefix ? ` — ${labelPrefix}` : ''}`
            }, STRINGS.solscan));
        }
        return out;
    }

    function explorerConfig() {
        return state.payload && isObject(state.payload.explorer) ? state.payload.explorer : {};
    }

    function transactionsOf() {
        const raw = state.payload && Array.isArray(state.payload.transactions) ? state.payload.transactions : [];
        const list = sortNewestFirst(raw);
        // In sample mode the limit selector has no API to apply it, so it trims here instead.
        return state.sample ? list.slice(0, state.limit) : list;
    }

    // ------------- header

    function renderHeader() {
        const payload = state.payload;
        const bits = [];
        if (state.loading) bits.push(state.syncing ? STRINGS.syncing : STRINGS.loading);
        else if (payload && payload.fetchedAt) {
            const when = formatTime(payload.fetchedAt);
            bits.push(`${STRINGS.fetchedAt} ${when.local}`);
            if (payload.cached) bits.push(STRINGS.cachedNote);
            if (Number.isFinite(payload.stored)) bits.push(`${payload.stored} ${STRINGS.storedCount}`);
            if (isObject(payload.sync)) {
                if (payload.sync.error) bits.push(`${STRINGS.syncFailed}: ${payload.sync.error}`);
                else if (Number.isFinite(payload.sync.newSignatures)) bits.push(`${payload.sync.newSignatures} ${STRINGS.syncNew}`);
            }
            if (state.syncError) bits.push(`${STRINGS.syncFailed}: ${state.syncError}`);
        } else if (!state.error) bits.push(STRINGS.neverFetched);
        if (state.sample) bits.push(STRINGS.sampleActive);
        dom.fetchedAt.textContent = bits.join(' · ');
        dom.fetchedAt.setAttribute('title', payload && payload.fetchedAt ? String(payload.fetchedAt) : '');
        dom.refresh.textContent = state.loading ? STRINGS.refreshing : STRINGS.refresh;
        dom.refresh.disabled = state.loading;
    }

    // ------------- legend

    function renderLegend() {
        clear(dom.legendBody);
        const watched = state.payload && Array.isArray(state.payload.watched) ? state.payload.watched : [];
        const groups = groupWatched(watched);
        if (!groups.length) {
            dom.legendBody.appendChild(el('p', { class: 'tx-muted', text: STRINGS.legendEmpty }));
            return;
        }
        groups.forEach((group) => {
            const items = group.entries.map((entry) => {
                const links = addressLink(explorerConfig(), entry.address);
                return el('li', { class: 'tx-legend-item' }, [
                    el('span', { class: 'tx-legend-label', text: entry.label || entry.short }),
                    el('code', { class: 'tx-address', title: entry.address, text: entry.short }),
                    copyButton(entry.address)
                ].concat(linkPair(links, entry.label || entry.address)));
            });
            dom.legendBody.appendChild(el('section', { class: 'tx-legend-group' }, [
                el('h3', { class: 'tx-legend-kind', text: group.label }),
                el('ul', { class: 'tx-legend-list' }, items)
            ]));
        });
    }

    // ------------- filters

    function chipRow(container, names, facet) {
        clear(container);
        if (!names.length) {
            container.appendChild(el('span', { class: 'tx-muted', text: '—' }));
            return;
        }
        const selected = state.filters[facet];
        names.forEach((name) => {
            const on = selected.has(name);
            container.appendChild(el('button', {
                type: 'button',
                class: `tx-chip${on ? ' is-on' : ''}`,
                'aria-pressed': on ? 'true' : 'false',
                dataset: { facet, value: name },
                text: name
            }));
        });
    }

    function renderFilters() {
        const list = transactionsOf();
        const programs = [...new Set(list.flatMap(programsOf))].sort();
        const actions = [...new Set(list.flatMap(actionsOf))].sort();
        chipRow(dom.programChips, programs, 'programs');
        chipRow(dom.actionChips, actions, 'actions');
        // Drop selections the current payload no longer offers, so a stale chip cannot hide every row.
        ['programs', 'actions'].forEach((facet) => {
            const available = facet === 'programs' ? programs : actions;
            [...state.filters[facet]].forEach((name) => {
                if (available.indexOf(name) === -1) state.filters[facet].delete(name);
            });
        });
    }

    // ------------- table

    function amountCell(amount) {
        return el('div', { class: 'tx-amount', title: amount.title }, [
            el('span', { class: 'tx-amount-text', text: amount.text }),
            amount.from.owner || amount.to.owner
                ? el('span', {
                    class: 'tx-amount-owner',
                    text: `owner: ${amount.from.owner || '—'} → ${amount.to.owner || '—'}`
                })
                : null
        ]);
    }

    function instructionBlock(ix) {
        const head = el('div', { class: 'tx-ix-head' }, [
            el('span', { class: 'tx-ix-index', text: ix.indexLabel }),
            el('span', { class: 'tx-ix-program', title: ix.programAddress, text: ix.programLabel }),
            ix.programName ? el('code', { class: 'tx-ix-name', text: ix.programName }) : null,
            ix.action ? el('span', { class: 'tx-ix-action', text: ix.action }) : null
        ]);

        const args = ix.args.length
            ? el('ul', { class: 'tx-args' }, ix.args.map((arg) => el('li', { class: 'tx-arg' }, [
                el('span', { class: 'tx-arg-key', text: `${arg.key}:` }),
                el('span', { class: 'tx-arg-value', text: arg.value })
            ])))
            : el('p', { class: 'tx-muted', text: STRINGS.detailsNoArgs });

        const accountRows = ix.accounts.map((account) => {
            const links = addressLink(explorerConfig(), account.address);
            return el('tr', { class: 'tx-account' }, [
                el('td', { class: 'tx-account-role', dataset: { label: 'role' }, text: account.role || '—' }),
                el('td', { class: 'tx-account-label', dataset: { label: 'who' }, text: account.label }),
                el('td', { class: 'tx-account-address', dataset: { label: 'address' } }, [
                    el('code', { class: 'tx-address', title: account.address, text: account.address || '—' }),
                    copyButton(account.address)
                ]),
                el('td', { class: 'tx-account-flags', dataset: { label: 'flags' }, text: account.flags.join(', ') || '—' }),
                el('td', { class: 'tx-account-links', dataset: { label: 'links' } }, linkPair(links, account.label))
            ]);
        });

        const accounts = accountRows.length
            ? el('table', { class: 'tx-accounts' }, [
                el('thead', {}, el('tr', {}, [
                    el('th', { text: 'Role' }), el('th', { text: 'Who' }),
                    el('th', { text: 'Address' }), el('th', { text: 'Flags' }), el('th', { text: '' })
                ])),
                el('tbody', {}, accountRows)
            ])
            : el('p', { class: 'tx-muted', text: STRINGS.detailsNoAccounts });

        return el('article', { class: 'tx-ix' }, [
            head,
            el('div', { class: 'tx-ix-body' }, [
                el('h4', { class: 'tx-ix-sub', text: STRINGS.detailsArgs }), args,
                el('h4', { class: 'tx-ix-sub', text: STRINGS.detailsAccounts }), accounts
            ])
        ]);
    }

    function detailsRow(model) {
        const panel = el('div', { class: 'tx-details-panel' }, [
            el('h3', { class: 'tx-details-title', text: STRINGS.details }),
            model.instructions.length
                ? el('div', { class: 'tx-ix-list' }, model.instructions.map(instructionBlock))
                : el('p', { class: 'tx-muted', text: '—' })
        ]);
        return el('tr', {
            class: 'tx-details-row',
            dataset: { signature: model.signature }
        }, el('td', { class: 'tx-details-cell', colspan: '8' }, panel));
    }

    function transactionRow(model) {
        const expanded = state.expanded.has(model.signature);
        const links = explorerLinks(explorerConfig(), model.signature);
        const row = el('tr', {
            class: `tx-row${model.failed ? ' is-failed' : ''}${expanded ? ' is-expanded' : ''}`,
            tabindex: '0',
            role: 'button',
            'aria-expanded': expanded ? 'true' : 'false',
            dataset: { signature: model.signature }
        }, [
            el('td', { class: 'tx-cell tx-cell-time', dataset: { label: STRINGS.colTime }, title: model.time.iso },
                el('span', { class: 'tx-time', title: model.time.iso, text: model.time.local })),
            el('td', { class: 'tx-cell tx-cell-status', dataset: { label: STRINGS.colStatus } },
                el('span', { class: `tx-status tx-status-${model.status}`, title: model.error || '', text: model.statusLabel })),
            el('td', { class: 'tx-cell tx-cell-summary', dataset: { label: STRINGS.colSummary } }, [
                el('span', { class: 'tx-summary', text: model.summary }),
                model.error ? el('span', { class: 'tx-row-error', text: model.error }) : null,
                model.slot !== null ? el('span', { class: 'tx-slot', text: `slot ${model.slot}` }) : null
            ]),
            el('td', { class: 'tx-cell tx-cell-tags', dataset: { label: STRINGS.colTags } },
                model.tags.map((tag) => el('span', { class: `tx-tag tx-tag-${tag.kind}`, text: tag.text }))),
            el('td', { class: 'tx-cell tx-cell-amounts', dataset: { label: STRINGS.colAmounts } },
                model.amounts.length ? model.amounts.map(amountCell) : [el('span', { class: 'tx-muted', text: '—' })]),
            el('td', { class: 'tx-cell tx-cell-payer', dataset: { label: STRINGS.colFeePayer } },
                el('span', { class: 'tx-payer', title: model.feePayer.address, text: model.feePayer.label })),
            el('td', { class: 'tx-cell tx-cell-fee', dataset: { label: STRINGS.colFee } },
                el('span', { class: 'tx-fee', title: model.feeLamports !== null ? `${model.feeLamports} lamports` : '', text: model.feeSol || '—' })),
            el('td', { class: 'tx-cell tx-cell-sig', dataset: { label: STRINGS.colSignature } }, [
                el('code', { class: 'tx-address', title: model.signature, text: model.signatureShort }),
                copyButton(model.signature)
            ].concat(linkPair(links, model.signature)))
        ]);
        return row;
    }

    function renderTable() {
        const list = transactionsOf();
        const filtered = applyFilters(list, {
            text: state.filters.text,
            programs: state.filters.programs,
            actions: state.filters.actions
        });
        clear(dom.tbody);
        filtered.forEach((tx) => {
            const model = renderRowModel(tx);
            dom.tbody.appendChild(transactionRow(model));
            if (state.expanded.has(model.signature)) dom.tbody.appendChild(detailsRow(model));
        });
        const hasAny = list.length > 0;
        dom.empty.textContent = state.loading && !hasAny ? STRINGS.loading : (hasAny ? STRINGS.emptyFiltered : STRINGS.empty);
        dom.empty.hidden = filtered.length > 0;
        dom.table.hidden = filtered.length === 0;
        dom.count.textContent = hasAny
            ? `${STRINGS.showing} ${filtered.length} ${STRINGS.of} ${list.length} ${STRINGS.transactions}`
            : '';
    }

    function renderBanner() {
        dom.banner.hidden = !state.error;
        dom.banner.textContent = state.error ? `${STRINGS.errorPrefix}: ${state.error}` : '';
    }

    function render() {
        renderHeader();
        renderBanner();
        renderLegend();
        renderFilters();
        renderTable();
    }

    // ------------- data

    function backendBase() {
        let storage = null;
        try { storage = root.localStorage; } catch (_) { storage = null; }
        return resolveBackendBase(root.location, storage);
    }

    async function readError(response) {
        let detail = '';
        try {
            const body = await response.json();
            if (isObject(body) && body.error) detail = String(body.error);
        } catch (_) { detail = ''; }
        return `HTTP ${response.status}${detail ? ` — ${detail}` : ''}`;
    }

    // When the chain query fails, the legend is still worth having: /transactions/watched answers
    // from config alone, so the operator can at least see who is who while the RPC is down.
    async function loadWatchedFallback() {
        if (state.sample) return;
        try {
            const response = await root.fetch(`${backendBase()}/transactions/watched`, { headers: { accept: 'application/json' } });
            if (!response.ok) return;
            const body = await response.json();
            if (!isObject(body)) return;
            state.payload = Object.assign({ transactions: [] }, state.payload || {}, {
                explorer: body.explorer || (state.payload && state.payload.explorer) || {},
                watched: Array.isArray(body.watched) ? body.watched : [],
                transactions: (state.payload && state.payload.transactions) || []
            });
        } catch (_) { /* the banner already says the load failed */ }
    }

    // The backend keeps every decoded transaction in Postgres and only asks the chain for NEW
    // signatures. A plain load lets the server decide whether a sync is due (it gates syncs by a
    // TTL); the Refresh button forces one first, then reads the store without a second sync.
    async function syncNow() {
        try {
            const response = await root.fetch(`${backendBase()}/transactions/sync`, { method: 'POST', headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(await readError(response));
            const body = await response.json();
            state.syncError = null;
            return isObject(body) ? body : null;
        } catch (error) {
            state.syncError = (error && error.message) ? error.message : String(error);
            return null;
        }
    }

    async function load({ sync = false } = {}) {
        if (state.loading) return;
        state.loading = true;
        state.syncing = Boolean(sync) && !state.sample;
        renderHeader();
        try {
            if (state.syncing) {
                await syncNow();
                state.syncing = false;
                renderHeader();
            }
            const url = state.sample
                ? SAMPLE_URL
                : `${backendBase()}/transactions?limit=${encodeURIComponent(state.limit)}${sync ? '&sync=0' : ''}`;
            const response = await root.fetch(url, { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(await readError(response));
            const body = await response.json();
            if (!isObject(body)) throw new Error('unexpected response shape');
            state.payload = body;
            state.error = null;
        } catch (error) {
            state.error = (error && error.message) ? error.message : String(error);
            await loadWatchedFallback();
        } finally {
            state.loading = false;
            render();
            scheduleAuto();
        }
    }

    // Auto-refresh is chained off the COMPLETION of the previous load, never a blind setInterval:
    // a slow RPC must not stack overlapping fetches on top of each other.
    function scheduleAuto() {
        if (state.timer) { root.clearTimeout(state.timer); state.timer = null; }
        if (!state.auto) return;
        state.timer = root.setTimeout(() => { state.timer = null; load(); }, AUTO_REFRESH_MS);
    }

    // ------------- wiring

    function toggleRow(signature) {
        if (!signature) return;
        if (state.expanded.has(signature)) state.expanded.delete(signature);
        else state.expanded.add(signature);
        renderTable();
    }

    function onCopy(button) {
        const value = button.dataset.copy;
        if (!value) return;
        const done = () => {
            button.classList.add('is-copied');
            button.addEventListener('animationend', () => button.classList.remove('is-copied'), { once: true });
        };
        try {
            const clipboard = root.navigator && root.navigator.clipboard;
            if (clipboard && clipboard.writeText) clipboard.writeText(value).then(done, () => { });
        } catch (_) { /* clipboard blocked; the full address is in the title attribute */ }
    }

    function bind() {
        dom.refresh.addEventListener('click', () => load({ sync: true }));
        dom.auto.addEventListener('change', () => {
            state.auto = !!dom.auto.checked;
            scheduleAuto();
        });
        dom.limit.addEventListener('change', () => {
            const value = Number(dom.limit.value);
            state.limit = LIMIT_OPTIONS.indexOf(value) === -1 ? DEFAULT_LIMIT : value;
            if (state.sample) { render(); return; }
            load();
        });
        dom.search.addEventListener('input', () => {
            state.filters.text = dom.search.value || '';
            renderTable();
        });
        dom.clear.addEventListener('click', () => {
            state.filters.text = '';
            state.filters.programs.clear();
            state.filters.actions.clear();
            dom.search.value = '';
            renderFilters();
            renderTable();
        });
        dom.filters.addEventListener('click', (event) => {
            const chip = event.target.closest('.tx-chip');
            if (!chip) return;
            const facet = chip.dataset.facet;
            const value = chip.dataset.value;
            if (!facet || !value || !state.filters[facet]) return;
            if (state.filters[facet].has(value)) state.filters[facet].delete(value);
            else state.filters[facet].add(value);
            renderFilters();
            renderTable();
        });
        dom.root.addEventListener('click', (event) => {
            const copy = event.target.closest('.tx-copy');
            if (copy) { event.stopPropagation(); onCopy(copy); return; }
            if (event.target.closest('a')) return; // explorer links open normally
            const row = event.target.closest('.tx-row');
            if (row) toggleRow(row.dataset.signature);
        });
        dom.tbody.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
            const row = event.target.closest('.tx-row');
            if (!row || event.target.closest('a, button')) return;
            event.preventDefault();
            toggleRow(row.dataset.signature);
        });
    }

    function boot() {
        dom.root = doc.getElementById('tx-explorer');
        if (!dom.root) return;
        dom.fetchedAt = doc.getElementById('tx-fetched-at');
        dom.refresh = doc.getElementById('tx-refresh');
        dom.auto = doc.getElementById('tx-auto');
        dom.limit = doc.getElementById('tx-limit');
        dom.search = doc.getElementById('tx-search');
        dom.clear = doc.getElementById('tx-filter-clear');
        dom.filters = doc.getElementById('tx-filters');
        dom.programChips = doc.getElementById('tx-program-chips');
        dom.actionChips = doc.getElementById('tx-action-chips');
        dom.legendBody = doc.getElementById('tx-legend-body');
        dom.banner = doc.getElementById('tx-banner');
        dom.table = doc.getElementById('tx-table');
        dom.tbody = doc.getElementById('tx-tbody');
        dom.empty = doc.getElementById('tx-empty');
        dom.count = doc.getElementById('tx-count');

        try {
            state.sample = new URLSearchParams(root.location.search).get('sample') === '1';
        } catch (_) { state.sample = false; }

        dom.limit.value = String(state.limit);
        dom.auto.checked = false;
        bind();
        render();
        load();
    }

    return Object.assign({ boot }, pureApi);
});
