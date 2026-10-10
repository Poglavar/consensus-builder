// The Bets sheet: the city's contests (proposals on the same land) with each proposal's yes/no
// pool, from GET /markets. A thin DOM layer over js/bets/bets-model.js: it fetches when the sheet
// opens, renders the filter and the rows, and hands a bet to the bet's own dialog
// (js/bets/bets-dialog.js) and a pool opening, settlement or collection to the market bridge
// (js/solana/market-bridge.js). The dialog reads its row from here (rowFor, positionsFor).
(function (root) {
    'use strict';
    if (!root || !root.document) return;

    const doc = root.document;
    const SHEET_ID = 'bets-sheet';
    const CONTENT_ID = 'bets-sheet-content';
    const FILTER_ID = 'bets-sheet-filter';
    const SEEN_KEY = 'cb.bets.seen';           // per-viewer: the "New" word goes once the sheet was opened
    const FRESH_MS = 20_000;                    // matches the backend's per-city cache
    // positions: the connected wallet's bets per proposal account (solana/market-bridge.js
    // readPositions); changed: the proposal account a confirmed transaction just touched, marked on
    // its row after the next render; scrollTo: the contest a dialog sent the person back to;
    // filter: all | open | settled | mine (js/bets/bets-model.js filterRows).
    const state = { city: null, loadedAt: 0, payload: null, loading: null, positions: {}, changed: null, scrollTo: null, filter: 'all' };

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

    function dateText(value, withTime) {
        const f = format();
        const fn = withTime ? 'formatDateTime' : 'formatDate';
        if (f && typeof f[fn] === 'function') return f[fn](value);
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : (withTime ? date.toLocaleString() : date.toLocaleDateString());
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

    const sideWord = side => (side === 'yes' ? t('bets.row.yes', 'Yes') : t('bets.row.no', 'No')).toLowerCase();

    // "Your bets: yes 0.05 USDC" for a row, from the wallet's decoded positions; empty without any.
    function mineText(row) {
        const positions = state.positions[row.proposalAccount];
        if (!positions || !root.BetsModel) return '';
        const lines = ['yes', 'no']
            .filter(side => positions[side] && root.BetsModel.formatAtomic(positions[side].amount) !== '0')
            .map(side => t('panel.proposal.market.betLine', '{{side}} {{amount}}', { side: sideWord(side), amount: moneyText(root.BetsModel.formatAtomic(positions[side].amount)) })
                + (positions[side].claimed ? ` (${t('panel.proposal.market.paidOut', 'paid out')})` : ''));
        return lines.length ? t('panel.proposal.market.yourBets', 'Your bets: {{lines}}', { lines: lines.join('; ') }) : '';
    }

    function renderMine(li, row) {
        const text = mineText(row);
        let mine = li.querySelector('.bets-row__mine');
        if (!text) { if (mine) mine.remove(); }
        else {
            if (!mine) {
                mine = el('p', 'bets-row__mine');
                const actions = li.querySelector('.bets-row__actions');
                if (actions) actions.before(mine); else li.append(mine);
            }
            mine.textContent = text;
        }
        renderCollect(li, row);
    }

    // A settled pool the wallet can still collect from gets its Collect button on the row, so a
    // winner does not have to find the proposal's details to be paid.
    function renderCollect(li, row) {
        const existing = li.querySelector('.bets-row__collect');
        if (existing) existing.remove();
        if (!root.BetsModel || !row.proposalAccount) return;
        const full = rowFor(row.proposalAccount);
        const sides = full ? root.BetsModel.claimSides(full.row, state.positions[row.proposalAccount]) : [];
        if (!sides.length) return;
        const collect = el('div', 'bets-row__collect');
        sides.forEach(side => {
            const button = el('button', 'btn btn-success', t('panel.proposal.market.collect', 'Collect {{side}} winnings', { side: sideWord(side) }));
            button.type = 'button';
            button.addEventListener('click', () => marketTransaction(li, full.row, 'claim', button, side === 'yes' ? 1 : 0));
            collect.append(button);
        });
        li.append(collect);
    }

    // The wallet's positions for every row with a pool, one RPC round trip, then written into the
    // rows already on screen (no re-render, so a press in progress is not lost); the "Mine" filter
    // is the one view that needs the rows drawn again.
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
        if (state.filter === 'mine') { render(container, payload); return; }
        container.querySelectorAll('.bets-row[data-proposal-account]').forEach(li => renderMine(li, { proposalAccount: li.dataset.proposalAccount }));
    }

    // The shareable link to one row's bet (js/bets/bets-link.js): this origin, the current city and
    // the language the page was opened in.
    function linkFor(proposalAccount) {
        const link = root.BetsLink;
        if (!link || !proposalAccount) return null;
        const manager = root.CityConfigManager;
        const city = manager && typeof manager.getCurrentCityId === 'function' ? manager.getCurrentCityId() : null;
        let lang = null;
        try { lang = new URL(root.location.href).searchParams.get('lang'); } catch (_) { lang = null; }
        try { return link.build({ origin: root.location.origin, city, proposalAccount, lang }); } catch (_) { return null; }
    }

    // Put the row's link on the clipboard; the shared helper shows "Copied".
    async function copyLink(proposalAccount) {
        const href = linkFor(proposalAccount);
        if (!href) return false;
        if (typeof root.copyTextWithFeedback === 'function') return root.copyTextWithFeedback(href);
        try {
            await root.navigator.clipboard.writeText(href);
            return true;
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [bets] link not copied`, error);
            return false;
        }
    }

    // The row a confirmed transaction just changed, brought into view and marked, so the chance,
    // payout and pool are seen next to the person's own bet; or the contest a dialog pointed back to.
    function markChanged(container) {
        if (!container) return;
        if (state.scrollTo) {
            const contest = container.querySelector(`.bets-contest[data-contest-id="${state.scrollTo}"]`);
            state.scrollTo = null;
            if (contest && typeof contest.scrollIntoView === 'function') { try { contest.scrollIntoView({ block: 'start' }); } catch (_) { } }
        }
        if (!state.changed) return;
        const li = container.querySelector(`.bets-row[data-proposal-account="${state.changed}"]`);
        state.changed = null;
        if (!li) return;
        li.classList.add('is-updated');
        if (typeof li.scrollIntoView === 'function') { try { li.scrollIntoView({ block: 'nearest' }); } catch (_) { } }
    }

    // ---- the dialog's view of the payload ------------------------------------------------------

    function contests(payload = state.payload) {
        if (!payload || !root.BetsModel) return [];
        return (payload.contests || []).map(contest => root.BetsModel.contest(contest, { decimals: payload.stakeDecimals }));
    }

    // The contest and row of one proposal account in the loaded city, as the model shapes them.
    function rowFor(proposalAccount) {
        if (!proposalAccount) return null;
        for (const contest of contests()) {
            const row = contest.rows.find(item => item.proposalAccount === proposalAccount);
            if (row) return { contest, row };
        }
        return null;
    }

    const positionsFor = proposalAccount => (proposalAccount && state.positions[proposalAccount]) || null;
    // Settles once the positions read that a load started has finished (or at once when none is running).
    const whenPositions = () => Promise.resolve(state.positionsLoading || null);

    // ---- actions ----------------------------------------------------------------------------

    function placeBet(row, side) {
        if (!walletConnected()) { askForWallet(); return; }
        if (typeof root.openBetDialog === 'function') root.openBetDialog({ proposalAccount: row.proposalAccount, side });
    }

    function openBet(row) {
        if (typeof root.openBetDialog === 'function') root.openBetDialog({ proposalAccount: row.proposalAccount });
    }

    // Opening, settling or collecting from a pool is a single wallet transaction through the shared
    // bridge; the row shows the lifecycle words and the result, and the human action lands in the
    // activity feed.
    async function marketTransaction(li, row, action, button, side = null) {
        if (!walletConnected()) { askForWallet(); return; }
        const bridge = root.SolanaMarketBridge;
        const view = root.ProposalMarketView;
        if (!bridge || typeof bridge[action] !== 'function') return;
        button.disabled = true;
        try {
            const result = await bridge[action]({
                proposal: row.proposalAccount,
                ...(side === null ? {} : { side }),
                onStatus: item => setNote(li, view && typeof view.statusText === 'function' ? view.statusText(item) : '')
            });
            const done = action === 'createMarket' ? t('bets.row.opened', 'Pool opened')
                : action === 'claim' ? t('panel.proposal.market.collectedMessage', 'Collected {{side}} winnings.', { side: sideWord(side === 1 ? 'yes' : 'no') })
                    : t('bets.row.settled', 'Pool settled');
            setNote(li, done);
            if (typeof root.recordHumanProposalSupport === 'function') {
                const wallet = root.solanaWalletManager.getState().accounts[0];
                await root.recordHumanProposalSupport({ wallet, action, proposalId: row.proposalAccount, result, message: `${wallet.slice(0, 4)}…${wallet.slice(-4)}: ${done}` });
            }
            announceChange(row.proposalAccount);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [bets] ${action} failed`, error);
            setNote(li, view && typeof view.errorText === 'function' ? view.errorText(error) : t('bets.error.transaction', 'The transaction failed.'), 'error');
        } finally {
            button.disabled = false;
        }
    }

    // A named plan opens the way its link does: the address becomes /proposals/<slug> and the app's
    // own route handler applies the plan's members (proposals/core.js handleProposalRouteFromUrl).
    async function openPlan(row) {
        try {
            if (!row.planSlug || typeof root.handleProposalRouteFromUrl !== 'function') throw new Error(`plan ${row.planSlug} cannot be opened here`);
            if (root.MapShell && typeof root.MapShell.closeSheets === 'function') root.MapShell.closeSheets();
            const url = new URL(root.location.href);
            url.pathname = `/proposals/${encodeURIComponent(row.planSlug)}`;
            url.searchParams.delete('bets');
            root.history.pushState({}, '', `${url.pathname}${url.search}`);
            await root.handleProposalRouteFromUrl();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [bets] open plan failed`, error);
            renderStatus(doc.getElementById(CONTENT_ID), t('bets.error.openPlan', 'The plan could not be opened.'), 'error');
        }
    }

    async function openProposal(row) {
        if (row && row.kind === 'plan') return openPlan(row);
        try {
            let proposal = typeof root.getProposalByIdOrHash === 'function' ? root.getProposalByIdOrHash(row.proposalId) : null;
            if (!proposal && row.id && typeof root.importServerProposal === 'function') proposal = await root.importServerProposal(row.id);
            if (!proposal) throw new Error(`proposal ${row.proposalId} is not available`);
            if (typeof root.openProposalFromList === 'function') root.openProposalFromList(proposal.proposalId || row.proposalId, { proposal, closeSheets: true });
        } catch (error) {
            if (error?.code === 'proposal-in-other-city' && typeof root.openProposalInItsCity === 'function') {
                await root.openProposalInItsCity(row.id || row.proposalId, error.cityId);
                return;
            }
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

    // A one-sided pool is not a chance worth printing: "100%" on one 0.25 USDC bet misleads.
    function chanceLabel(row) {
        if (row.state === 'resolved-yes') return t('bets.row.resolvedYes', 'Settled yes');
        if (row.state === 'resolved-no') return t('bets.row.resolvedNo', 'Settled no');
        if (row.oneSided === 'yes') return t('bets.row.onlyYes', 'Only yes bets so far');
        if (row.oneSided === 'no') return t('bets.row.onlyNo', 'Only no bets so far');
        if (row.chanceYes === null || row.chanceYes === undefined) return t('bets.row.noBets', 'No bets yet');
        return t('bets.row.chance', '{{percent}} chance', { percent: percentText(row.chanceYes) });
    }

    function renderRow(row) {
        const li = el('li', `bets-row is-${row.state}`);
        li.dataset.proposalId = row.proposalId;
        if (row.proposalAccount) li.dataset.proposalAccount = row.proposalAccount;

        // The title is the way into the bet's own dialog; an unminted proposal has no bet, so its
        // title opens the proposal itself.
        const head = el('div', 'bets-row__head');
        const title = el('button', 'btn btn-quiet bets-row__title', row.title || t('bets.row.untitled', 'Untitled proposal'));
        title.type = 'button';
        title.addEventListener('click', () => (row.proposalAccount ? openBet(row) : openProposal(row)));
        head.append(title, el('span', 'bets-row__chance', chanceLabel(row)));
        li.append(head);

        if (row.state === 'open' && row.chanceYes !== null && row.chanceYes !== undefined && !row.oneSided) {
            const bar = el('div', 'bets-row__bar');
            const fill = el('span');
            fill.style.width = `${Math.max(0, Math.min(100, row.chanceYes))}%`;
            bar.append(fill);
            li.append(bar);
        }

        // Who proposed it and when: the line that tells twins of one title apart.
        const who = [root.BetsModel.authorLabel(row.author), row.createdAt ? dateText(row.createdAt, true) : null].filter(Boolean).join(' · ');
        if (who) li.append(el('p', 'bets-row__who', who));

        const meta = el('div', 'bets-row__meta');
        if (row.kind === 'plan') meta.append(el('span', 'bets-row__plan', t('bets.row.plan', 'Plan of {{count}} proposals', { count: row.memberCount })));
        if (row.pool !== null && row.pool !== undefined) meta.append(el('span', null, t('bets.row.pool', 'Pool {{amount}}', { amount: moneyText(row.pool) })));
        if (row.closesAt) meta.append(el('span', null, t('bets.row.closes', 'Closes {{date}}', { date: dateText(row.closesAt) })));
        if (row.agent) meta.append(el('span', null, t('panel.proposal.agent.badge', 'Agent proposal')));
        if (row.proposalAccount) {
            // Every bet has a link worth passing on, whatever state its pool is in.
            const share = el('button', 'btn btn-quiet bets-row__link', t('bets.copyLink', 'Copy link'));
            share.type = 'button';
            share.addEventListener('click', () => copyLink(row.proposalAccount));
            meta.append(share);
        }
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

    // How many entries a contest holds, plans and loose proposals counted apart ("2 plans · 1 proposal").
    function entriesText(contest) {
        const plans = contest.planCount || 0;
        const proposals = contest.proposalCount - plans;
        return [
            plans ? t('bets.contest.planCount', '{{count}} plans', { count: plans }) : null,
            proposals || !plans ? t('agentDialog.proposalCount', '{{count}} proposals', { count: proposals }) : null
        ].filter(Boolean);
    }

    // A contest under the current filter: the rows with a pool, and the rest folded under a count.
    // Null when the filter leaves nothing of it.
    function renderContest(contest) {
        const model = root.BetsModel;
        const rows = model.filterRows(contest.rows, state.filter, state.positions);
        const { shown, hidden } = model.splitRows(rows);
        if (!shown.length && !hidden.length) return null;
        const article = el('article', 'bets-contest');
        article.dataset.contestId = contest.id;
        const head = el('header', 'bets-contest__head');
        // Plans are what a contest is about when it has them; the loose proposals are the also-rans.
        const plans = contest.planCount > 0;
        head.append(el('h3', 'bets-contest__title', contest.proposalCount > 1
            ? (plans ? t('bets.contest.titlePlans', 'Which plan gets built?') : t('bets.contest.title', 'Which proposal gets built?'))
            : (plans ? t('bets.contest.titleSinglePlan', 'Does this plan get built?') : t('bets.contest.titleSingle', 'Does this proposal get built?'))));
        const land = el('p', 'bets-contest__land');
        land.title = contest.parcelIds.join(', ');
        land.textContent = [
            landText(contest),
            ...entriesText(contest),
            t('bets.row.pool', 'Pool {{amount}}', { amount: moneyText(contest.pool) })
        ].join(' · ');
        head.append(land);
        article.append(head);
        if (shown.length) {
            const list = el('ul', 'bets-rows');
            shown.forEach(row => list.append(renderRow(row)));
            article.append(list);
        }
        if (hidden.length) {
            const more = el('details', 'bets-more');
            more.append(el('summary', null, t('bets.contest.withoutPool', 'Without a pool: {{count}}', { count: hidden.length })));
            const list = el('ul', 'bets-rows');
            hidden.forEach(row => list.append(renderRow(row)));
            more.append(list);
            article.append(more);
        }
        return article;
    }

    const FILTER_LABELS = {
        all: ['bets.filter.all', 'All'],
        open: ['bets.filter.open', 'Open'],
        settled: ['panel.proposal.market.historySettled', 'Settled'],
        mine: ['bets.filter.mine', 'Mine']
    };

    // The filter row sits above the contests, drawn once; its pressed button follows the state.
    function renderFilter(container) {
        let bar = doc.getElementById(FILTER_ID);
        if (!bar) {
            bar = el('div', 'bets-filter');
            bar.id = FILTER_ID;
            bar.setAttribute('role', 'group');
            bar.setAttribute('aria-label', t('modal.buildingLayers.show', 'Show'));
            (root.BetsModel ? root.BetsModel.FILTERS : Object.keys(FILTER_LABELS)).forEach(filter => {
                const [key, fallback] = FILTER_LABELS[filter];
                const button = el('button', 'btn btn-quiet bets-filter__btn', t(key, fallback));
                button.type = 'button';
                button.dataset.filter = filter;
                button.addEventListener('click', () => {
                    state.filter = filter;
                    if (state.payload) render(container, state.payload);
                });
                bar.append(button);
            });
            container.before(bar);
        }
        bar.querySelectorAll('.bets-filter__btn').forEach(button => button.setAttribute('aria-pressed', button.dataset.filter === state.filter ? 'true' : 'false'));
    }

    function render(container, payload) {
        if (!container || !root.BetsModel) return;
        const ordered = root.BetsModel.orderContests(contests(payload));
        renderFilter(container);
        container.replaceChildren();
        if (!ordered.length) {
            renderStatus(container, t('bets.empty', 'No pools in this city yet. Mint a proposal to open the first one.'));
            return;
        }
        const articles = ordered.map(renderContest).filter(Boolean);
        if (!articles.length) {
            renderStatus(container, state.filter === 'mine' && !walletConnected()
                ? t('panel.proposal.market.connectPosition', 'Connect a Solana wallet to see your bets.')
                : t('bets.filter.empty', 'No bets match this filter.'));
            return;
        }
        articles.forEach(article => container.append(article));
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
                state.positionsLoading = loadPositions(payload).finally(() => { state.positionsLoading = null; });
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

    // The payload for the current city, from cache when it is fresh; what the bet dialog reads from.
    function ensureLoaded() {
        const city = cityCode();
        if (state.payload && state.city === city && Date.now() - state.loadedAt < FRESH_MS) return Promise.resolve(state.payload);
        return load();
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

    // Open the sheet; with a proposal account, on that row (marked and brought into view once the
    // contests render, the same way a row a transaction just changed is); with a contest id, at
    // that contest (the dialog's way back to the rivals).
    root.openBetsSheet = function openBetsSheet(options = {}) {
        const proposalAccount = options && options.proposalAccount ? String(options.proposalAccount) : null;
        if (proposalAccount) state.changed = proposalAccount;
        if (options && options.contestId) state.scrollTo = String(options.contestId);
        if (root.MapShell && typeof root.MapShell.openSheet === 'function') root.MapShell.openSheet(SHEET_ID);
        if (state.payload && (proposalAccount || state.scrollTo)) markChanged(doc.getElementById(CONTENT_ID));
    };

    // A shared bet link (/bets/<account>?city=… or ?bets=<account>): the bet's own dialog opens
    // once the app has booted. The link is left in the address bar, like ?focusProposal=, so a
    // reload lands on the same bet.
    async function openFromUrl() {
        const link = root.BetsLink && typeof root.BetsLink.parse === 'function' ? root.BetsLink.parse(root.location) : null;
        if (!link) return;
        try {
            if (typeof root.whenAppBooted === 'function') await root.whenAppBooted();
            if (typeof root.openBetDialog === 'function') root.openBetDialog({ proposalAccount: link.proposalAccount });
            else root.openBetsSheet({ proposalAccount: link.proposalAccount });
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [bets] the bet link could not open`, error);
        }
    }
    if (doc.readyState === 'complete') openFromUrl();
    else root.addEventListener('load', openFromUrl, { once: true });

    root.BetsSheet = { load, ensureLoaded, render, rowFor, positionsFor, whenPositions, landText, entriesText, openProposal, linkFor, copyLink, SHEET_ID };
})(typeof window !== 'undefined' ? window : null);
