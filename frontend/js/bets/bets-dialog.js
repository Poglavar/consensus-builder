// One agreement's bet: the dialog a bet link opens, a Bets row opens, and the agreement panel's Bet
// action opens (window.AgreementBets in js/bets/bets-sheet.js). Three states in one cb-dialog: the
// overview (the question, share price, deadline, rule, positions and links), the trade form
// (amount, quick stakes, a live "to win") and the receipt after a confirmed bet. The numbers come
// from js/bets/bets-model.js, the row from the Bets sheet (js/bets/bets-sheet.js), the chain reads
// and transactions from js/solana/market-bridge.js, whose `proposal` option is the market's subject
// account: here the agreement's. The overlay keeps the id the stake dialog always had, so the sheet
// and the specs find it where it was.
(function (root) {
    'use strict';
    if (!root || !root.document) return;

    const doc = root.document;
    const OVERLAY_ID = 'proposalMarketOverlay';
    const EXPLORER = 'https://explorer.solana.com';
    const state = { overlay: null, account: null, row: null, contest: null, positions: null, opener: null, unregisterEscape: null, compare: null, entryPoint: 'dialog', positionTrackedAccount: null, quotedAmount: null };
    const inFlight = new Set();
    const ACTION_STATUSES = new Set(['preparing', 'awaiting_signature', 'submitted', 'confirmed']);

    function trackBet(name, row = state.row, properties = {}) {
        try {
            root.BetsTelemetry?.track?.(name, {
                ...(row?.account ? { agreementAccount: row.account } : {}),
                ...(row?.cid ? { agreementCid: row.cid } : {}),
                asset: row?.asset || root.BetsTrading?.asset() || 'points', entryPoint: state.entryPoint || 'dialog', ...properties
            });
        } catch (_) { console.warn(`[${new Date().toISOString()}] [bets] Journey event could not be captured`); }
    }

    function actionFor(method) { return method === 'createMarket' ? 'create' : method; }

    function errorCodeOf(error) {
        const code = typeof error?.code === 'string' ? error.code.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 80) : '';
        return code || 'unknown';
    }

    function actionAttempt(name, row, properties, errorCode) {
        const common = { ...properties, action: name };
        trackBet('action_start', row, { ...common, result: 'started' });
        trackBet('action_end', row, { ...common, result: 'failed', errorCode });
    }

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

    function el(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function button(className, text, onClick) {
        const node = el('button', className, text);
        node.type = 'button';
        if (onClick) node.addEventListener('click', onClick);
        return node;
    }

    const format = () => root.CbFormat || null;
    const model = () => root.BetsModel || null;
    const view = () => root.BetsUI || null;
    const bridge = () => root.BetsTrading || null;
    const sheet = () => root.BetsSheet || null;
    const backendBase = () => (typeof root.getBackendBase === 'function' ? root.getBackendBase().replace(/\/$/, '') : 'https://api.urbangametheory.xyz');

    function money(amountText) {
        return root.BetsUI.money(amountText, state.row?.asset || bridge().asset());
    }
    const moneyAtomic = atomic => money(model().formatAtomic(atomic));

    function percentText(value) {
        const f = format();
        return f && typeof f.formatPercent === 'function' ? f.formatPercent(value, { ofHundred: true, maxFractionDigits: 1 }) : `${value}%`;
    }

    function dateText(value, withTime) {
        const f = format();
        const fn = withTime ? 'formatDateTime' : 'formatDate';
        if (f && typeof f[fn] === 'function') return f[fn](value);
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : (withTime ? date.toLocaleString() : date.toLocaleDateString());
    }

    const sideValue = side => (side === 'yes' || Number(side) === 1 ? 1 : 0);
    const sideName = side => (sideValue(side) === 1 ? 'yes' : 'no');
    const sideWord = side => (sideValue(side) === 1 ? t('bets.row.yes', 'Yes') : t('bets.row.no', 'No')).toLowerCase();

    function walletConnected() {
        const walletState = root.solanaWalletManager && typeof root.solanaWalletManager.getState === 'function' ? root.solanaWalletManager.getState() : null;
        return !!(walletState && walletState.status === 'connected' && Array.isArray(walletState.accounts) && walletState.accounts.length);
    }
    const walletAddress = () => (walletConnected() ? root.solanaWalletManager.getState().accounts[0] : null);

    function askForWallet() {
        if (typeof root.handleWalletButtonClick === 'function') root.handleWalletButtonClick();
    }

    // A confirmed transaction: the Bets sheet re-reads its market and positions.
    function announceChange(account) {
        try { doc.dispatchEvent(new root.CustomEvent('bets:changed', { detail: { account } })); } catch (_) { }
    }

    async function recordSupport(entry) {
        if (typeof root.recordHumanProposalSupport !== 'function') return;
        try { await root.recordHumanProposalSupport(entry); } catch (error) { console.warn(`[${new Date().toISOString()}] [bets] activity not recorded`, error); }
    }

    function actorName(wallet) {
        return wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : 'Wallet user';
    }

    // The row's name and dated agreement question, shared with the sheet.
    function labelOf(row) {
        const bets = sheet();
        return bets && typeof bets.labelText === 'function' ? bets.labelText(row) : (row.label || t('bets.row.untitledAgreement', 'Untitled agreement'));
    }
    function questionOf(row) {
        const bets = sheet();
        return bets && typeof bets.agreementQuestionText === 'function'
            ? bets.agreementQuestionText(row)
            : t('bets.question.agreement', 'Will {{title}} execute on-chain?', { title: labelOf(row) });
    }

    // ---- data ---------------------------------------------------------------------------------

    // The row from the Bets sheet's city payload; without one (an agreement the city list does not
    // carry yet, such as one just minted), the market and the account's status and deadline straight
    // from the chain, judged by GET /markets' rule (BetsModel.chainEntry).
    async function loadRow(account, options) {
        const bets = sheet();
        let found = null;
        if (bets && typeof bets.ensureLoaded === 'function') {
            try { await bets.ensureLoaded(); } catch (_) { found = null; }
            found = typeof bets.rowFor === 'function' ? bets.rowFor(account) : null;
        }
        if (found) return found;
        const fallback = { contest: null, row: {
            kind: 'agreement', cid: null, account, contest: null, title: options.title || '', label: options.title || '', designTitles: [],
            author: null, createdAt: null, deadline: null, status: null, chainStatus: null, screenshotUrl: null, screenshotBeforeUrl: null,
            parcelIds: [], state: 'closed', chanceYes: null, chanceNo: null, market: null, asset: bridge().asset(),
            sharesAtomic: 0n, liquidity: null, outcome: null, paysYes: null, paysNo: null, marketAddress: null, fromChain: true
        } };
        const chain = bridge();
        if (!chain || typeof chain.readSummary !== 'function' || !model()) return fallback;
        try {
            const summary = await chain.readSummary(account);
            if (summary) {
                const entry = model().chainEntry(account, summary);
                fallback.row = { ...fallback.row, ...model().row({ ...entry, title: fallback.row.title }), fromChain: true };
            }
            if (summary) state.positions = { yes: summary.yes || null, no: summary.no || null };
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [bets] pool unreadable for ${account}`, error);
        }
        return fallback;
    }

    async function loadPositions(account) {
        const bets = sheet();
        if (bets && typeof bets.whenPositions === 'function') { try { await bets.whenPositions(); } catch (_) { /* read below */ } }
        const known = bets && typeof bets.positionsFor === 'function' ? bets.positionsFor(account) : null;
        if (known) return known;
        const chain = bridge();
        if ((bridge().needsWallet() && !walletConnected()) || !chain || typeof chain.readPositions !== 'function') return null;
        try {
            const all = await chain.readPositions([{ account, sponsor: state.row?.sponsor, marketAddress: state.row?.marketAddress }]);
            return all && all[account] ? all[account] : null;
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [bets] positions unreadable`, error);
            return null;
        }
    }

    function absoluteImage(url) {
        const value = typeof url === 'string' ? url.trim() : '';
        if (!value) return null;
        if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value;
        return value.startsWith('/') ? `${backendBase()}${value}` : null;
    }

    function linkFor(account) {
        const bets = sheet();
        return bets && typeof bets.linkFor === 'function' ? bets.linkFor(account) : null;
    }

    // ---- frame --------------------------------------------------------------------------------

    function parts() {
        const overlay = state.overlay;
        return overlay ? {
            overlay, dialog: overlay.querySelector('.bets-dialog'), title: overlay.querySelector('.cb-dialog__title'),
            body: overlay.querySelector('.cb-dialog__body'), footer: overlay.querySelector('.cb-dialog__footer')
        } : null;
    }

    // While a bet is open its own link stands in the address bar (/bets/<account>?city=…), so a
    // link copied from there unfurls with the bet's card like "Copy link" does; the other query
    // parameters stay. Closing puts the plain app address back.
    function showBetAddress(account) {
        try {
            const url = new URL(root.location.href);
            url.pathname = `/bets/${account}`;
            url.searchParams.delete('bets');
            const manager = root.CityConfigManager;
            const city = manager && typeof manager.getCurrentCityId === 'function' ? manager.getCurrentCityId() : null;
            if (city && !url.searchParams.get('city')) url.searchParams.set('city', city);
            root.history.replaceState(root.history.state, '', url.toString());
        } catch (_) { /* a sandboxed or file: page keeps its address */ }
    }

    function showAppAddress() {
        try {
            const url = new URL(root.location.href);
            if (!/^\/bets\/./.test(url.pathname) && !url.searchParams.has('bets')) return;
            url.pathname = '/';
            url.searchParams.delete('bets');
            root.history.replaceState(root.history.state, '', url.toString());
        } catch (_) { /* as above */ }
    }

    // The thumbnail divider (dividers.md, M3) lives in the overview body only.
    function disposeCompare() {
        if (!state.compare) return;
        try { state.compare.dispose(); } catch (_) { /* already detached with the body */ }
        state.compare = null;
    }

    function close() {
        disposeCompare();
        const overlay = state.overlay;
        if (!overlay) return;
        const dialogState = overlay.querySelector('.bets-dialog')?.dataset.state;
        trackBet('close', state.row || { account: state.account }, {
            entryPoint: dialogState === 'stake' ? 'stake' : state.entryPoint,
            ...(dialogState === 'stake' ? { action: state.tradeAction || 'buy' } : {})
        });
        if (typeof state.unregisterEscape === 'function') state.unregisterEscape();
        overlay.remove();
        showAppAddress();
        const opener = state.opener;
        state.overlay = null; state.row = null; state.contest = null; state.positions = null; state.opener = null; state.unregisterEscape = null; state.positionTrackedAccount = null;
        // Focus goes back where the dialog came from (a Bets row, the agreement panel); the sheet or
        // panel behind stayed open the whole time, so the person lands on the pool, not the bare map.
        const target = opener && opener.isConnected ? opener : doc.querySelector('.map-sheet:not([hidden])');
        if (target && typeof target.focus === 'function') { try { target.focus({ preventScroll: true }); } catch (_) { } }
    }

    function mount(title) {
        const existing = doc.getElementById(OVERLAY_ID);
        if (existing) { if (state.overlay === existing) close(); else existing.remove(); }
        state.opener = doc.activeElement;
        const overlay = el('div', 'cb-dialog-overlay bets-dialog-overlay');
        overlay.id = OVERLAY_ID;
        const dialog = el('div', 'cb-dialog bets-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'bets-dialog-title');
        dialog.tabIndex = -1;
        const header = el('div', 'cb-dialog__header');
        const heading = el('h2', 'cb-dialog__title', title);
        heading.id = 'bets-dialog-title';
        const closeButton = button('close-circle-btn', '×', close);
        closeButton.setAttribute('aria-label', t('common.close', 'Close'));
        header.append(heading, closeButton);
        dialog.append(header, el('div', 'cb-dialog__body bets-dialog__body'), el('div', 'cb-dialog__footer bets-dialog__footer'));
        overlay.append(dialog);
        overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
        doc.body.appendChild(overlay);
        state.overlay = overlay;
        state.unregisterEscape = root.ModalEscape && typeof root.ModalEscape.register === 'function' ? root.ModalEscape.register(overlay, close) : null;
        return overlay;
    }

    function setStatus(text, url) {
        const p = parts();
        const node = p && p.body.querySelector('[data-market-dialog-status]');
        if (!node) return;
        node.textContent = text || '';
        if (url) {
            const link = el('a', 'cb-link cb-link--external', t('panel.proposal.market.explorerTx', 'View on the block explorer'));
            link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            node.append(' ', link);
        }
    }

    // ---- overview -----------------------------------------------------------------------------

    function chanceLabel(row) {
        if (row.state === 'resolved-yes') return t('bets.row.resolvedYes', 'Settled yes');
        if (row.state === 'resolved-no') return t('bets.row.resolvedNo', 'Settled no');
        if (row.state === 'not-minted') return t('bets.row.notMinted', 'Agreement not minted yet');
        if (row.state === 'needs-market') return t('panel.proposal.market.state.needsPool', 'No USDC market yet');
        if (row.state === 'closed' && !row.marketAddress) return t('bets.row.closed', 'Not open for bets');
        if (row.state === 'resolved-void') return t('bets.trade.void', 'Voided · half paid per share');
        if (row.chanceYes === null || row.chanceYes === undefined) return t('bets.row.noBets', 'No bets yet');
        return root.BetsUI.price(row);
    }

    function landLine(row, contest) {
        const bets = sheet();
        if (contest && bets && typeof bets.landText === 'function') return bets.landText(contest);
        const ids = row.parcelIds || [];
        if (!ids.length) return '';
        const label = model() ? model().parcelLabel(ids[0]) : String(ids[0]);
        return ids.length > 1
            ? t('bets.contest.landMore', 'Parcel {{parcel}} and {{count}} more', { parcel: label, count: ids.length - 1 })
            : t('bets.contest.land', 'Parcel {{parcel}}', { parcel: label });
    }

    // The pool's lifecycle words (js/proposals/market-view.js lifecycle), from the account's status;
    // a row the model closed (its deadline passed while the account is still Active) reads as closed.
    function lifecycleWords(row) {
        if (!row.closesAt) return { state: chanceLabel(row), next: '', rule: t('bets.trade.needsDeadline', 'A dated agreement market is needed before betting opens.') };
        return {
            state: chanceLabel(row),
            next: t('bets.trade.sharePayout', 'Each winning share pays 1. You can sell before trading closes.'),
            rule: t('bets.trade.rule', 'YES if this agreement executes on-chain by {{deadline}}. NO if it expires or misses that deadline. Cancellation voids the bet and pays 0.5 per share. Execution does not mean construction.', { deadline: root.BetsUI.deadline(row.closesAt) })
        };
    }

    function mineLines(row, positions) {
        if (!positions || !model()) return [];
        return ['yes', 'no']
            .filter(side => positions[side] && model().formatAtomic(positions[side].amount) !== '0')
            .map(side => t('panel.proposal.market.betLine', '{{side}} {{amount}}', { side: sideWord(side), amount: root.BetsUI.shares(model().formatAtomic(positions[side].amount)) })
                + (positions[side].claimed ? ` (${t('panel.proposal.market.paidOut', 'paid out')})` : ''));
    }

    // A link to the block explorer: it leaves the app, so cb-link--external carries the one ↗.
    function explorerLink(text, address) {
        const link = el('a', 'cb-link cb-link--external', text);
        link.href = `${EXPLORER}/address/${encodeURIComponent(address)}?cluster=devnet`;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        return link;
    }

    function renderOverview() {
        const p = parts();
        const { row, contest, positions } = state;
        if (!p || !row) return;
        p.title.textContent = questionOf(row);
        disposeCompare();
        p.body.replaceChildren();
        p.footer.replaceChildren();
        p.dialog.dataset.state = 'overview';

        const eyebrow = el('p', 'bets-dialog__eyebrow');
        eyebrow.append(el('span', null, t('bets.tagline', 'Bet on cities')));
        const land = landLine(row, contest);
        if (land) eyebrow.append(el('span', null, ` · ${land}`));
        p.body.append(eyebrow, root.BetsUI.assetControl());

        // Rival agreements over the same land: back to the contest in the Bets sheet.
        if (contest && contest.agreementCount > 1) {
            const counted = sheet() && typeof sheet().entriesText === 'function'
                ? sheet().entriesText(contest).join(' · ')
                : t('bets.contest.agreementCount', contest.agreementCount === 1 ? '{{count}} agreement' : '{{count}} agreements', { count: contest.agreementCount });
            const rivals = button('cb-link bets-dialog__contest', t('bets.dialog.onThisLandCount', '{{entries}} on this land', { entries: counted }), () => {
                const id = contest.id;
                trackBet('return', row, { entryPoint: 'dialog' });
                close();
                if (typeof root.openBetsSheet === 'function') root.openBetsSheet({ contestId: id });
            });
            p.body.append(rivals);
        }

        const image = absoluteImage(row.screenshotUrl);
        const beforeImage = absoluteImage(row.screenshotBeforeUrl);
        if (image) {
            const img = el('img', 'bets-dialog__thumb');
            img.src = image; img.alt = ''; img.loading = 'lazy';
            // The input land without the agreement's designs under a divider (dividers.md, M3), once rendered.
            if (beforeImage && root.__MapBeforeAfter && typeof root.__MapBeforeAfter.attachDivider === 'function') {
                const compare = el('div', 'bets-dialog__compare');
                const before = el('img', 'bets-dialog__thumb map-compare__before');
                before.src = beforeImage; before.alt = ''; before.loading = 'lazy';
                compare.append(img, before);
                p.body.append(compare);
                state.compare = root.__MapBeforeAfter.attachDivider(compare, before, {
                    percent: 25,
                    labels: { before: t('mapCompare.before', 'Before'), after: t('mapCompare.after', 'After') },
                    sliderLabel: t('mapCompare.sliderLabel', 'Before and after comparison')
                });
                trackBet('comparison_view', row, { entryPoint: state.entryPoint });
            } else {
                p.body.append(img);
            }
        }

        const chance = el('div', `bets-dialog__chance is-${row.state}`);
        chance.append(el('strong', 'bets-dialog__chance-word', chanceLabel(row)));
        if (row.state === 'open' && row.chanceYes !== null && row.chanceYes !== undefined) {
            const bar = el('div', 'bets-row__bar');
            const fill = el('span');
            fill.style.width = `${Math.max(0, Math.min(100, row.chanceYes))}%`;
            bar.append(fill);
            chance.append(bar);
        }
        p.body.append(chance);

        const facts = el('dl', 'bets-dialog__facts');
        const fact = (label, value) => { if (!value) return; facts.append(el('dt', null, label), el('dd', null, value)); };
        if (row.liquidity !== null) fact(t('bets.trade.liquidity', 'Liquidity setting'), money(row.liquidity));
        if (row.state === 'open' && row.paysYes !== null) {
            fact(t('bets.dialog.paysLabel', 'Pays'), `${t('bets.dialog.yesPays', 'Yes {{multiple}}×', { multiple: row.paysYes.toFixed(2) })} · ${t('bets.dialog.noPays', 'No {{multiple}}×', { multiple: row.paysNo.toFixed(2) })}`);
        }
        if (row.outcome === null) {
            // The agreement's deadline ends its chance to execute; it is not a promised settlement time.
            if (row.closesAt) fact(t('bets.trade.deadline', 'Bet deadline'), root.BetsUI.deadline(row.closesAt));
            else fact(t('bets.dialog.settlesLabel', 'Settlement'), t('bets.dialog.noDeadline', 'No deadline set; settlement follows a terminal on-chain status'));
        }
        const author = model() ? model().authorLabel(row.author) : row.author;
        if (author) fact(t('bets.dialog.authorLabel', 'Proposed by'), author);
        if (row.createdAt) fact(t('gameDialogs.log.actions.create', 'Created'), dateText(row.createdAt, true));
        if (facts.childElementCount) p.body.append(facts);

        const mine = el('p', 'bets-dialog__mine');
        const lines = mineLines(row, positions);
        if (lines.length) mine.textContent = t('panel.proposal.market.yourBets', 'Your bets: {{lines}}', { lines: lines.join('; ') });
        else if (!bridge().needsWallet() || walletConnected()) mine.textContent = t('bets.dialog.noBets', 'You have no bets on this agreement.');
        else mine.textContent = t('panel.proposal.market.connectPosition', 'Connect a Solana wallet to see your bets.');
        p.body.append(mine);
        if (lines.length && state.positionTrackedAccount !== row.account) {
            state.positionTrackedAccount = row.account;
            trackBet('position_view', row, { entryPoint: state.entryPoint });
        }

        if (row.state === 'open' && positions) {
            const selling = el('div', 'bets-dialog__collect');
            ['yes', 'no'].filter(side => positions[side] && BigInt(positions[side].amount) > 0n && !positions[side].claimed).forEach(side => selling.append(button('btn btn-quiet', t('bets.trade.sellSide', 'Sell {{side}} shares', { side: sideWord(side) }), () => renderStake(side, 'sell'))));
            if (selling.childElementCount) p.body.append(selling);
        }
        const claimable = model() ? model().claimSides(row, positions) : [];
        if (claimable.length) {
            const collect = el('div', 'bets-dialog__collect');
            claimable.forEach(side => collect.append(button('btn btn-success btn-sm', t('panel.proposal.market.collect', 'Collect {{side}} winnings', { side: sideWord(side) }), event => transact('claim', side, event.currentTarget))));
            p.body.append(collect);
        }

        const words = lifecycleWords(row);
        if (words) {
            const rule = el('div', 'bets-dialog__rule');
            rule.append(el('strong', null, words.state), el('span', null, words.next), el('span', null, words.rule));
            p.body.append(rule);
        }

        const note = el('p', 'bets-dialog__note');
        note.setAttribute('data-market-dialog-status', '');
        note.setAttribute('aria-live', 'polite');
        p.body.append(note);

        const links = el('p', 'cb-link-row bets-dialog__links');
        if (row.marketAddress && row.asset === 'devnet-usdc') links.append(explorerLink(t('panel.proposal.market.poolAccount', 'Market account'), row.marketAddress));
        links.append(explorerLink(t('bets.dialog.agreementAccount', 'Agreement account'), row.account));
        const terms = el('a', 'cb-link cb-link--external', t('bets.trade.terms', 'Settlement terms'));
        terms.href = `${root.getBackendBase().replace(/\/$/, '')}/oracle/recipes/agreement-execution-by-deadline-v1?agreement=${encodeURIComponent(row.account)}`;
        terms.target = '_blank'; terms.rel = 'noopener noreferrer'; links.append(terms);
        p.body.append(links);

        // Footer: pass it on, go to the agreement, and the bet itself.
        if (linkFor(row.account)) {
            p.footer.append(button('btn btn-quiet', t('bets.copyLink', 'Copy link'), () => sheet().copyLink(row.account, { entryPoint: 'dialog' })));
            if (typeof root.navigator.share === 'function') {
                p.footer.append(button('btn btn-quiet', t('panel.proposal.actions.share', 'Share'), async () => {
                    try {
                        await root.navigator.share({ title: questionOf(row), url: linkFor(row.account) });
                        trackBet('share', row, { entryPoint: 'dialog', result: 'succeeded' });
                    } catch (error) {
                        trackBet('share', row, { entryPoint: 'dialog', result: error?.name === 'AbortError' ? 'cancelled' : 'failed' });
                    }
                }));
            }
        }
        if (row.cid && sheet() && typeof sheet().openAgreement === 'function') {
            p.footer.append(button('btn', t('bets.dialog.openAgreement', 'Open the agreement'), () => {
                const target = row;
                close();
                sheet().openAgreement(target, { entryPoint: 'dialog' });
            }));
        }
        if (row.state === 'open') {
            // The pair takes a footer row of its own, so it never wraps apart from the quiet actions.
            const sides = el('div', 'bets-dialog__sides');
            sides.append(betButton(row, 1), betButton(row, 0));
            p.footer.append(sides);
        } else if (row.state === 'needs-market' && row.sponsor === walletAddress()) {
            p.footer.append(button('btn btn-primary', t('bets.row.openMarket', 'Seed USDC market'), event => transact('createMarket', null, event.currentTarget)));
        } else if (row.state === 'settling') {
            p.footer.append(button('btn btn-primary', t('bets.row.settle', 'Settle market'), event => transact('resolve', null, event.currentTarget)));
        }
    }

    // The bet pair (btn-yes / btn-no, css/primitives.css); btn-market-yes / -no stay as the hooks the
    // specs find them by.
    function betButton(row, side) {
        const yes = side === 1;
        const multiple = yes ? row.paysYes : row.paysNo;
        const node = button(`btn ${yes ? 'btn-yes btn-market-yes' : 'btn-no btn-market-no'} bets-dialog__bet`, null, () => {
            if (bridge().needsWallet() && !walletConnected()) { askForWallet(); return; }
            renderStake(side);
        });
        node.append(el('strong', 'bets-bet__side', yes ? t('bets.row.yes', 'Yes') : t('bets.row.no', 'No')));
        if (multiple !== null && multiple !== undefined) node.append(el('span', 'bets-bet__pays', t('bets.row.pays', 'Pays {{multiple}}×', { multiple: multiple.toFixed(2) })));
        node.title = yes ? t('bets.row.yesExecutes', 'Bet that the agreement executes on-chain by the deadline.') : t('bets.row.noExecutes', 'Bet that the agreement expires or misses the execution deadline.');
        return node;
    }

    // Opening, settling or collecting from the pool: one wallet transaction, the result in the
    // note under the facts, then the overview re-read.
    async function transact(action, side, trigger) {
        const row = state.row;
        const account = state.account;
        const overlay = state.overlay;
        const selected = row.asset;
        const visible = () => state.account === account && state.overlay === overlay && bridge().asset() === selected;
        const actionName = actionFor(action);
        const context = { action: actionName, ...(side === null ? {} : { side: sideName(side) }), entryPoint: state.entryPoint };
        let finished = false;
        const finish = (result, errorCode) => {
            if (finished) return;
            finished = true;
            trackBet('action_end', row, { ...context, result, ...(errorCode ? { errorCode } : {}) });
        };
        if (bridge().needsWallet() && !walletConnected()) { actionAttempt(actionName, row || { account }, context, 'wallet_not_connected'); askForWallet(); return; }
        const chain = bridge();
        const v = view();
        if (!chain || typeof chain[action] !== 'function') { actionAttempt(actionName, row || { account }, context, 'action_unavailable'); return; }
        const key = `${action}:${account}:${side ?? ''}`;
        if (inFlight.has(key)) return;
        inFlight.add(key);
        if (trigger) trigger.disabled = true;
        trackBet('action_start', row, { ...context, result: 'started' });
        try {
            const result = await chain[action]({ proposal: account, ...(side === null ? {} : { side: sideValue(side) }), onStatus: item => {
                if (visible()) setStatus(v ? v.statusText(item) : '', item.explorerUrl);
                if (ACTION_STATUSES.has(item?.state)) trackBet('action_status', row, { ...context, result: item.state });
            } });
            finish(result?.replayed ? 'succeeded' : result?.receipt || result?.transactionHash || result?.transactionHashes?.length ? 'confirmed' : 'unknown');
            if (visible()) setStatus(t('bets.trade.confirmed', 'Confirmed'), result.explorerUrl);
            const wallet = walletAddress();
            const message = action === 'claim' ? t('panel.proposal.market.collectedMessage', 'Collected {{side}} winnings.', { side: sideWord(side) })
                : action === 'createMarket' ? t('panel.proposal.market.historyOpened', 'Seeded USDC market')
                    : t('bets.dialog.settledMessage', "Settled from the agreement's on-chain status.");
            if (selected === 'devnet-usdc' && !root.BetsTelemetry?.simulationRun) await recordSupport({ wallet, action, proposalId: account, result, message: `${actorName(wallet)}: ${message}` });
            announceChange(account);
            if (visible()) await refresh();
            if (visible()) setStatus(message, result.explorerUrl);
        } catch (error) {
            finish(root.BetsTelemetry?.errorResult(error) || 'failed', errorCodeOf(error));
            console.error(`[${new Date().toISOString()}] [bets] ${action} failed`, error);
            if (visible()) setStatus(v ? v.errorText(error) : t('bets.error.transaction', 'The transaction failed.'), error && error.explorerUrl);
        } finally {
            inFlight.delete(key);
            if (trigger && trigger.isConnected) trigger.disabled = false;
        }
    }

    // Re-read the row past the server's cache and draw the overview again (after a bet or a
    // collection, or when something else changed the pool while the dialog is open).
    async function refresh() {
        const account = state.account;
        const overlay = state.overlay, asset = bridge().asset();
        const visible = () => state.account === account && state.overlay === overlay && bridge().asset() === asset;
        const bets = sheet();
        if (bets && typeof bets.load === 'function') { try { await bets.load({ force: true, fresh: true }); } catch (_) { /* the row below says so */ } }
        if (!visible() || !overlay) return;
        const found = await loadRow(account, { title: state.row ? state.row.title : '' });
        if (!visible()) return;
        state.row = found.row; state.contest = found.contest;
        const positions = await loadPositions(account);
        if (!visible()) return;
        state.positions = positions || state.positions;
        if (overlay.querySelector('.bets-dialog').dataset.state === 'overview') renderOverview();
    }

    // ---- stake form ---------------------------------------------------------------------------

    function renderStake(side, action = 'buy') {
        const p = parts(), row = state.row;
        if (!p || !row?.market) return;
        const name = sideName(side), yes = name === 'yes', buying = action === 'buy';
        state.tradeAction = action; state.quotedAmount = null;
        p.dialog.dataset.state = 'stake';
        p.title.textContent = buying ? t('panel.proposal.market.dialogTitle', 'Bet {{side}}', { side: sideWord(side) })
            : t('bets.trade.sellSide', 'Sell {{side}} shares', { side: sideWord(side) });
        disposeCompare(); p.body.replaceChildren(); p.footer.replaceChildren();
        p.body.append(el('p', 'bets-dialog__lead', questionOf(row)));
        p.body.append(el('p', 'bets-dialog__copy', t('bets.trade.priceMoves', 'The price changes as you trade. Review the whole trade below.')));
        const field = el('label', 'bets-dialog__amount');
        field.append(el('span', 'bets-dialog__amount-label', buying ? t('bets.dialog.amount', 'Amount') : t('bets.trade.sharesToSell', 'Shares to sell')));
        const input = el('input'); input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off'; input.placeholder = '1';
        input.setAttribute('data-market-amount', '');
        field.append(input, el('span', 'proposal-market-currency', buying ? row.asset === 'points' ? t('bets.trade.points', 'Points') : 'USDC' : t('bets.trade.shares', 'Shares')));
        p.body.append(field);
        const chips = el('div', 'cb-segmented bets-dialog__chips');
        chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', t('bets.dialog.amount', 'Amount'));
        if (buying) (row.asset === 'points' ? model().POINTS_STAKES : model().QUICK_STAKES).forEach(amount => chips.append(button('cb-segmented__option bets-dialog__chip', amount, () => { input.value = amount; update(); recordQuote(); })));
        const max = button('cb-segmented__option bets-dialog__chip', t('bets.dialog.max', 'Max'), () => { if (max.dataset.amount) { input.value = max.dataset.amount; update(); recordQuote(); } });
        max.hidden = true; chips.append(max); p.body.append(chips);
        const toWin = el('div', 'bets-dialog__towin'); toWin.setAttribute('data-market-towin', ''); toWin.setAttribute('aria-live', 'polite'); p.body.append(toWin);
        const status = el('p', 'proposal-market-status'); status.setAttribute('data-market-dialog-status', ''); status.setAttribute('aria-live', 'polite'); p.body.append(status);
        const quoted = () => model().quote(row.market, name, root.BettingContract.parseAmount(input.value), action);
        const update = () => {
            toWin.replaceChildren(); submit.disabled = true;
            if (!input.value.trim()) return;
            try {
                const quote = quoted();
                if (!buying && quote.shares > BigInt(state.positions?.[name]?.amount || 0)) throw new Error('Too many shares');
                toWin.append(el('strong', null, buying
                    ? t('bets.trade.buyQuote', 'Buy {{shares}} for at most {{amount}}', { shares: root.BetsUI.shares(model().formatAtomic(quote.shares)), amount: moneyAtomic(quote.amount) })
                    : t('bets.trade.sellQuote', 'Sell {{shares}} for at least {{amount}}', { shares: root.BetsUI.shares(model().formatAtomic(quote.shares)), amount: moneyAtomic(quote.amount) })));
                if (buying) toWin.append(el('p', null, t('bets.trade.winQuote', 'If {{side}} wins, these shares pay {{amount}}. Later trades do not change that payout.', { side: sideWord(side), amount: moneyAtomic(quote.shares) })));
                toWin.append(el('p', null, t('bets.trade.quoteGuard', 'If the price moves against this quote, the trade is rejected.')));
                submit.disabled = false;
            } catch (_) { toWin.append(el('p', null, t('bets.trade.invalidAmount', 'Enter a valid positive amount within your balance or shares.'))); }
        };
        const recordQuote = () => {
            let quote; try { quote = quoted(); } catch (_) { return; }
            const key = `${action}:${name}:${quote.shares}:${quote.amount}`;
            if (key === state.quotedAmount) return;
            state.quotedAmount = key; trackBet('quote', row, { action, side: name, entryPoint: state.entryPoint });
        };
        const submit = button(`btn ${yes ? 'btn-yes btn-market-yes' : 'btn-no btn-market-no'}`, buying
            ? t('bets.trade.buy', 'Buy shares') : t('bets.trade.sell', 'Sell shares'), () => submitTrade(side, action, quoted));
        submit.disabled = true; submit.setAttribute('data-market-submit', '');
        p.footer.append(button('btn', t('proposalDrafts.actions.back', 'Back'), () => renderOverview()), submit);
        input.addEventListener('input', update); input.addEventListener('blur', recordQuote);
        input.addEventListener('keydown', event => { if (event.key === 'Enter' && !submit.disabled) { event.preventDefault(); submit.click(); } });
        input.focus();
        const available = buying ? bridge().readStakeBalance() : Promise.resolve(BigInt(state.positions?.[name]?.amount || 0));
        Promise.resolve(available).then(balance => {
            if (typeof balance !== 'bigint' || balance <= 0n || !max.isConnected) return;
            max.dataset.amount = model().formatAtomic(balance);
            max.textContent = `${t('bets.dialog.max', 'Max')} ${buying ? moneyAtomic(balance) : root.BetsUI.shares(model().formatAtomic(balance))}`; max.hidden = false;
        }).catch(error => { if (status.isConnected) status.textContent = root.BetsUI.errorText(error); });
    }

    async function submitTrade(side, action, quoted) {
        const p = parts(), row = state.row;
        if (!p || !row) return;
        let quote; try { quote = quoted(); } catch (_) { return; }
        const account = state.account, overlay = state.overlay, chosen = row.asset;
        const context = { action, side: sideName(side), asset: chosen, entryPoint: state.entryPoint };
        const key = `${action}:${account}:${chosen}:${sideName(side)}`;
        if (inFlight.has(key)) return;
        if (bridge().needsWallet() && !walletConnected()) { actionAttempt(action, row, context, 'wallet_not_connected'); askForWallet(); return; }
        inFlight.add(key);
        const submit = p.footer.querySelector('[data-market-submit]'); submit.disabled = true;
        const stillHere = () => state.overlay === overlay && state.account === account && bridge().asset() === chosen;
        const status = item => {
            if (stillHere()) setStatus(view().statusText(item), item.explorerUrl);
            if (ACTION_STATUSES.has(item?.state)) trackBet('action_status', row, { ...context, result: item.state });
        };
        trackBet('quote', row, context); trackBet('action_start', row, { ...context, result: 'started' });
        let confirmed = false;
        try {
            const result = await bridge()[action]({ proposal: account, side: sideValue(side), shares: quote.shares,
                ...(action === 'buy' ? { maxCost: quote.maxCost } : { minReturn: quote.minReturn }), onStatus: status });
            confirmed = Boolean(result?.receipt || result?.transactionHash);
            trackBet('action_end', row, { ...context, result: confirmed ? 'confirmed' : 'unknown' });
            if (stillHere()) renderPlaced(row, side, quote, result);
            announceChange(account);
        } catch (error) {
            if (!confirmed) trackBet('action_end', row, { ...context, result: root.BetsTelemetry?.errorResult(error) || 'failed', errorCode: errorCodeOf(error) });
            if (stillHere()) {
                setStatus(view().errorText(error), error.explorerUrl);
                if (error.code === 'STALE_QUOTE' || error.code === 'SLIPPAGE_EXCEEDED') {
                    const note = p.body.querySelector('[data-market-dialog-status]');
                    note.append(button('btn btn-quiet', t('bets.trade.refreshQuote', 'Review a fresh quote'), async () => { await refresh(); renderStake(side, action); }));
                }
            }
        } finally { inFlight.delete(key); if (submit.isConnected) submit.disabled = false; }
    }

    // A points receipt reports the ledger's actual amount. A chain trade shows its signed cost
    // limit and fixed shares until the transaction's explorer supplies the executed token transfer.
    function renderPlaced(row, side, quote, result) {
        const p = parts(); if (!p) return;
        p.dialog.dataset.state = 'placed';
        p.title.textContent = quote.action === 'buy' ? t('panel.proposal.market.placedTitle', 'Bet placed') : t('bets.trade.sold', 'Shares sold');
        disposeCompare(); p.body.replaceChildren(); p.footer.replaceChildren();
        p.body.append(el('p', 'bets-dialog__lead', questionOf(row)));
        const facts = el('dl', 'bets-dialog__facts');
        facts.append(el('dt', null, t('bets.trade.shares', 'Shares')), el('dd', null, `${sideWord(side)} · ${model().formatAtomic(quote.shares)}`));
        const amount = result.receipt ? BigInt(result.receipt.amount) : quote.amount;
        const moneyLabel = result.receipt ? quote.action === 'buy' ? t('bets.trade.cost', 'Cost') : t('bets.trade.returned', 'Returned')
            : quote.action === 'buy' ? t('bets.trade.maximumCost', 'Maximum cost') : t('bets.trade.minimumReturn', 'Minimum return');
        facts.append(el('dt', null, moneyLabel), el('dd', null, root.BetsUI.money(model().formatAtomic(amount), row.asset)));
        if (quote.action === 'buy') facts.append(el('dt', null, t('bets.trade.payoutIfWin', 'Payout if this side wins')), el('dd', null, root.BetsUI.money(model().formatAtomic(quote.shares), row.asset)));
        if (result.receipt) facts.append(el('dt', null, t('bets.trade.receipt', 'Receipt')), el('dd', 'bets-receipt-id', result.receipt.id));
        p.body.append(facts);
        const status = el('p', 'proposal-market-status'); status.setAttribute('data-market-dialog-status', ''); p.body.append(status);
        setStatus(t('bets.trade.confirmed', 'Confirmed'), result.explorerUrl);
        const balance = el('p', 'bets-account__balance'); p.body.append(balance);
        bridge().readStakeBalance().then(value => { if (balance.isConnected && value !== null) balance.textContent = t('bets.trade.balance', 'Available: {{amount}}', { amount: moneyAtomic(value) }); })
            .catch(() => { if (balance.isConnected) balance.textContent = t('bets.trade.balanceUnavailable', 'Balance unavailable. Try again before trading.'); });
        if (linkFor(row.account)) p.footer.append(button('btn', t('bets.copyLink', 'Copy link'), () => sheet().copyLink(row.account, { entryPoint: 'receipt' })));
        p.footer.append(button('btn', t('bets.trade.yourPosition', 'Your position'), async () => { p.dialog.dataset.state = 'overview'; await refresh(); }));
        const done = button('btn btn-primary', t('panel.proposal.market.done', 'Done'), close); done.setAttribute('data-market-done', ''); p.footer.append(done); done.focus();
    }

    // ---- open ---------------------------------------------------------------------------------

    // Open the bet's dialog of an agreement account; with `side` (1/0 or 'yes'/'no') straight into the
    // stake form, as the Yes/No buttons on a row do. `title` names an agreement the city list may not
    // carry yet (one just minted, opened from its panel).
    async function openBetDialog(options = {}) {
        const account = options && options.account ? String(options.account) : null;
        if (!account) return null;
        const side = options.side === undefined || options.side === null ? null : sideValue(options.side);
        if (side !== null && bridge().needsWallet() && !walletConnected() && !options.approval) {
            actionAttempt('buy', { account }, { side: sideName(side), entryPoint: options.entryPoint || 'dialog' }, 'wallet_not_connected');
            askForWallet(); return null;
        }
        const overlay = mount(options.title || t('panel.proposal.market.historyBet', 'Bet'));
        state.account = account;
        state.entryPoint = options.entryPoint || 'dialog';
        state.positionTrackedAccount = null;
        state.quotedAmount = null;
        state.row = null; state.contest = null; state.positions = null;
        showBetAddress(account);
        const p = parts();
        p.body.append(el('p', 'bets-status', t('bets.loading', 'Loading bets…')));
        try { p.dialog.focus({ preventScroll: true }); } catch (_) { }
        const found = await loadRow(account, options);
        if (state.overlay !== overlay) return overlay;
        state.row = found.row;
        state.contest = found.contest;
        state.positions = await loadPositions(account) || state.positions;
        if (state.overlay !== overlay) return overlay;
        // Only an open pool takes a new bet: a link with a side to a pool that is settling or settled
        // lands on its overview.
        trackBet('market_open', state.row, { entryPoint: state.entryPoint });
        if (side !== null && state.row.state === 'open') {
            renderStake(side);
            const input = parts().body.querySelector('[data-market-amount]');
            if (input && options.amount) { input.value = options.amount; input.dispatchEvent(new Event('input', { bubbles: true })); }
        } else {
            renderOverview();
        }
        return overlay;
    }

    doc.addEventListener('bets:asset', async () => {
        if (!state.overlay) return;
        const p = parts(); p.dialog.dataset.state = 'overview'; p.body.replaceChildren(el('p', 'bets-status', t('bets.loading', 'Loading bets…'))); p.footer.replaceChildren();
        await refresh();
    });
    root.openBetDialog = openBetDialog;
    root.BetsDialog = { open: openBetDialog, close, OVERLAY_ID };
})(typeof window !== 'undefined' ? window : null);
