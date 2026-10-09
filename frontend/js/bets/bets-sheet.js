// The Bets sheet: the city's contests (proposals on the same land) with each proposal's yes/no
// pool, from GET /markets. A thin DOM layer over js/bets/bets-model.js: it fetches when the sheet
// opens, renders rows, and hands a bet to the existing market dialog (proposals/details-panel.js)
// and a pool opening or settlement to the market bridge (solana/market-bridge.js).
(function (root) {
    'use strict';
    if (!root || !root.document) return;

    const doc = root.document;
    const SHEET_ID = 'bets-sheet';
    const CONTENT_ID = 'bets-sheet-content';
    const SEEN_KEY = 'cb.bets.seen';           // per-viewer: the "New" word goes once the sheet was opened
    const FRESH_MS = 20_000;                    // matches the backend's per-city cache
    // positions: the connected wallet's bets per proposal account (solana/market-bridge.js
    // readPositions); changed: the proposal account a confirmed transaction just touched, marked on
    // its row after the next render.
    const state = { city: null, loadedAt: 0, payload: null, loading: null, positions: {}, changed: null };

    function interpolate(text, params) {
        return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (params && key in params ? params[key] : match));
    }

    function t(key, fallback, params) {
        const i18n = root.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params);
            if (value && value !== key) return value;
        }
        return interpolate(fallback, params);
    }

    const backendBase = () => (typeof root.getBackendBase === 'function'
        ? root.getBackendBase().replace(/\/$/, '')
        : 'https://api.urbangametheory.xyz');
    const cityCode = () => (typeof root.resolveCurrentCityCode === 'function' ? root.resolveCurrentCityCode() : null);
    const format = () => root.CbFormat || null;

    function el(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function moneyText(amountText) {
        const f = format();
        return f && typeof f.formatMoney === 'function' ? f.formatMoney(Number(amountText), 'USDC') : `${amountText} USDC`;
    }

    function percentText(value) {
        const f = format();
        return f && typeof f.formatPercent === 'function'
            ? f.formatPercent(value, { ofHundred: true, maxFractionDigits: 1 })
            : `${value}%`;
    }

    function dateText(value) {
        const f = format();
        if (f && typeof f.formatDate === 'function') return f.formatDate(value);
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
    }

    // The parcel number people know, not the whole uid (js/bets/bets-model.js parcelLabel).
    function parcelText(parcelId) {
        return root.BetsModel && typeof root.BetsModel.parcelLabel === 'function' ? root.BetsModel.parcelLabel(parcelId) : String(parcelId);
    }

    function walletConnected() {
        const walletState = root.solanaWalletManager && typeof root.solanaWalletManager.getState === 'function'
            ? root.solanaWalletManager.getState() : null;
        return !!(walletState && walletState.status === 'connected' && Array.isArray(walletState.accounts) && walletState.accounts.length);
    }

    function askForWallet() {
        if (typeof root.handleWalletButtonClick === 'function') root.handleWalletButtonClick();
    }

    function setNote(row, text, tone) {
        const note = row.querySelector('.bets-row__note') || row.appendChild(el('p', 'bets-row__note'));
        note.textContent = text;
        note.classList.toggle('bets-status--error', tone === 'error');
    }

    function announceChange(proposalAccount) {
        try { doc.dispatchEvent(new root.CustomEvent('proposal-market:changed', { detail: { proposalAccount } })); } catch (_) { }
    }

    // "Your bets: yes 0.05 USDC" for a row, from the wallet's decoded positions; empty without any.
    function mineText(row) {
        const positions = state.positions[row.proposalAccount];
        if (!positions || !root.BetsModel) return '';
        const sideWord = side => (side === 'yes' ? t('bets.row.yes', 'Yes') : t('bets.row.no', 'No')).toLowerCase();
        const lines = ['yes', 'no']
            .filter(side => positions[side] && root.BetsModel.formatAtomic(positions[side].amount) !== '0')
            .map(side => t('panel.proposal.market.betLine', '{{side}} {{amount}}', { side: sideWord(side), amount: moneyText(root.BetsModel.formatAtomic(positions[side].amount)) }));
        return lines.length ? t('panel.proposal.market.yourBets', 'Your bets: {{lines}}', { lines: lines.join('; ') }) : '';
    }

    function renderMine(li, row) {
        const text = mineText(row);
        let mine = li.querySelector('.bets-row__mine');
        if (!text) { if (mine) mine.remove(); return; }
        if (!mine) {
            mine = el('p', 'bets-row__mine');
            const actions = li.querySelector('.bets-row__actions');
            if (actions) actions.before(mine); else li.append(mine);
        }
        mine.textContent = text;
    }

    // The wallet's positions for every row with a pool, one RPC round trip, then written into the
    // rows already on screen (no re-render, so a press in progress is not lost).
    async function loadPositions(payload) {
        const bridge = root.SolanaMarketBridge;
        if (!bridge || typeof bridge.readPositions !== 'function') return;
        const accounts = (payload && payload.contests ? payload.contests : [])
            .flatMap(contest => contest.proposals || [])
            .filter(entry => entry.proposalAccount && entry.market)
            .map(entry => entry.proposalAccount);
        if (!walletConnected() || !accounts.length) { state.positions = {}; }
        else {
            try {
                state.positions = await bridge.readPositions(accounts);
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] [bets] positions unreadable`, error);
                state.positions = {};
            }
        }
        if (state.payload !== payload) return;
        const container = doc.getElementById(CONTENT_ID);
        if (!container) return;
        container.querySelectorAll('.bets-row[data-proposal-account]').forEach(li => renderMine(li, { proposalAccount: li.dataset.proposalAccount }));
    }

    // The row a confirmed transaction just changed: brought into view and marked, so the new chance,
    // payout and pool are seen next to the person's own bet.
    function markChanged(container) {
        if (!state.changed || !container) return;
        const li = container.querySelector(`.bets-row[data-proposal-account="${state.changed}"]`);
        state.changed = null;
        if (!li) return;
        li.classList.add('is-updated');
        if (typeof li.scrollIntoView === 'function') { try { li.scrollIntoView({ block: 'nearest' }); } catch (_) { } }
    }

    // ---- actions ----------------------------------------------------------------------------

    function placeBet(row, side) {
        if (!walletConnected()) { askForWallet(); return; }
        if (typeof root.openProposalMarketStakeDialog === 'function') root.openProposalMarketStakeDialog(row.proposalAccount, side);
    }

    // Opening a pool or settling one is a single wallet transaction through the shared bridge; the
    // row shows the lifecycle words and the result, and the human action lands in the activity feed.
    async function marketTransaction(li, row, action, button) {
        if (!walletConnected()) { askForWallet(); return; }
        const bridge = root.SolanaMarketBridge;
        const view = root.ProposalMarketView;
        if (!bridge || typeof bridge[action] !== 'function') return;
        button.disabled = true;
        try {
            const result = await bridge[action]({
                proposal: row.proposalAccount,
                onStatus: item => setNote(li, view && typeof view.statusText === 'function' ? view.statusText(item) : '')
            });
            setNote(li, action === 'createMarket' ? t('bets.row.opened', 'Pool opened') : t('bets.row.settled', 'Pool settled'));
            if (typeof root.recordHumanProposalSupport === 'function') {
                const wallet = root.solanaWalletManager.getState().accounts[0];
                await root.recordHumanProposalSupport({ wallet, action, proposalId: row.proposalAccount, result, message: `${wallet.slice(0, 4)}…${wallet.slice(-4)}: ${action}` });
            }
            announceChange(row.proposalAccount);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [bets] ${action} failed`, error);
            setNote(li, view && typeof view.errorText === 'function' ? view.errorText(error) : t('bets.error.transaction', 'The transaction failed.'), 'error');
        } finally {
            button.disabled = false;
        }
    }

    async function openProposal(row) {
        try {
            let proposal = typeof root.getProposalByIdOrHash === 'function' ? root.getProposalByIdOrHash(row.proposalId) : null;
            if (!proposal && typeof root.importServerProposal === 'function') proposal = await root.importServerProposal(row.id);
            if (!proposal) throw new Error(`proposal ${row.proposalId} is not available`);
            if (typeof root.openProposalFromList === 'function') root.openProposalFromList(proposal.proposalId || row.proposalId, { proposal, closeSheets: true });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [bets] open proposal failed`, error);
            renderStatus(doc.getElementById(CONTENT_ID), t('bets.error.open', 'The proposal could not be opened.'), 'error');
        }
    }

    // ---- rendering --------------------------------------------------------------------------

    function renderStatus(container, text, tone) {
        if (!container) return;
        container.replaceChildren();
        container.append(el('p', `bets-status${tone === 'error' ? ' bets-status--error' : ''}`, text));
        if (tone === 'error') {
            const retry = el('button', 'btn', t('bets.retry', 'Try again'));
            retry.type = 'button';
            retry.addEventListener('click', () => load({ force: true }));
            container.append(retry);
        }
    }

    function betButton(row, side) {
        const yes = side === 1;
        const multiple = yes ? row.paysYes : row.paysNo;
        const button = el('button', `btn ${yes ? 'btn-market-yes' : 'btn-market-no'}`);
        button.type = 'button';
        button.append(el('strong', 'bets-bet__side', yes ? t('bets.row.yes', 'Yes') : t('bets.row.no', 'No')));
        if (multiple !== null && multiple !== undefined) {
            button.append(el('span', 'bets-bet__pays', t('bets.row.pays', 'Pays {{multiple}}×', { multiple: multiple.toFixed(2) })));
        }
        const paysTitle = multiple !== null && multiple !== undefined
            ? ' ' + t('bets.row.paysTitle', '1 USDC on this side pays {{multiple}} USDC if it wins.', { multiple: multiple.toFixed(2) })
            : '';
        button.title = (yes
            ? t('bets.row.yesTitle', 'Bet that this proposal gets built.')
            : t('bets.row.noTitle', 'Bet that this proposal does not get built.')) + paysTitle;
        button.addEventListener('click', () => placeBet(row, side));
        return button;
    }

    function chanceLabel(row) {
        if (row.state === 'resolved-yes') return t('bets.row.resolvedYes', 'Settled yes');
        if (row.state === 'resolved-no') return t('bets.row.resolvedNo', 'Settled no');
        if (row.chanceYes === null || row.chanceYes === undefined) return t('bets.row.noBets', 'No bets yet');
        return t('bets.row.chance', '{{percent}} chance', { percent: percentText(row.chanceYes) });
    }

    function renderRow(row) {
        const li = el('li', `bets-row is-${row.state}`);
        li.dataset.proposalId = row.proposalId;
        if (row.proposalAccount) li.dataset.proposalAccount = row.proposalAccount;

        const head = el('div', 'bets-row__head');
        const title = el('button', 'btn btn-quiet bets-row__title', row.title || t('bets.row.untitled', 'Untitled proposal'));
        title.type = 'button';
        title.addEventListener('click', () => openProposal(row));
        head.append(title, el('span', 'bets-row__chance', chanceLabel(row)));
        li.append(head);

        if (row.state === 'open' && row.chanceYes !== null && row.chanceYes !== undefined) {
            const bar = el('div', 'bets-row__bar');
            const fill = el('span');
            fill.style.width = `${Math.max(0, Math.min(100, row.chanceYes))}%`;
            bar.append(fill);
            li.append(bar);
        }

        const meta = el('div', 'bets-row__meta');
        if (row.pool !== null && row.pool !== undefined) meta.append(el('span', null, t('bets.row.pool', 'Pool {{amount}}', { amount: moneyText(row.pool) })));
        if (row.closesAt) meta.append(el('span', null, t('bets.row.closes', 'Closes {{date}}', { date: dateText(row.closesAt) })));
        if (row.agent) meta.append(el('span', null, t('panel.proposal.agent.badge', 'Agent proposal')));
        if (meta.childElementCount) li.append(meta);
        renderMine(li, row);

        const actions = el('div', 'bets-row__actions');
        if (row.state === 'open') {
            actions.append(betButton(row, 1), betButton(row, 0));
        } else if (row.state === 'needs-market') {
            const open = el('button', 'btn', t('bets.row.openMarket', 'Open the pool'));
            open.type = 'button';
            open.addEventListener('click', () => marketTransaction(li, row, 'createMarket', open));
            actions.append(open);
        } else if (row.state === 'settling') {
            li.append(el('p', 'bets-row__note', t('bets.row.settling', 'Decided on-chain; anyone can settle the pool')));
            const settle = el('button', 'btn', t('bets.row.settle', 'Settle the pool'));
            settle.type = 'button';
            settle.addEventListener('click', () => marketTransaction(li, row, 'resolve', settle));
            actions.append(settle);
        } else if (row.state === 'not-minted') {
            li.append(el('p', 'bets-row__note', t('bets.row.notMinted', 'Not minted yet, so no pool')));
        } else if (row.state === 'closed') {
            li.append(el('p', 'bets-row__note', t('bets.row.closed', 'Decided on-chain before a pool was opened')));
        }
        if (actions.childElementCount) li.append(actions);
        return li;
    }

    function landText(contest) {
        if (contest.siteName) return contest.siteName;
        if (!contest.land.first) return t('bets.contest.site', 'Drawn site');
        const parcel = parcelText(contest.land.first);
        return contest.land.more
            ? t('bets.contest.landMore', 'Parcel {{parcel}} and {{count}} more', { parcel, count: contest.land.more })
            : t('bets.contest.land', 'Parcel {{parcel}}', { parcel });
    }

    function renderContest(contest) {
        const article = el('article', 'bets-contest');
        article.dataset.contestId = contest.id;
        const head = el('header', 'bets-contest__head');
        head.append(el('h3', 'bets-contest__title', contest.proposalCount > 1
            ? t('bets.contest.title', 'Which proposal gets built?')
            : t('bets.contest.titleSingle', 'Does this proposal get built?')));
        const land = el('p', 'bets-contest__land');
        land.title = contest.parcelIds.join(', ');
        land.textContent = [
            landText(contest),
            t('agentDialog.proposalCount', '{{count}} proposals', { count: contest.proposalCount }),
            t('bets.row.pool', 'Pool {{amount}}', { amount: moneyText(contest.pool) })
        ].join(' · ');
        head.append(land);
        article.append(head);
        const list = el('ul', 'bets-rows');
        contest.rows.forEach(row => list.append(renderRow(row)));
        article.append(list);
        return article;
    }

    function render(container, payload) {
        if (!container || !root.BetsModel) return;
        const contests = (payload.contests || []).map(contest => root.BetsModel.contest(contest, { decimals: payload.stakeDecimals }));
        container.replaceChildren();
        if (!contests.length) {
            renderStatus(container, t('bets.empty', 'No pools in this city yet. Mint a proposal to open the first one.'));
            return;
        }
        contests.forEach(contest => container.append(renderContest(contest)));
        markChanged(container);
    }

    // ---- loading ----------------------------------------------------------------------------

    async function load(options = {}) {
        const container = doc.getElementById(CONTENT_ID);
        if (!container) return null;
        const city = cityCode();
        const fresh = state.payload && state.city === city && Date.now() - state.loadedAt < FRESH_MS;
        if (!options.force && fresh) { render(container, state.payload); loadPositions(state.payload); return state.payload; }
        if (state.fresh) { options = { ...options, fresh: true }; state.fresh = false; }
        if (state.loading) return state.loading;
        if (!state.payload || state.city !== city) renderStatus(container, t('bets.loading', 'Loading bets…'));
        state.loading = (async () => {
            try {
                const response = await fetch(`${backendBase()}/markets?city=${encodeURIComponent(city || '')}${options.fresh ? '&fresh=1' : ''}`);
                if (!response.ok) throw new Error(`markets returned ${response.status}`);
                const payload = await response.json();
                state.payload = payload;
                state.city = city;
                state.loadedAt = Date.now();
                render(container, payload);
                loadPositions(payload);
                return payload;
            } catch (error) {
                console.error(`[${new Date().toISOString()}] [bets] load failed`, error);
                renderStatus(container, t('bets.error.load', 'Bets could not be loaded.'), 'error');
                return null;
            } finally {
                state.loading = null;
            }
        })();
        return state.loading;
    }

    function init() {
        const pill = doc.getElementById('bets-button-new');
        let seen = false;
        try { seen = root.localStorage.getItem(SEEN_KEY) === '1'; } catch (_) { seen = false; }
        if (pill) pill.hidden = seen;
        doc.addEventListener('mapshell:sheetopened', event => {
            if (!event.detail || event.detail.id !== SHEET_ID) return;
            if (pill && !pill.hidden) {
                pill.hidden = true;
                try { root.localStorage.setItem(SEEN_KEY, '1'); } catch (_) { }
            }
            load();
        });
        const isOpen = () => !!(root.MapShell && typeof root.MapShell.isOpen === 'function' && root.MapShell.isOpen(SHEET_ID));
        // A confirmed pool transaction: re-read past the server's short cache, so the pool that was
        // just opened or bet on shows up at once.
        doc.addEventListener('proposal-market:changed', event => {
            state.loadedAt = 0;
            state.fresh = true;
            state.changed = event.detail && event.detail.proposalAccount ? event.detail.proposalAccount : null;
            if (isOpen()) load({ force: true, fresh: true });
        });
        // A wallet connecting or leaving changes whose bets the rows show.
        const manager = root.solanaWalletManager;
        if (manager && typeof manager.on === 'function') {
            ['accountsChanged', 'disconnect'].forEach(name => manager.on(name, () => { if (isOpen() && state.payload) loadPositions(state.payload); }));
        }
        root.addEventListener('cityChanged', () => {
            state.payload = null;
            state.city = null;
            if (isOpen()) load({ force: true });
        });
    }

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
    else init();

    root.openBetsSheet = function openBetsSheet() {
        if (root.MapShell && typeof root.MapShell.openSheet === 'function') root.MapShell.openSheet(SHEET_ID);
    };
    root.BetsSheet = { load, render, SHEET_ID };
})(typeof window !== 'undefined' ? window : null);
