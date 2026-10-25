// The Bets sheet: the city's contests (published agreements over the same land) with each minted
// agreement's yes/no pool, from GET /markets. A thin DOM layer over js/bets/bets-model.js: it fetches
// when the sheet opens, renders the filter and the rows, and hands a bet to the bet's own dialog
// (js/bets/bets-dialog.js) and a pool opening, settlement or collection to the market bridge
// (js/solana/market-bridge.js). The dialog reads its row from here (rowFor, positionsFor), and the
// agreement panel's Bet action goes through window.AgreementBets, defined at the end.
(function (root) {
    'use strict';
    if (!root || !root.document) return;

    const doc = root.document;
    const SHEET_ID = 'bets-sheet';
    const CONTENT_ID = 'bets-sheet-content';
    const FILTER_ID = 'bets-sheet-filter';
    const SEEN_KEY = 'cb.bets.seen';           // per-viewer: the "New" word goes once the sheet was opened
    const FRESH_MS = 20_000;                    // matches the backend's per-city cache
    // positions: the connected wallet's bets per agreement account (solana/market-bridge.js
    // readPositions); changed: the account a confirmed transaction just touched, marked on its row
    // after the next render; scrollTo: the contest a dialog sent the person back to;
    // filter: all | open | settled | mine (js/bets/bets-model.js filterRows).
    const state = { city: null, loadedAt: 0, payload: null, loading: null, positions: {}, changed: null, scrollTo: null, filter: 'all', discoveryPending: false, positionTracked: new Set() };

    function trackBet(name, row = null, properties = {}) {
        try {
            root.BetsTelemetry?.track?.(name, {
                ...(row?.account ? { agreementAccount: row.account } : {}),
                ...(row?.cid ? { agreementCid: row.cid } : {}),
                asset: 'devnet-usdc', entryPoint: 'sheet', ...properties
            });
        } catch (_) { console.warn(`[${new Date().toISOString()}] [bets] Journey event could not be captured`); }
    }

    function actionForBridge(method) {
        return method === 'createMarket' ? 'create' : method === 'claim' ? 'claim' : 'resolve';
    }

    function finishDiscovery(result) {
        if (!state.discoveryPending) return;
        state.discoveryPending = false;
        trackBet('discovery', null, { result, entryPoint: 'sheet' });
    }

    function errorCodeOf(error) {
        const code = typeof error?.code === 'string' ? error.code.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 80) : '';
        return code || 'unknown';
    }

    const ACTION_STATUSES = new Set(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);

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
    const question = () => root.MarketQuestion || null;

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

    // What a row is called: its title, else its designs' titles (bets-model.js labelOf).
    function labelText(row) {
        return (row && row.label) || t('bets.row.untitledAgreement', 'Untitled agreement');
    }

    // The question one agreement's pool answers, in the page's language (js/bets/market-question.js).
    function agreementQuestionText(row) {
        const template = question() ? question().TEMPLATES['question.agreement'] : 'Will {{title}} execute on-chain?';
        return t('bets.question.agreement', template, { title: labelText(row) });
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

    // A confirmed pool transaction: the sheet re-reads past the server's cache and the dialog redraws.
    function announceChange(account) {
        try { doc.dispatchEvent(new root.CustomEvent('bets:changed', { detail: { account } })); } catch (_) { }
    }

    const sideWord = side => (side === 'yes' ? t('bets.row.yes', 'Yes') : t('bets.row.no', 'No')).toLowerCase();

    // "Your bets: yes 0.05 USDC" for a row, from the wallet's decoded positions; empty without any.
    function mineText(row) {
        const positions = state.positions[row.account];
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
    // winner does not have to open the bet to be paid.
    function renderCollect(li, row) {
        const existing = li.querySelector('.bets-row__collect');
        if (existing) existing.remove();
        if (!root.BetsModel || !row.account) return;
        const full = rowFor(row.account);
        const sides = full ? root.BetsModel.claimSides(full.row, state.positions[row.account]) : [];
        if (!sides.length) return;
        const collect = el('div', 'bets-row__collect');
        sides.forEach(side => {
            const button = el('button', 'btn btn-success btn-sm', t('panel.proposal.market.collect', 'Collect {{side}} winnings', { side: sideWord(side) }));
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
            .flatMap(contest => contest.agreements || [])
            .filter(entry => entry.account && entry.market)
            .map(entry => entry.account);
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
        container.querySelectorAll('.bets-row[data-account]').forEach(li => renderMine(li, { account: li.dataset.account }));
        container.querySelectorAll('.bets-row__mine').forEach(mine => {
            const account = mine.closest('.bets-row')?.dataset.account;
            if (!account || state.positionTracked.has(account)) return;
            state.positionTracked.add(account);
            trackBet('position_view', rowFor(account)?.row || { account }, { entryPoint: 'sheet' });
        });
    }

    // The shareable link to one row's bet (js/bets/bets-link.js): this origin, the current city and
    // the language the page was opened in.
    function linkFor(account) {
        const link = root.BetsLink;
        if (!link || !account) return null;
        const manager = root.CityConfigManager;
        const city = manager && typeof manager.getCurrentCityId === 'function' ? manager.getCurrentCityId() : null;
        let lang = null;
        try { lang = new URL(root.location.href).searchParams.get('lang'); } catch (_) { lang = null; }
        try { return link.build({ origin: root.location.origin, city, account, lang }); } catch (_) { return null; }
    }

    // Put the row's link on the clipboard; the shared helper shows "Copied".
    async function copyLink(account, options = {}) {
        const href = linkFor(account);
        if (!href) return false;
        const row = rowFor(account)?.row || { account };
        const entryPoint = options.entryPoint || 'sheet';
        const record = result => trackBet('share', row, { entryPoint, result });
        if (typeof root.copyTextWithFeedback === 'function') {
            try {
                const copied = await root.copyTextWithFeedback(href);
                record(copied ? 'succeeded' : 'failed');
                return copied;
            } catch (error) {
                record('failed');
                return false;
            }
        }
        try {
            await root.navigator.clipboard.writeText(href);
            record('succeeded');
            return true;
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [bets] link not copied`, error);
            record('failed');
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
        const li = container.querySelector(`.bets-row[data-account="${state.changed}"]`);
        state.changed = null;
        if (!li) return;
        // A row inside the fold of rows without a pool is opened up, or the mark would not be seen.
        const fold = li.closest('details');
        if (fold) fold.open = true;
        li.classList.add('is-updated');
        if (typeof li.scrollIntoView === 'function') { try { li.scrollIntoView({ block: 'nearest' }); } catch (_) { } }
    }

    // ---- the dialog's view of the payload ------------------------------------------------------

    function contests(payload = state.payload) {
        if (!payload || !root.BetsModel) return [];
        return (payload.contests || []).map(contest => root.BetsModel.contest(contest, { decimals: payload.stakeDecimals }));
    }

    // The contest and row of one agreement account in the loaded city, as the model shapes them.
    function rowFor(account) {
        if (!account) return null;
        for (const contest of contests()) {
            const row = contest.rows.find(item => item.account === account);
            if (row) return { contest, row };
        }
        return null;
    }

    // The same by the agreement's CID: how a local agreement finds its row.
    function rowForCid(cid) {
        if (!cid) return null;
        for (const contest of contests()) {
            const row = contest.rows.find(item => item.cid === cid);
            if (row) return { contest, row };
        }
        return null;
    }

    const positionsFor = account => (account && state.positions[account]) || null;
    // Settles once the positions read that a load started has finished (or at once when none is running).
    const whenPositions = () => Promise.resolve(state.positionsLoading || null);

    // ---- actions ----------------------------------------------------------------------------

    function placeBet(row, side) {
        if (!walletConnected()) {
            const context = { action: 'stake', side: side === 1 ? 'yes' : 'no', entryPoint: 'sheet' };
            trackBet('action_start', row, { ...context, result: 'started' });
            trackBet('action_end', row, { ...context, result: 'failed', errorCode: 'wallet_not_connected' });
            askForWallet(); return;
        }
        if (typeof root.openBetDialog === 'function') root.openBetDialog({ account: row.account, side, entryPoint: 'sheet' });
    }

    function openBet(row) {
        if (typeof root.openBetDialog === 'function') root.openBetDialog({ account: row.account, entryPoint: 'sheet' });
    }

    // Opening, settling or collecting from a pool is a single wallet transaction through the shared
    // bridge, whose `proposal` option is the market's subject account (here the agreement's); the row
    // shows the lifecycle words and the result, and the human action lands in the activity feed.
    async function marketTransaction(li, row, action, button, side = null) {
        const context = { entryPoint: 'sheet', action: actionForBridge(action), side: side === null ? null : side === 1 ? 'yes' : 'no' };
        let finished = false;
        const finish = (result, errorCode = null) => {
            if (finished) return;
            finished = true;
            trackBet('action_end', row, { ...context, result, ...(errorCode ? { errorCode } : {}) });
        };
        if (!walletConnected()) {
            trackBet('action_start', row, { ...context, result: 'started' });
            finish('failed', 'wallet_not_connected');
            askForWallet(); return;
        }
        const bridge = root.SolanaMarketBridge;
        const view = root.ProposalMarketView;
        if (!bridge || typeof bridge[action] !== 'function') {
            trackBet('action_start', row, { ...context, result: 'started' });
            finish('failed', 'action_unavailable');
            return;
        }
        trackBet('action_start', row, { ...context, result: 'started' });
        button.disabled = true;
        try {
            const result = await bridge[action]({
                proposal: row.account,
                ...(side === null ? {} : { side }),
                onStatus: item => {
                    setNote(li, view && typeof view.statusText === 'function' ? view.statusText(item) : '');
                    if (ACTION_STATUSES.has(item?.state)) trackBet('action_status', row, { ...context, result: item.state });
                }
            });
            finish(result?.replayed ? 'succeeded' : result?.transactionHash || result?.transactionHashes?.length ? 'confirmed' : 'unknown');
            const done = action === 'createMarket' ? t('bets.row.opened', 'Pool opened')
                : action === 'claim' ? t('panel.proposal.market.collectedMessage', 'Collected {{side}} winnings.', { side: sideWord(side === 1 ? 'yes' : 'no') })
                    : t('bets.row.settled', 'Pool settled');
            setNote(li, done);
            if (typeof root.recordHumanProposalSupport === 'function') {
                const wallet = root.solanaWalletManager.getState().accounts[0];
                await root.recordHumanProposalSupport({ wallet, action, proposalId: row.account, result, message: `${wallet.slice(0, 4)}…${wallet.slice(-4)}: ${done}` });
            }
            announceChange(row.account);
        } catch (error) {
            finish(root.BetsTelemetry?.errorResult(error) || 'failed', errorCodeOf(error));
            console.error(`[${new Date().toISOString()}] [bets] ${action} failed`, error);
            setNote(li, view && typeof view.errorText === 'function' ? view.errorText(error) : t('bets.error.transaction', 'The transaction failed.'), 'error');
        } finally {
            button.disabled = false;
        }
    }

    // Open the published agreement through the shared-link path, which refreshes its local copy,
    // applies its designs and reconstructs the land before opening the panel.
    async function openAgreement(row, options = {}) {
        trackBet('agreement_open', row, { entryPoint: options.entryPoint || 'sheet', result: 'started' });
        try {
            if (!row || !row.cid) throw new Error('the row names no agreement');
            if (root.MapShell && typeof root.MapShell.closeSheets === 'function') root.MapShell.closeSheets();
            await root.AgreementSync.handleAgreementRoute(row.cid);
            // The shared-link handler can catch a load error or cancel navigation. Observe the
            // requested panel before counting a completed review entrance.
            const openedId = root.AgreementPanel?.current?.();
            const opened = root.AgreementStore?.get?.(openedId);
            const visible = root.AgreementPanel?.isOpen?.()
                && (opened?.published?.cid === row.cid || openedId === `published-${row.cid}`);
            trackBet('agreement_open', row, { entryPoint: options.entryPoint || 'sheet', result: visible ? 'succeeded' : 'unknown' });
        } catch (error) {
            trackBet('agreement_open', row, { entryPoint: options.entryPoint || 'sheet', result: 'failed', errorCode: errorCodeOf(error) });
            console.error(`[${new Date().toISOString()}] [bets] open agreement failed`, error);
            if (typeof root.showEphemeralMessage === 'function') {
                root.showEphemeralMessage(t('bets.error.openAgreement', 'The agreement could not be opened.'), 6000, 'error');
            }
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

    // The bet pair (btn-yes / btn-no, css/primitives.css); btn-market-yes / -no stay as the hooks the
    // specs find them by.
    function betButton(row, side) {
        const yes = side === 1;
        const multiple = yes ? row.paysYes : row.paysNo;
        const button = el('button', yes ? 'btn btn-yes btn-market-yes' : 'btn btn-no btn-market-no');
        button.type = 'button';
        button.append(el('strong', 'bets-bet__side', yes ? t('bets.row.yes', 'Yes') : t('bets.row.no', 'No')));
        if (multiple !== null && multiple !== undefined) {
            button.append(el('span', 'bets-bet__pays', t('bets.row.pays', 'Pays {{multiple}}×', { multiple: multiple.toFixed(2) })));
        }
        const paysTitle = multiple !== null && multiple !== undefined
            ? ' ' + t('bets.row.paysTitle', '1 USDC on this side pays {{multiple}} USDC if it wins.', { multiple: multiple.toFixed(2) })
            : '';
        button.title = (yes
            ? t('bets.row.yesExecutes', 'Bet that the agreement executes on-chain.')
            : t('bets.row.noExecutes', 'Bet that the agreement is cancelled or expires on-chain.')) + paysTitle;
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
        return t('bets.row.yesPoolShare', 'Yes: {{percent}} of pool', { percent: percentText(row.chanceYes) });
    }

    function renderRow(row) {
        const li = el('li', `bets-row is-${row.state}`);
        li.dataset.cid = row.cid || '';
        if (row.account) li.dataset.account = row.account;

        // The title is the way into the bet's own dialog; an unminted agreement has no bet, so its
        // title opens the agreement itself.
        const head = el('div', 'bets-row__head');
        const title = el('button', 'btn btn-quiet bets-row__title', labelText(row));
        title.type = 'button';
        title.addEventListener('click', () => (row.account ? openBet(row) : openAgreement(row)));
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
        if (row.pool !== null && row.pool !== undefined) meta.append(el('span', null, t('bets.row.pool', 'Pool {{amount}}', { amount: moneyText(row.pool) })));
        // The agreement's own deadline: after it, it can no longer execute.
        if (row.deadline) meta.append(el('span', null, t('bets.row.deadline', 'Deadline {{date}}', { date: dateText(row.deadline) })));
        if (row.account) {
            // Every bet has a link worth passing on, whatever state its pool is in: a quiet script
            // link in the meta line.
            const share = el('button', 'cb-link cb-link--quiet bets-row__link', t('bets.copyLink', 'Copy link'));
            share.type = 'button';
            share.addEventListener('click', () => copyLink(row.account, { entryPoint: 'sheet' }));
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
            li.append(el('p', 'bets-row__note', t('bets.row.closed', 'Not open for bets')));
        }
        if (actions.childElementCount) li.append(actions);
        return li;
    }

    // Where the contest's land is: the first input parcel and how many more, or open ground.
    function landText(contest) {
        if (!contest.land.first) return t('bets.contest.openGround', 'Open ground');
        const parcel = parcelText(contest.land.first);
        return contest.land.more
            ? t('bets.contest.landMore', 'Parcel {{parcel}} and {{count}} more', { parcel, count: contest.land.more })
            : t('bets.contest.land', 'Parcel {{parcel}}', { parcel });
    }

    // How many agreements a contest holds ("3 agreements"); the key is a one/other plural object, and the
    // English fallback picks its form the same way until the translations carry it.
    function entriesText(contest) {
        const count = contest.agreementCount;
        return [t('bets.contest.agreementCount', count === 1 ? '{{count}} agreement' : '{{count}} agreements', { count })];
    }

    // The question a contest answers: one agreement's pool, or which of several over the same land
    // executes (js/bets/market-question.js).
    function contestQuestionText(contest) {
        if (contest.agreementCount === 1 && contest.rows.length) return agreementQuestionText(contest.rows[0]);
        const template = question() ? question().TEMPLATES['question.contest'] : 'Which agreement over {{place}} will execute?';
        return t('bets.question.contest', template, { place: landText(contest) });
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
        head.append(el('h3', 'bets-contest__title', contestQuestionText(contest)));
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

    // The filter row sits above the contests, drawn once: a cb-segmented group whose pressed
    // option follows the state (bets-filter__btn stays as the hook the specs find it by).
    function renderFilter(container) {
        let bar = doc.getElementById(FILTER_ID);
        if (!bar) {
            bar = el('div', 'cb-segmented bets-filter');
            bar.id = FILTER_ID;
            bar.setAttribute('role', 'group');
            bar.setAttribute('aria-label', t('modal.buildingLayers.show', 'Show'));
            (root.BetsModel ? root.BetsModel.FILTERS : Object.keys(FILTER_LABELS)).forEach(filter => {
                const [key, fallback] = FILTER_LABELS[filter];
                const button = el('button', 'cb-segmented__option bets-filter__btn', t(key, fallback));
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
            renderStatus(container, t('bets.emptyAgreements', 'No pools in this city yet. Mint an agreement to open the first one.'));
            finishDiscovery('succeeded');
            return;
        }
        const articles = ordered.map(renderContest).filter(Boolean);
        if (!articles.length) {
            renderStatus(container, state.filter === 'mine' && !walletConnected()
                ? t('panel.proposal.market.connectPosition', 'Connect a Solana wallet to see your bets.')
                : t('bets.filter.empty', 'No bets match this filter.'));
            finishDiscovery('succeeded');
            return;
        }
        articles.forEach(article => container.append(article));
        markChanged(container);
        finishDiscovery('succeeded');
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
        state.attemptedAt = Date.now();
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
                finishDiscovery('failed');
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
            state.discoveryPending = true;
            state.positionTracked = new Set();
            trackBet('entry', null, { entryPoint: 'sheet' });
            if (pill && !pill.hidden) {
                pill.hidden = true;
                try { root.localStorage.setItem(SEEN_KEY, '1'); } catch (_) { }
            }
            load();
        });
        const isOpen = () => !!(root.MapShell && typeof root.MapShell.isOpen === 'function' && root.MapShell.isOpen(SHEET_ID));
        // A confirmed pool transaction: re-read past the server's short cache, so the pool that was
        // just opened or bet on shows up at once.
        doc.addEventListener('bets:changed', event => {
            state.loadedAt = 0;
            state.fresh = true;
            state.changed = event.detail && event.detail.account ? event.detail.account : null;
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

    // Open the sheet; with an agreement account, on that row (marked and brought into view once the
    // contests render, the same way a row a transaction just changed is); with a contest id, at
    // that contest (the dialog's way back to the rivals).
    root.openBetsSheet = function openBetsSheet(options = {}) {
        const account = options && options.account ? String(options.account) : null;
        if (account) state.changed = account;
        if (options && options.contestId) state.scrollTo = String(options.contestId);
        if (root.MapShell && typeof root.MapShell.openSheet === 'function') root.MapShell.openSheet(SHEET_ID);
        if (state.payload && (account || state.scrollTo)) markChanged(doc.getElementById(CONTENT_ID));
    };

    // A shared bet link (/bets/<account>?city=… or ?bets=<account>): the bet's own dialog opens
    // once the app has booted. The link is left in the address bar, like ?focusProposal=, so a
    // reload lands on the same bet.
    // Capture it now: a user can open a stake form before the last image finishes loading, and
    // that action also writes /bets/<account>. A delayed load must not reopen it as an overview.
    const initialBetLink = root.BetsLink && typeof root.BetsLink.parse === 'function' ? root.BetsLink.parse(root.location) : null;
    async function openFromUrl() {
        const link = initialBetLink;
        if (!link) return;
        try {
            if (typeof root.whenAppBooted === 'function') await root.whenAppBooted();
            if (typeof root.openBetDialog === 'function') {
                trackBet('entry', { account: link.account }, { entryPoint: 'deep-link' });
                root.openBetDialog({ account: link.account, entryPoint: 'deep-link', ...(link.approval ? { side: link.approval.params.side, amount: link.approval.params.amount, approval: true } : {}) });
            }
            else root.openBetsSheet({ account: link.account });
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [bets] the bet link could not open`, error);
        }
    }
    if (doc.readyState === 'complete') openFromUrl();
    else root.addEventListener('load', openFromUrl, { once: true });

    root.BetsSheet = {
        load, ensureLoaded, render, rowFor, rowForCid, positionsFor, whenPositions, landText, entriesText, labelText,
        agreementQuestionText, openAgreement, linkFor, copyLink, SHEET_ID
    };

    // ---- the agreement panel's Bet action ---------------------------------------------------

    // The chain account of a local agreement (js/agreement-record.js): the mint's pointer it keeps,
    // else the city's markets list by its CID (an agreement minted elsewhere and opened from a link).
    function agreementAccount(agreement) {
        const onchain = agreement && agreement.onchain;
        if (onchain && onchain.chain === 'solana' && onchain.cluster === 'devnet' && typeof onchain.account === 'string') return onchain.account;
        const found = agreement && agreement.published ? rowForCid(agreement.published.cid) : null;
        return found ? found.row.account : null;
    }

    /**
     * Whether an agreement's Bet action applies: it is minted, and its pool exists or can be opened.
     * Synchronous, for the panel's render: without the city's markets list (read here in the
     * background the first time) a minted agreement counts, since its bet's dialog reads the pool
     * from the chain; with it, an agreement decided before anyone opened a pool does not.
     */
    function available(agreement) {
        const city = cityCode();
        const missing = !state.payload || state.city !== city;
        // One background read at a time, and a failed one is not retried on every render.
        if (missing && !state.loading && Date.now() - (state.attemptedAt || 0) > FRESH_MS) load();
        const account = agreementAccount(agreement);
        if (!account) return false;
        const found = rowFor(account);
        return !found || found.row.state !== 'closed' || Boolean(found.row.marketAddress);
    }

    // Opens the bet's dialog of a local agreement (by its local id) on its chain account.
    async function openAgreementBet(agreementId) {
        const store = root.AgreementStore;
        const agreement = store && typeof store.get === 'function' ? store.get(agreementId) : null;
        if (!agreement) return null;
        let account = agreementAccount(agreement);
        if (!account && agreement.published) {
            await ensureLoaded();
            account = agreementAccount(agreement);
        }
        if (!account) {
            if (typeof root.showEphemeralMessage === 'function') root.showEphemeralMessage(t('bets.row.notMinted', 'Not minted yet, so no pool'), 6000, 'info');
            return null;
        }
        // Named as its row would be (bets-model.js labelOf) while the dialog reads the row.
        const title = root.BetsModel ? root.BetsModel.labelOf({ title: agreement.title, designTitles: (agreement.designs || []).map(design => design.title) }) : agreement.title;
        return typeof root.openBetDialog === 'function' ? root.openBetDialog({ account, title: title || '', entryPoint: 'agreement' }) : null;
    }

    root.AgreementBets = { available, open: openAgreementBet };
})(typeof window !== 'undefined' ? window : null);
