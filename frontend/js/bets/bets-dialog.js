// One bet's own view: the dialog a bet link opens, a Bets row opens, and the Details card's
// "Bet yes/no" opens straight into the stake form. Three states in one cb-dialog: the overview
// (chance, pool, payouts, deadline, rule, your bets, links), the stake form (amount, quick stakes,
// a live "to win") and the receipt after a confirmed bet. The numbers come from
// js/bets/bets-model.js, the row from the Bets sheet (js/bets/bets-sheet.js), the chain reads and
// transactions from js/solana/market-bridge.js. The overlay keeps the id the stake dialog always
// had, so the sheet, the Details card and the specs find it where it was.
(function (root) {
    'use strict';
    if (!root || !root.document) return;

    const doc = root.document;
    const OVERLAY_ID = 'proposalMarketOverlay';
    const EXPLORER = 'https://explorer.solana.com';
    const state = { overlay: null, proposalAccount: null, row: null, contest: null, positions: null, opener: null, unregisterEscape: null };
    const inFlight = new Set();

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
    const view = () => root.ProposalMarketView || null;
    const bridge = () => root.SolanaMarketBridge || null;
    const sheet = () => root.BetsSheet || null;
    const backendBase = () => (typeof root.getBackendBase === 'function' ? root.getBackendBase().replace(/\/$/, '') : 'https://api.urbangametheory.xyz');

    function money(amountText) {
        const f = format();
        return f && typeof f.formatMoney === 'function' ? f.formatMoney(Number(amountText), 'USDC') : `${amountText} USDC`;
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

    function announceChange(proposalAccount) {
        if (typeof root.notifyProposalMarketChanged === 'function') { root.notifyProposalMarketChanged(proposalAccount); return; }
        try { doc.dispatchEvent(new root.CustomEvent('proposal-market:changed', { detail: { proposalAccount } })); } catch (_) { }
    }

    // The Details card, when it shows this proposal, re-reads its pool too.
    function refreshCard(proposalAccount) {
        if (typeof root.hydrateProposalMarketCard !== 'function') return;
        let lifecycle = '';
        try {
            if (typeof currentProposalDetailsContext !== 'undefined' && currentProposalDetailsContext && typeof getLifecycleStatus === 'function') {
                lifecycle = getLifecycleStatus(currentProposalDetailsContext);
            }
        } catch (_) { lifecycle = ''; }
        root.hydrateProposalMarketCard(proposalAccount, lifecycle);
    }

    async function recordSupport(entry) {
        if (typeof root.recordHumanProposalSupport !== 'function') return;
        try { await root.recordHumanProposalSupport(entry); } catch (error) { console.warn(`[${new Date().toISOString()}] [bets] activity not recorded`, error); }
    }

    function actorName(wallet) {
        return wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : 'Wallet user';
    }

    // ---- data ---------------------------------------------------------------------------------

    // The row from the Bets sheet's city payload; without one (a proposal the city list does not
    // carry yet, as the Details card can show), the pool straight from the chain.
    async function loadRow(proposalAccount, options) {
        const bets = sheet();
        let found = null;
        if (bets && typeof bets.ensureLoaded === 'function') {
            try { await bets.ensureLoaded(); } catch (_) { found = null; }
            found = typeof bets.rowFor === 'function' ? bets.rowFor(proposalAccount) : null;
        }
        if (found) return found;
        const fallback = { contest: null, row: {
            proposalAccount, proposalId: options.proposalId || null, id: options.id || null, title: options.title || '', author: null, agent: false,
            createdAt: null, screenshotUrl: null, parcelIds: [], lifecycleStatus: options.lifecycleStatus || 'Active', state: 'open',
            chanceYes: null, chanceNo: null, oneSided: null, pool: null, poolAtomic: 0n, yesPoolAtomic: 0n, noPoolAtomic: 0n, outcome: null,
            paysYes: null, paysNo: null, closesAt: null, marketAddress: null, fromChain: true
        } };
        const chain = bridge();
        if (!chain || typeof chain.readSummary !== 'function' || !model()) return fallback;
        try {
            const summary = await chain.readSummary(proposalAccount);
            const market = summary && summary.market ? summary.market : null;
            if (market) {
                const entry = {
                    proposalAccount, bettable: !market.resolved, lifecycleStatus: summary.chainStatus || fallback.row.lifecycleStatus,
                    market: { address: summary.marketAddress, yesPool: market.yesPool, noPool: market.noPool, poolAtomic: BigInt(market.yesPool || 0) + BigInt(market.noPool || 0),
                        resolved: Boolean(market.resolved), outcome: market.resolved ? (Number(market.outcome) === 1 ? 'yes' : 'no') : null }
                };
                fallback.row = { ...fallback.row, ...model().row(entry), title: fallback.row.title, proposalId: fallback.row.proposalId, id: fallback.row.id, fromChain: true };
            }
            if (summary && summary.wallet) state.positions = { yes: summary.yes || null, no: summary.no || null };
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] [bets] pool unreadable for ${proposalAccount}`, error);
        }
        return fallback;
    }

    async function loadPositions(proposalAccount) {
        const bets = sheet();
        if (bets && typeof bets.whenPositions === 'function') { try { await bets.whenPositions(); } catch (_) { /* read below */ } }
        const known = bets && typeof bets.positionsFor === 'function' ? bets.positionsFor(proposalAccount) : null;
        if (known) return known;
        const chain = bridge();
        if (!walletConnected() || !chain || typeof chain.readPositions !== 'function') return null;
        try {
            const all = await chain.readPositions([proposalAccount]);
            return all && all[proposalAccount] ? all[proposalAccount] : null;
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

    function linkFor(proposalAccount) {
        const bets = sheet();
        return bets && typeof bets.linkFor === 'function' ? bets.linkFor(proposalAccount) : null;
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
    function showBetAddress(proposalAccount) {
        try {
            const url = new URL(root.location.href);
            url.pathname = `/bets/${proposalAccount}`;
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

    function close() {
        const overlay = state.overlay;
        if (!overlay) return;
        if (typeof state.unregisterEscape === 'function') state.unregisterEscape();
        overlay.remove();
        showAppAddress();
        const opener = state.opener;
        state.overlay = null; state.row = null; state.contest = null; state.positions = null; state.opener = null; state.unregisterEscape = null;
        // Focus goes back where the dialog came from (a Bets row, the market card); the sheet or
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
            const link = el('a', null, ` ${t('panel.proposal.market.explorerTx', 'View on the block explorer')} ↗`);
            link.href = url; link.target = '_blank'; link.rel = 'noopener';
            node.append(link);
        }
    }

    // ---- overview -----------------------------------------------------------------------------

    function chanceLabel(row) {
        if (row.state === 'resolved-yes') return t('bets.row.resolvedYes', 'Settled yes');
        if (row.state === 'resolved-no') return t('bets.row.resolvedNo', 'Settled no');
        if (row.state === 'not-minted') return t('bets.row.notMinted', 'Not minted yet, so no pool');
        if (row.state === 'needs-market') return t('panel.proposal.market.state.needsPool', 'No pool yet');
        if (row.oneSided === 'yes') return t('bets.row.onlyYes', 'Only yes bets so far');
        if (row.oneSided === 'no') return t('bets.row.onlyNo', 'Only no bets so far');
        if (row.chanceYes === null || row.chanceYes === undefined) return t('bets.row.noBets', 'No bets yet');
        return t('bets.row.chance', '{{percent}} chance', { percent: percentText(row.chanceYes) });
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

    function lifecycleWords(row) {
        const v = view();
        if (!v || typeof v.lifecycle !== 'function') return null;
        const marketModel = row.marketAddress ? {
            exists: true, resolved: row.outcome !== null, outcome: row.outcome, yesPool: row.yesPoolAtomic, noPool: row.noPoolAtomic
        } : { exists: false };
        const words = v.lifecycle(row.lifecycleStatus, marketModel);
        return {
            state: t(`panel.proposal.market.state.${words.stateKey}`, words.state),
            next: t(`panel.proposal.market.next.${words.nextKey}`, words.next),
            rule: t('panel.proposal.market.rule', words.rule)
        };
    }

    function mineLines(row, positions) {
        if (!positions || !model()) return [];
        return ['yes', 'no']
            .filter(side => positions[side] && model().formatAtomic(positions[side].amount) !== '0')
            .map(side => t('panel.proposal.market.betLine', '{{side}} {{amount}}', { side: sideWord(side), amount: moneyAtomic(positions[side].amount) })
                + (positions[side].claimed ? ` (${t('panel.proposal.market.paidOut', 'paid out')})` : ''));
    }

    function explorerLink(text, address) {
        const link = el('a', 'bets-dialog__link', `${text} ↗`);
        link.href = `${EXPLORER}/address/${encodeURIComponent(address)}?cluster=devnet`;
        link.target = '_blank'; link.rel = 'noopener';
        return link;
    }

    function renderOverview() {
        const p = parts();
        const { row, contest, positions } = state;
        if (!p || !row) return;
        p.title.textContent = row.title || t('bets.row.untitled', 'Untitled proposal');
        p.body.replaceChildren();
        p.footer.replaceChildren();
        p.dialog.dataset.state = 'overview';

        const eyebrow = el('p', 'bets-dialog__eyebrow');
        eyebrow.append(el('span', null, t('bets.tagline', 'Bet on cities')));
        const land = landLine(row, contest);
        if (land) eyebrow.append(el('span', null, ` · ${land}`));
        p.body.append(eyebrow);

        if (contest && contest.proposalCount > 1) {
            const counted = sheet() && typeof sheet().entriesText === 'function'
                ? sheet().entriesText(contest).join(' · ')
                : t('agentDialog.proposalCount', '{{count}} proposals', { count: contest.proposalCount });
            const rivals = button('btn btn-quiet bets-dialog__contest', t('bets.dialog.onThisLandCount', '{{entries}} on this land', { entries: counted }), () => {
                const id = contest.id;
                close();
                if (typeof root.openBetsSheet === 'function') root.openBetsSheet({ contestId: id });
            });
            p.body.append(rivals);
        }

        const image = absoluteImage(row.screenshotUrl);
        if (image) {
            const img = el('img', 'bets-dialog__thumb');
            img.src = image; img.alt = ''; img.loading = 'lazy';
            p.body.append(img);
        }

        const chance = el('div', `bets-dialog__chance is-${row.state}`);
        chance.append(el('strong', 'bets-dialog__chance-word', chanceLabel(row)));
        if (row.state === 'open' && row.chanceYes !== null && row.chanceYes !== undefined && !row.oneSided) {
            const bar = el('div', 'bets-row__bar');
            const fill = el('span');
            fill.style.width = `${Math.max(0, Math.min(100, row.chanceYes))}%`;
            bar.append(fill);
            chance.append(bar);
        }
        p.body.append(chance);

        const facts = el('dl', 'bets-dialog__facts');
        const fact = (label, value) => { if (!value) return; facts.append(el('dt', null, label), el('dd', null, value)); };
        if (row.pool !== null && row.pool !== undefined) fact(t('bets.dialog.poolLabel', 'Pool'), money(row.pool));
        if (row.state === 'open' && row.paysYes !== null) {
            fact(t('bets.dialog.paysLabel', 'Pays'), `${t('bets.dialog.yesPays', 'Yes {{multiple}}×', { multiple: row.paysYes.toFixed(2) })} · ${t('bets.dialog.noPays', 'No {{multiple}}×', { multiple: row.paysNo.toFixed(2) })}`);
        }
        if (row.outcome === null) {
            fact(t('bets.dialog.settlesLabel', 'Settles'), row.closesAt
                ? t('bets.dialog.settlesBy', 'By {{date}} at the latest', { date: dateText(row.closesAt) })
                : t('bets.dialog.noDeadline', 'No deadline set; when the proposal is executed or dropped'));
        }
        const author = model() ? model().authorLabel(row.author) : row.author;
        if (author) fact(t('bets.dialog.authorLabel', 'Proposed by'), row.agent ? `${author} · ${t('panel.proposal.agent.badge', 'Agent proposal')}` : author);
        if (row.createdAt) fact(t('gameDialogs.log.actions.create', 'Created'), dateText(row.createdAt, true));
        if (facts.childElementCount) p.body.append(facts);

        const mine = el('p', 'bets-dialog__mine');
        const lines = mineLines(row, positions);
        if (lines.length) mine.textContent = t('panel.proposal.market.yourBets', 'Your bets: {{lines}}', { lines: lines.join('; ') });
        else if (walletConnected()) mine.textContent = t('panel.proposal.market.noBets', 'You have no bets on this proposal.');
        else mine.textContent = t('panel.proposal.market.connectPosition', 'Connect a Solana wallet to see your bets.');
        p.body.append(mine);

        const claimable = model() ? model().claimSides(row, positions) : [];
        if (claimable.length) {
            const collect = el('div', 'bets-dialog__collect');
            claimable.forEach(side => collect.append(button('btn btn-success', t('panel.proposal.market.collect', 'Collect {{side}} winnings', { side: sideWord(side) }), event => transact('claim', side, event.currentTarget))));
            p.body.append(collect);
        }

        // A plan says what it builds: its member proposals, folded so the bet stays the headline.
        if (row.kind === 'plan' && row.members.length) {
            const members = el('details', 'bets-dialog__members');
            members.append(el('summary', null, t('bets.dialog.members', 'What the plan builds: {{count}} proposals', { count: row.members.length })));
            const list = el('ul');
            row.members.forEach(member => list.append(el('li', null, member.title || member.proposalId)));
            members.append(list);
            p.body.append(members);
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

        const links = el('p', 'bets-dialog__links');
        if (row.marketAddress) links.append(explorerLink(t('panel.proposal.market.poolAccount', 'Pool account'), row.marketAddress));
        links.append(explorerLink(t('panel.proposal.pledge.proposalExplorer', 'Proposal account'), row.proposalAccount));
        p.body.append(links);

        // Footer: pass it on, go to the proposal, and the bet itself.
        if (linkFor(row.proposalAccount)) {
            p.footer.append(button('btn btn-quiet', t('bets.copyLink', 'Copy link'), () => sheet().copyLink(row.proposalAccount)));
            if (typeof root.navigator.share === 'function') {
                p.footer.append(button('btn btn-quiet', t('panel.proposal.actions.share', 'Share'), async () => {
                    try { await root.navigator.share({ title: row.title, url: linkFor(row.proposalAccount) }); } catch (_) { /* dismissed */ }
                }));
            }
        }
        if (row.proposalId || row.id) {
            const openLabel = row.kind === 'plan' ? t('bets.dialog.openPlan', 'Open the plan') : t('gameDialogs.log.row.openProposal', 'Open proposal');
            p.footer.append(button('btn', openLabel, () => {
                const target = row;
                close();
                if (sheet() && typeof sheet().openProposal === 'function') sheet().openProposal(target);
            }));
        }
        if (row.state === 'open') {
            // The pair takes a footer row of its own, so it never wraps apart from the quiet actions.
            const sides = el('div', 'bets-dialog__sides');
            sides.append(betButton(row, 1), betButton(row, 0));
            p.footer.append(sides);
        } else if (row.state === 'needs-market') {
            p.footer.append(button('btn btn-primary', t('bets.row.openMarket', 'Open the pool'), event => transact('createMarket', null, event.currentTarget)));
        } else if (row.state === 'settling') {
            p.footer.append(button('btn btn-primary', t('bets.row.settle', 'Settle the pool'), event => transact('resolve', null, event.currentTarget)));
        }
    }

    function betButton(row, side) {
        const yes = side === 1;
        const multiple = yes ? row.paysYes : row.paysNo;
        const node = button(`btn ${yes ? 'btn-market-yes' : 'btn-market-no'} bets-dialog__bet`, null, () => {
            if (!walletConnected()) { askForWallet(); return; }
            renderStake(side);
        });
        node.append(el('strong', 'bets-bet__side', yes ? t('bets.row.yes', 'Yes') : t('bets.row.no', 'No')));
        if (multiple !== null && multiple !== undefined) node.append(el('span', 'bets-bet__pays', t('bets.row.pays', 'Pays {{multiple}}×', { multiple: multiple.toFixed(2) })));
        node.title = yes ? t('bets.row.yesTitle', 'Bet that this proposal gets built.') : t('bets.row.noTitle', 'Bet that this proposal does not get built.');
        return node;
    }

    // Opening, settling or collecting from the pool: one wallet transaction, the result in the
    // note under the facts, then the overview re-read.
    async function transact(action, side, trigger) {
        if (!walletConnected()) { askForWallet(); return; }
        const chain = bridge();
        const v = view();
        const proposalAccount = state.proposalAccount;
        if (!chain || typeof chain[action] !== 'function') return;
        const key = `${action}:${proposalAccount}:${side ?? ''}`;
        if (inFlight.has(key)) return;
        inFlight.add(key);
        if (trigger) trigger.disabled = true;
        try {
            const result = await chain[action]({ proposal: proposalAccount, ...(side === null ? {} : { side: sideValue(side) }), onStatus: item => setStatus(v ? v.statusText(item) : '', item.explorerUrl) });
            setStatus(v ? v.confirmedText() : '', result.explorerUrl);
            const wallet = walletAddress();
            const message = action === 'claim' ? t('panel.proposal.market.collectedMessage', 'Collected {{side}} winnings.', { side: sideWord(side) })
                : action === 'createMarket' ? t('panel.proposal.market.historyOpened', 'Opened the pool')
                    : t('panel.proposal.market.settledMessage', "Settled from the proposal's on-chain status.");
            await recordSupport({ wallet, action, proposalId: proposalAccount, result, message: `${actorName(wallet)}: ${message}` });
            announceChange(proposalAccount);
            refreshCard(proposalAccount);
            await refresh();
            setStatus(message, result.explorerUrl);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [bets] ${action} failed`, error);
            setStatus(v ? v.errorText(error) : t('bets.error.transaction', 'The transaction failed.'), error && error.explorerUrl);
        } finally {
            inFlight.delete(key);
            if (trigger && trigger.isConnected) trigger.disabled = false;
        }
    }

    // Re-read the row past the server's cache and draw the overview again (after a bet or a
    // collection, or when something else changed the pool while the dialog is open).
    async function refresh() {
        const proposalAccount = state.proposalAccount;
        const bets = sheet();
        if (bets && typeof bets.load === 'function') { try { await bets.load({ force: true, fresh: true }); } catch (_) { /* the row below says so */ } }
        if (state.proposalAccount !== proposalAccount || !state.overlay) return;
        const found = await loadRow(proposalAccount, { title: state.row ? state.row.title : '' });
        if (state.proposalAccount !== proposalAccount || !state.overlay) return;
        state.row = found.row; state.contest = found.contest;
        state.positions = await loadPositions(proposalAccount) || state.positions;
        if (state.proposalAccount === proposalAccount && state.overlay && state.overlay.querySelector('.bets-dialog').dataset.state === 'overview') renderOverview();
    }

    // ---- stake form ---------------------------------------------------------------------------

    function renderStake(side) {
        const p = parts();
        const row = state.row;
        if (!p || !row) return;
        const yes = sideValue(side) === 1;
        const m = model();
        p.dialog.dataset.state = 'stake';
        p.title.textContent = t('panel.proposal.market.dialogTitle', 'Bet {{side}}', { side: sideWord(side) });
        p.body.replaceChildren();
        p.footer.replaceChildren();

        if (row.title) p.body.append(el('p', 'bets-dialog__lead', row.title));
        p.body.append(el('p', 'bets-dialog__copy', yes ? t('bets.row.yesTitle', 'Bet that this proposal gets built.') : t('bets.row.noTitle', 'Bet that this proposal does not get built.')));

        const field = el('label', 'bets-dialog__amount');
        field.append(el('span', 'bets-dialog__amount-label', t('bets.dialog.amount', 'Amount')));
        const input = el('input');
        input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off'; input.placeholder = '1.00';
        input.setAttribute('data-market-amount', '');
        field.append(input, el('span', 'proposal-market-currency', 'USDC'));
        p.body.append(field);

        const chips = el('div', 'bets-dialog__chips');
        (m ? m.QUICK_STAKES : ['0.1', '1', '5']).forEach(amount => chips.append(button('btn btn-quiet bets-dialog__chip', amount, () => { input.value = amount; update(); input.focus(); })));
        const max = button('btn btn-quiet bets-dialog__chip', t('bets.dialog.max', 'Max'), () => { if (max.dataset.amount) { input.value = max.dataset.amount; update(); input.focus(); } });
        max.hidden = true;
        chips.append(max);
        p.body.append(chips);

        const toWin = el('p', 'bets-dialog__towin');
        toWin.setAttribute('data-market-towin', '');
        toWin.setAttribute('aria-live', 'polite');
        p.body.append(toWin);

        const status = el('div', 'proposal-market-status');
        status.setAttribute('data-market-dialog-status', '');
        status.setAttribute('aria-live', 'polite');
        p.body.append(status);

        // The live "to win": the stake with itself in the pool, so the number is what the program
        // would pay now; the pool at settlement decides the real one.
        const update = () => {
            toWin.replaceChildren();
            if (!m || !row.marketAddress) return;
            const v = view();
            let amount;
            try { amount = v ? v.parseUsdc(input.value) : null; } catch (_) { amount = null; }
            if (!amount) return;
            const prize = m.toWin(sideName(side), row.yesPoolAtomic, row.noPoolAtomic, amount);
            const multiple = m.payoutMultiple(sideName(side), row.yesPoolAtomic, row.noPoolAtomic, amount);
            toWin.append(el('strong', null, t('bets.dialog.toWin', 'To win about {{amount}} if {{side}} wins', { amount: moneyAtomic(prize), side: sideWord(side) })));
            toWin.append(el('span', null, ` (${t('bets.row.pays', 'Pays {{multiple}}×', { multiple: multiple === null ? '—' : multiple.toFixed(2) })}). ${t('bets.dialog.toWinNote', 'The final payout follows the pool at settlement.')}`));
        };
        input.addEventListener('input', update);
        input.addEventListener('keydown', event => { if (event.key !== 'Enter') return; event.preventDefault(); submitStake(side); });

        const back = button('btn', t('proposalDrafts.actions.back', 'Back'), () => renderOverview());
        const submit = button(`btn ${yes ? 'btn-market-yes' : 'btn-market-no'}`, t('panel.proposal.market.dialogTitle', 'Bet {{side}}', { side: sideWord(side) }), () => submitStake(side));
        submit.setAttribute('data-market-submit', '');
        p.footer.append(back, submit);
        input.focus();

        // The wallet's balance fills "Max"; a slow or failed read just leaves the chip hidden.
        const chain = bridge();
        if (chain && typeof chain.readStakeBalance === 'function' && m) {
            Promise.resolve(chain.readStakeBalance()).then(balance => {
                if (typeof balance !== 'bigint' || balance <= 0n || !max.isConnected) return;
                max.dataset.amount = m.formatAtomic(balance);
                max.textContent = `${t('bets.dialog.max', 'Max')} ${moneyAtomic(balance)}`;
                max.hidden = false;
            }).catch(() => { });
        }
    }

    async function submitStake(side) {
        const p = parts();
        const v = view();
        const row = state.row;
        if (!p || !row || !v) return;
        const input = p.body.querySelector('[data-market-amount]');
        const submit = p.footer.querySelector('[data-market-submit]');
        const rawAmount = input ? input.value : '';
        let amount;
        try { amount = v.parseUsdc(rawAmount); } catch (error) { setStatus(error.message); return; }
        const proposalAccount = state.proposalAccount;
        const wallet = walletAddress() || 'wallet';
        const key = `stake:${proposalAccount}:${wallet}:${sideValue(side)}`;
        if (inFlight.has(key)) return;
        inFlight.add(key);
        if (submit) submit.disabled = true;
        try {
            const result = await bridge().stake({ proposal: proposalAccount, side: sideValue(side), amount, onStatus: item => setStatus(v.statusText(item), item.explorerUrl) });
            setStatus(v.confirmedText(), result.explorerUrl);
            // The receipt first, then everything behind it: the Bets sheet re-reads its pools, the
            // Details card re-reads this one, the status bar keeps the line, the activity feed gets the bet.
            renderPlaced(side, amount, v.confirmedText(), result.explorerUrl);
            announceChange(proposalAccount);
            refreshCard(proposalAccount);
            const placedLine = t('panel.proposal.market.placedLine', '{{amount}} on {{side}} is in the pool.', { amount: moneyAtomic(amount), side: sideWord(side) });
            if (typeof root.updateStatus === 'function') root.updateStatus(placedLine);
            await recordSupport({ wallet, action: 'stake', proposalId: proposalAccount, amount: rawAmount, result, message: `${actorName(wallet)} bet ${rawAmount} USDC on ${sideWord(side)}.` });
        } catch (error) {
            setStatus(v.errorText(error), error && error.explorerUrl);
        } finally {
            inFlight.delete(key);
            if (submit && submit.isConnected) submit.disabled = false;
        }
    }

    // ---- receipt ------------------------------------------------------------------------------

    // After a confirmed bet the dialog becomes the receipt: what went in, the pool as it now stands
    // (read back from the chain, not assumed), the wallet's bets on this proposal, the bet's link
    // and Done. It stays until the person closes it; the surfaces behind it have already refreshed.
    function renderPlaced(side, amount, confirmedText, explorerUrl) {
        const p = parts();
        const row = state.row;
        const v = view();
        const m = model();
        if (!p || !row || !v) return;
        p.dialog.dataset.state = 'placed';
        p.title.textContent = t('panel.proposal.market.placedTitle', 'Bet placed');
        p.body.replaceChildren();
        p.footer.replaceChildren();
        p.body.append(el('p', 'proposal-boost-copy', t('panel.proposal.market.placedLine', '{{amount}} on {{side}} is in the pool.', { amount: moneyAtomic(amount), side: sideWord(side) })));
        const pool = el('div', 'proposal-market-placed', t('panel.proposal.market.poolReading', 'Reading the pool…'));
        pool.setAttribute('aria-live', 'polite');
        p.body.append(pool);
        const status = el('div', 'proposal-market-status');
        status.setAttribute('data-market-dialog-status', '');
        status.setAttribute('aria-live', 'polite');
        p.body.append(status);
        setStatus(confirmedText, explorerUrl);

        if (linkFor(row.proposalAccount)) {
            const share = button('btn', t('bets.copyLink', 'Copy link'), () => sheet().copyLink(row.proposalAccount));
            share.setAttribute('data-market-link', '');
            p.footer.append(share);
        }
        const done = button('btn btn-primary', t('panel.proposal.market.done', 'Done'), close);
        done.setAttribute('data-market-done', '');
        p.footer.append(done);
        done.focus();

        Promise.resolve(bridge().readSummary(row.proposalAccount)).then(summary => {
            if (!pool.isConnected) return;
            const marketModel = v.model(summary && summary.market, { yes: summary && summary.yes, no: summary && summary.no });
            if (!marketModel.exists) { pool.remove(); return; }
            const pays = s => (m && typeof m.payoutMultiple === 'function' ? m.payoutMultiple(s, marketModel.yesPool, marketModel.noPool) : null);
            const chance = value => (value === null ? t('bets.row.noBets', 'No bets yet') : t('bets.row.chance', '{{percent}} chance', { percent: percentText(value) }));
            pool.replaceChildren(el('p', 'proposal-market-placed__title', t('panel.proposal.market.poolNow', 'The pool after your bet')));
            const list = el('dl', 'proposal-market-placed__pool');
            [['yes', t('panel.proposal.market.yesSide', 'Yes · gets built'), marketModel.yesPool, marketModel.yesOdds], ['no', t('panel.proposal.market.noSide', 'No · dropped'), marketModel.noPool, marketModel.noOdds]]
                .forEach(([key, sideLabel, sidePool, odds]) => {
                    list.append(el('dt', null, sideLabel));
                    const value = el('dd');
                    value.append(el('strong', null, chance(odds)));
                    const multiple = pays(key);
                    value.append(el('span', null, [moneyAtomic(sidePool), multiple === null ? null : t('bets.row.pays', 'Pays {{multiple}}×', { multiple: multiple.toFixed(2) })].filter(Boolean).join(' · ')));
                    list.append(value);
                });
            pool.append(list);
            const lines = mineLines(row, { yes: marketModel.yesPosition, no: marketModel.noPosition });
            if (lines.length) pool.append(el('p', 'proposal-market-placed__mine', t('panel.proposal.market.yourBets', 'Your bets: {{lines}}', { lines: lines.join('; ') })));
        }).catch(error => {
            console.warn(`[${new Date().toISOString()}] [bets] pool unreadable after the bet on ${row.proposalAccount}:`, error);
            pool.remove();
        });
    }

    // ---- open ---------------------------------------------------------------------------------

    // Open the bet's dialog; with `side` (1/0 or 'yes'/'no') straight into the stake form, as the
    // Yes/No buttons on a row and the Details card do. `title`, `proposalId`, `id` describe a
    // proposal the city list may not carry yet (the Details card's own proposal).
    async function openBetDialog(options = {}) {
        const proposalAccount = options && options.proposalAccount ? String(options.proposalAccount) : null;
        if (!proposalAccount) return null;
        const side = options.side === undefined || options.side === null ? null : sideValue(options.side);
        if (side !== null && !walletConnected()) { askForWallet(); return null; }
        const overlay = mount(options.title || t('panel.proposal.market.historyBet', 'Bet'));
        state.proposalAccount = proposalAccount;
        state.row = null; state.contest = null; state.positions = null;
        showBetAddress(proposalAccount);
        const p = parts();
        p.body.append(el('p', 'bets-status', t('bets.loading', 'Loading bets…')));
        try { p.dialog.focus({ preventScroll: true }); } catch (_) { }
        const found = await loadRow(proposalAccount, options);
        if (state.overlay !== overlay) return overlay;
        state.row = found.row;
        state.contest = found.contest;
        state.positions = await loadPositions(proposalAccount) || state.positions;
        if (state.overlay !== overlay) return overlay;
        if (side !== null) renderStake(side); else renderOverview();
        return overlay;
    }

    root.openBetDialog = openBetDialog;
    root.BetsDialog = { open: openBetDialog, close, OVERLAY_ID };
})(typeof window !== 'undefined' ? window : null);
