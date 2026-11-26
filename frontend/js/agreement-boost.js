// Boost: support a minted agreement with devnet USDC (on chain, proposal_pledge donations: released
// to the sponsor when it executes, taken back by each donor when it is cancelled or expires) or with
// the city token / UGT (off-chain ledger: 30% sponsor, 70% parcel owners on execution, refunded
// otherwise). The agreement panel mounts it into its "On chain" section. docs/citymemetoken.md.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && root.document) root.AgreementBoost = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const records = () => root.AgreementRecord || (typeof require === 'function' ? require('./agreement-record.js') : null);

    // ---- pure model --------------------------------------------------------------------------------

    /** "12.5" → 12500000n (6 decimals); null for anything that is not a positive amount. */
    function parseAmount(text) {
        return records().parseUsdc(text);
    }

    function formatAmount(atomic) {
        return records().formatUsdc(atomic);
    }

    /**
     * What the Boost section shows for an agreement: chainStatus ('Active'|'Executed'|'Cancelled'|
     * 'Expired'), escrow (on-chain totals or null), mine (this wallet's donation positions), boosts
     * (the ledger's [{ token, symbol, status, amount, boosters }]). Returns totals and the actions offered.
     */
    function boostState({ chainStatus, escrow = null, mine = [], boosts = [] }) {
        const usdcHeld = escrow ? BigInt(escrow.totalDonated) - BigInt(escrow.totalRefunded) : 0n;
        const tokens = new Map();
        for (const row of boosts) {
            if (row.status === 'refunded') continue;
            const entry = tokens.get(row.token) || { token: row.token, symbol: row.symbol, amount: 0n, boosters: 0 };
            entry.amount += BigInt(row.amount); entry.boosters = Math.max(entry.boosters, row.boosters || 0);
            tokens.set(row.token, entry);
        }
        const refundable = mine.filter(row => !row.refunded);
        return {
            usdc: { amount: usdcHeld, donors: escrow ? Number(escrow.donorCount) : 0, released: !!escrow?.released },
            tokens: [...tokens.values()],
            canBoost: chainStatus === 'Active',
            canRelease: chainStatus === 'Executed' && !!escrow && !escrow.released && usdcHeld > 0n,
            canRefund: (chainStatus === 'Cancelled' || chainStatus === 'Expired') && refundable.length > 0,
            refundable: refundable.reduce((sum, row) => sum + BigInt(row.amount), 0n)
        };
    }

    const model = { parseAmount, formatAmount, boostState };
    if (!root || !root.document) return { model };

    // ---- browser -------------------------------------------------------------------------------------

    const doc = root.document;
    const cache = new Map();   // agreement account → { loading, error, escrow, mine, boosts, balances }
    // The last confirmed deposit in this tab survives escrow rereads and panel redraws.
    const contributionConfirmations = new Map(); // agreement account → { wallet, amount }
    const apartmentConfirmations = new Map();
    const t = (key, fallback, params = {}) => {
        const helper = typeof root.getProposalI18nHelper === 'function' ? root.getProposalI18nHelper() : null;
        const text = helper ? helper(key, fallback, params) : fallback;
        return String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
    };
    const log = (message, extra) => console.info(`[${new Date().toISOString()}] [AgreementBoost] ${message}`, extra ?? '');
    function el(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const slotOf = account => doc.querySelector(`[data-agreement-boost="${CSS.escape(account)}"]`);
    const contributionText = amount => t('agreement.funding.contributed', 'Contributed {{amount}} devnet USDC.', { amount: formatAmount(amount) });

    // A refund is possible only once the agreement is cancelled or expired: only then are this
    // wallet's own donations listed (a getProgramAccounts read the primary RPC does not serve).
    const refundable = status => status === 'Cancelled' || status === 'Expired';

    const apartmentText = (key, fallback, params) => t(`agreement.funding.apartments.${key}`, fallback, params);
    const amountOf = atomic => formatAmount(BigInt(atomic));
    const confirmationKey = (account, unitId) => `${account}:${unitId}`;
    const reservedText = unit => apartmentText('confirmedDeposit', '{{label}} reserved. Your deposit was {{amount}} devnet USDC.',
        { label: unit.label, amount: amountOf(unit.depositUsdcAtomic) });

    function actionButton(label, handler, primary = false) {
        const button = el('button', primary ? 'btn btn-primary' : 'btn btn-sm', label);
        button.type = 'button';
        button.addEventListener('click', () => handler(button));
        return button;
    }

    function downloadFile(file) {
        root.FileDownload.save(root, Uint8Array.from(root.atob(file.data), char => char.charCodeAt(0)), file.name, file.mediaType);
    }

    function unitDetails(agreement, unit) {
        const details = el('div', 'agreement-apartment-unit__details');
        details.append(el('strong', null, unit.label), el('span', 'agreement-panel-meta',
            apartmentText('priceAndDeposit', 'Price {{price}} USDC · Reservation deposit {{deposit}} USDC', {
                price: amountOf(unit.priceUsdcAtomic), deposit: amountOf(unit.depositUsdcAtomic)
            })));
        const links = el('div', 'agreement-panel-actions');
        const link = el('a', 'cb-link', apartmentText('openUnit', 'View apartment in X-ray'));
        const context = { city: agreement.city, backend: new URL(root.location.href).searchParams.get('backend'), language: root.i18n?.getLanguage?.() };
        link.href = root.BuildingUnitLinks.offerLink(root.location.href, root.MapShare, context, unit);
        link.dataset.agreementXrayUnit = unit.unitId;
        const drawing = actionButton(apartmentText('downloadDrawing', 'Download drawing ({{name}})', { name: unit.drawing.name }), () => downloadFile(unit.drawing));
        drawing.dataset.agreementDrawingUnit = unit.unitId;
        links.append(link, drawing);
        details.append(links);
        return details;
    }

    function downloadSchedule(agreement, unit, offer, buyer, signature) {
        const schedule = {
            schema: 'apartment-reservation-schedule/v1', agreementCid: agreement.published.cid,
            agreementAccount: agreement.onchain.account, cluster: agreement.onchain.cluster, planCid: agreement.plan.cid,
            developer: agreement.sponsor, projectId: agreement.funding.apartments.projectId, unit,
            targetUsdcAtomic: agreement.funding.targetUsdcAtomic, contract: agreement.funding.contract,
            termsHash: offer.termsHash, apartmentAccount: offer.account, buyer, position: offer.position,
            qualification: offer.qualification, lenses: agreement.rule.lens,
            depositPaidUsdcAtomic: unit.depositUsdcAtomic, ...(signature ? { signature } : {})
        };
        root.FileDownload.save(root, JSON.stringify(schedule, null, 2), `apartment-${unit.unitId}-contract-schedule.json`, 'application/json');
    }

    function inventoryView(slot, context, statuses = [], active = false) {
        const { agreement, account, wallet } = context;
        const wrap = el('section', 'agreement-apartment-inventory');
        wrap.append(el('h4', 'agreement-boost__title', apartmentText('inventory', 'Apartments')));
        // The chain's states, counts and per-floor stats (ApartmentRound); a draft has none yet.
        const round = root.ApartmentRound;
        const view = round.model.roundView({ cid: agreement.published?.cid || null, funding: agreement.funding,
            inventory: statuses.length ? statuses : null, accepting: active });
        const list = el('div', 'agreement-apartment-inventory__list');
        if (view.read) {
            // The Building overview: the round's apartments by floor; a cell brings its row into view.
            wrap.append(round.overviewView(round.model.overviewRows({ units: view.units }), t, { buildings: view.buildings, onPick: cell => {
                const row = list.querySelector(`[data-agreement-apartment-unit="${CSS.escape(cell.unitId)}"]`);
                const search = wrap.querySelector('[data-apartment-round-search]');
                if (row?.hidden && search) { search.value = ''; search.dispatchEvent(new Event('input')); }
                row?.focus();
            } }), round.legendView(t, { offeredOnly: true }), round.statsView(view, t));
        }
        const searchable = [];
        for (const unit of agreement.funding.apartments.units) {
            const offer = statuses.find(item => item.unitId === unit.unitId);
            const shown = view.units.find(item => item.unitId === unit.unitId);
            const row = el('article', 'agreement-apartment-unit');
            row.dataset.agreementApartmentUnit = unit.unitId;
            // Focused from the Building overview.
            row.tabIndex = -1;
            row.setAttribute('aria-label', unit.label);
            const place = el('div', 'agreement-apartment-unit__state');
            place.append(el('span', 'agreement-panel-meta', round.model.floorName(shown, 1, t)));
            if (shown.state) place.append(round.stateBadge(shown, t));
            row.append(place, unitDetails(agreement, unit));
            searchable.push({ element: row, text: round.searchText(shown, view, t) });
            const standalone = el('details');
            standalone.append(el('summary', 'cb-link', apartmentText('standalone', 'Independent offers in SOL')));
            const { xrayBuilding, at, access } = unit;
            for (const direction of ['buy', 'sell']) {
                const label = direction === 'buy' ? t('threeMode.controls.offerToBuyApartment', 'Offer to buy apartment')
                    : t('threeMode.controls.offerToSellApartment', 'Offer to sell apartment');
                standalone.append(actionButton(label, () => root.PropertyOfferDialog.open({ direction, city: agreement.city,
                    apartment: { xrayBuilding, unit: unit.unit, at, ...(access ? { access } : {}) } })));
            }
            const actions = el('div', 'agreement-panel-actions');
            if (offer?.status === 'unlisted' && active && context.isSponsor) {
                const list = actionButton(apartmentText('list', 'List apartment'), button => run(slot, button, onStatus =>
                    root.AgreementBridge.listApartment({ agreement, unitId: unit.unitId, onStatus })));
                list.dataset.agreementListUnit = unit.unitId;
                actions.append(list);
            } else if (offer?.status === 'available' && active) {
                const reserve = actionButton(apartmentText('reserve', 'Reserve apartment'), () => contribute(slot, unit), true);
                reserve.dataset.agreementReserveUnit = unit.unitId;
                actions.append(reserve);
            } else if (offer?.status === 'reserved' && offer.buyer === wallet) {
                const receipt = apartmentConfirmations.get(confirmationKey(account, unit.unitId));
                const schedule = actionButton(apartmentText('downloadSchedule', 'Download contract schedule'),
                    () => downloadSchedule(agreement, unit, offer, wallet, receipt?.payer === wallet ? receipt.signature : null));
                schedule.dataset.agreementScheduleUnit = unit.unitId;
                actions.append(schedule);
            }
            if (offer) {
                // The state is the row's badge; this line announces this wallet's own reservation.
                const mine = offer.status === 'reserved' && offer.buyer === wallet;
                const caption = el('span', 'agreement-panel-hint agreement-boost__status', mine ? reservedText(unit) : '');
                caption.setAttribute('role', 'status');
                if (mine) caption.classList.add('agreement-boost__status--success');
                actions.append(caption);
            }
            row.append(actions);
            row.append(standalone);
            list.append(row);
        }
        if (searchable.length > 1) wrap.append(round.searchField(searchable, t));
        wrap.append(list);
        return wrap;
    }

    function mountDraft(slot, agreement) {
        if (agreement.funding?.apartments) slot.replaceChildren(inventoryView(slot, { agreement }));
    }

    async function load({ agreement, account, chainStatus, wallet, crowdfunding }) {
        const entry = { wallet, chainStatus, loading: true, error: null, escrow: null, mine: [], boosts: [], balances: [] };
        cache.set(account, entry);
        try {
            const [chain, boosts, balances, inventory] = await Promise.all([
                root.AgreementBridge.donations(agreement, { mine: refundable(chainStatus) }),
                !crowdfunding && root.BetsTrading ? root.BetsTrading.agreementBoosts(account) : [],
                !crowdfunding && root.BetsTrading ? root.BetsTrading.asset() === 'points' ? root.BetsTrading.cityTokens().catch(() => null)
                    : null : null,
                agreement.funding?.apartments ? root.AgreementBridge.apartmentInventory(agreement) : []
            ]);
            Object.assign(entry, { escrow: chain.escrow, mine: chain.mine, boosts, balances: balances?.balances || [], inventory });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [AgreementBoost] reading the boosts of ${account} failed`, error);
            entry.error = error?.message || String(error);
        }
        entry.loading = false;
        const slot = slotOf(account);
        if (slot && entry === cache.get(account)) draw(slot, slot.__boostContext);
    }

    function status(slot, message, tone = '') {
        const line = slot.querySelector('[data-agreement-boost-status]');
        if (!line) return;
        line.textContent = message;
        line.className = `agreement-panel-hint agreement-boost__status${tone ? ` agreement-boost__status--${tone}` : ''}`;
    }

    const inFlight = new Set();
    async function run(slot, button, work, { feedback, signal, confirmed } = {}) {
        const context = slot.__boostContext;
        if (inFlight.has(context.account)) return false;
        inFlight.add(context.account);
        function report(message, tone) {
            const current = slotOf(context.account);
            if (current) status(current, message, tone);
            feedback?.(message, tone);
        }
        try {
            const result = await root.BusyControl.track(button, () => work(item => {
                if (item?.state === 'awaiting_signature') report(t('bets.trade.sign', 'Confirm in your wallet…'));
                else if (item?.state === 'submitted') report(t('bets.trade.submitted', 'Waiting for confirmation…'));
            }));
            confirmed?.(result);
            const current = slotOf(context.account);
            if (current) await load(current.__boostContext);
            return result || true;
        } catch (error) {
            if (signal?.aborted && error === signal.reason) { report(''); return false; }
            console.error(`[${new Date().toISOString()}] [AgreementBoost] action failed`, error);
            report(error?.message || String(error), 'danger');
            return false;
        } finally { inFlight.delete(context.account); }
    }

    // The two-step Boost dialog: which currency, then how much.
    async function boost(slot, button) {
        const { agreement, account, city } = slot.__boostContext;
        const entry = cache.get(account) || {};
        const balanceOf = token => entry.balances?.find(row => row.token === token)?.display || '0';
        const symbol = token => token.replace(/[^a-z0-9]/gi, '').toUpperCase();
        const choices = [{ value: 'usdc', label: t('agreement.boost.currencyUsdc', 'Devnet USDC · wallet'), primary: true }];
        if (root.BetsTrading?.asset() === 'points') {
            for (const token of [city, 'ugt'].filter(Boolean)) {
                choices.push({ value: token, label: t('agreement.boost.currencyToken', '{{symbol}} · you hold {{amount}}', { symbol: symbol(token), amount: balanceOf(token) }) });
            }
        }
        const currency = await root.CbDialog.choice(t('agreement.boost.chooseCurrency', 'Boost with what? USDC goes to the sponsor when the agreement executes; city tokens go 30% to the sponsor and 70% to the parcel owners. Either comes back if it is cancelled or expires.'),
            choices, { title: t('agreement.boost.title', 'Boost') });
        if (!currency) return;
        const unit = currency === 'usdc' ? 'USDC' : symbol(currency);
        const answer = await root.CbDialog.prompt(t('agreement.boost.amountPrompt', 'How much {{unit}}?', { unit }), {
            title: t('agreement.boost.title', 'Boost'), okText: t('agreement.boost.title', 'Boost'), placeholder: '10',
            validate: text => parseAmount(text) !== null
        });
        if (answer === null) return;
        const amount = parseAmount(answer);
        await run(slot, button, async onStatus => {
            if (currency === 'usdc') await root.AgreementBridge.donate({ agreement, amountAtomic: amount, onStatus });
            else await root.BetsTrading.boostCityToken({ agreementAccount: account, token: currency, amount, onStatus });
            log(`boosted ${account} with ${formatAmount(amount)} ${unit}`);
        });
        const current = slotOf(account);
        if (current && !current.querySelector('.agreement-boost__status--danger')) status(current, t('agreement.boost.done', 'Boosted with {{amount}} {{unit}}.', { amount: formatAmount(amount), unit }), 'success');
    }

    async function contribute(slot, unit = null) {
        const { agreement, account } = slot.__boostContext;
        const label = unit ? apartmentText('reserve', 'Reserve apartment') : t('agreement.funding.contribute', 'Contribute');
        const text = t('agreement.funding.amount', 'How much devnet USDC will you contribute under {{name}}?', { name: agreement.funding.contract.name });
        const intent = root.ApprovalLink?.parse(root.location);
        const field = el('label', null, text);
        const input = el('input', 'cb-dialog__prompt');
        input.type = 'text'; input.inputMode = 'decimal'; input.placeholder = '10';
        if (intent?.action === 'donate' && intent.target === agreement.published?.cid && parseAmount(intent.params.amount) !== null) input.value = intent.params.amount;
        field.append(input);

        const walletLine = el('p', 'agreement-panel-hint');
        walletLine.setAttribute('role', 'status');
        const requirements = el('p', 'agreement-panel-hint', t('agreement.funding.walletRequirements',
            'Your wallet needs devnet USDC for the contribution and devnet SOL for fees and account creation.'));
        const faucets = el('p', 'cb-link-row');
        for (const [href, key, fallback] of [
            ['https://faucet.solana.com/', 'bets.trade.solFaucet', 'Get devnet SOL'],
            ['https://faucet.circle.com/', 'bets.trade.usdcFaucet', 'Get devnet USDC']
        ]) {
            const link = el('a', 'cb-link cb-link--external', t(key, fallback));
            link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; faucets.append(link);
        }
        const notice = el('p', 'agreement-panel-hint agreement-boost__status');
        notice.setAttribute('role', 'status');
        function feedback(message, tone) {
            notice.classList.toggle('agreement-boost__status--danger', tone === 'danger');
            notice.textContent = message;
        }
        const connect = t('wallet.connect', 'Connect wallet');
        const controller = new AbortController();
        const review = unit ? [unitDetails(agreement, unit), actionButton(t('agreement.funding.download', 'Download investor contract ({{name}})', { name: agreement.funding.contract.name }),
            () => downloadFile(agreement.funding.contract))] : [field];
        if (unit) {
            review.push(el('p', 'sheet-note', apartmentText('qualificationHint', 'The developer’s lens must qualify your wallet for this apartment before your deposit can reserve it.')));
            const request = actionButton(apartmentText('copyQualification', 'Copy qualification request'), button => root.BusyControl.track(button, async () => {
                const buyer = root.AgreementBridge.connectedWallet();
                if (!buyer) { feedback(t('agreement.chain.errors.walletRequired', 'Connect a Solana wallet first.')); return; }
                const data = { agreement: agreement.published.cid, unitId: unit.unitId, apartment: unit.label,
                    xrayBuilding: unit.xrayBuilding, unit: unit.unit, buyer, developer: agreement.sponsor, lenses: agreement.rule.lens };
                const copied = await root.copyTextWithFeedback(JSON.stringify(data, null, 2));
                feedback(copied ? t('common.copied', 'Copied') : t('chat.copyFailed', 'Could not copy the text.'), copied ? undefined : 'danger');
            }).catch(error => feedback(error.message, 'danger')));
            review.push(request);
        }
        const dialog = root.CbDialog.open({
            title: unit ? apartmentText('reviewTitle', 'Review apartment reservation') : label,
            size: 'sm', className: 'cb-dialog--prompt', initialFocus: unit ? undefined : input,
            body: [...review, walletLine, requirements, faucets, notice], onClose: () => controller.abort(),
            actions: [
                { id: 'cancel', label: t('common.cancel', 'Cancel') },
                { id: 'ok', label: connect, role: 'primary', keepOpen: true, onClick: proceed }
            ]
        });
        const primary = dialog.getActionButton('ok');
        let displayedAddress;
        const amount = () => unit ? BigInt(unit.depositUsdcAtomic) : parseAmount(input.value);
        function restoreFocus() {
            const selector = unit ? `[data-agreement-schedule-unit="${unit.unitId}"],[data-agreement-reserve-unit="${unit.unitId}"]` : '[data-agreement-boost-action="boost"]';
            if (doc.activeElement === doc.body) slotOf(account)?.querySelector(selector)?.focus({ preventScroll: true });
        }
        function update() {
            const address = root.AgreementBridge.connectedWallet();
            primary.disabled = root.BusyControl.isBusy(primary) || (!!address && amount() === null);
            if (address !== displayedAddress) {
                displayedAddress = address;
                primary.textContent = address ? label : connect;
                walletLine.hidden = !address;
                walletLine.textContent = address ? t('wallet.connectedTitle', 'Connected wallet: {{account}}', { account: address }) : '';
                feedback('');
            }
        }
        async function proceed() {
            if (root.BusyControl.isBusy(primary)) return;
            if (!slotOf(account)) { dialog.close(); return; }
            // If the provider changed accounts in its extension, show the new payer for review.
            if (root.AgreementBridge.connectedWallet() !== displayedAddress) { update(); return; }
            feedback('');
            if (!displayedAddress) {
                try {
                    await root.BusyControl.track(primary, () => root.walletManager.openConnectorModal({ chain: 'solana' })?.dialog.closed);
                } catch (error) { feedback(error.message, 'danger'); }
                update();
                if (dialog.overlay.isConnected && doc.activeElement === doc.body) (primary.disabled ? input : primary).focus({ preventScroll: true });
                return;
            }
            const amountAtomic = amount();
            if (amountAtomic === null) return;
            const payer = displayedAddress;
            contributionConfirmations.delete(account);
            input.readOnly = true;
            primary.disabled = true;
            const { signal } = controller;
            const ok = await run(slot, primary, report => {
                const onStatus = item => {
                    if (item.state === 'submitted') dialog.getActionButton('cancel').textContent = t('modal.common.close', 'Close');
                    report(item);
                };
                return unit ? root.AgreementBridge.reserveApartment({ agreement, unitId: unit.unitId, expectedBuyer: payer, signal, onStatus })
                    : root.AgreementBridge.donate({ agreement, amountAtomic, signal, onStatus });
            }, {
                feedback, signal,
                confirmed(receipt) {
                    if (unit) apartmentConfirmations.set(confirmationKey(account, unit.unitId), { payer, signature: receipt.signature });
                    else contributionConfirmations.set(account, { wallet: payer, amount: amountAtomic });
                    const current = root.AgreementBridge.connectedWallet() === payer && slotOf(account);
                    dialog.close();
                    if (!current) return;
                    const message = unit ? reservedText(unit) : contributionText(amountAtomic);
                    const offered = unit && current.querySelector(`[data-agreement-apartment-unit="${unit.unitId}"] [role="status"]`);
                    if (offered) {
                        offered.textContent = message;
                        offered.classList.add('agreement-boost__status--success');
                    } else status(current, message, 'success');
                    if (current.getClientRects().length && !root.ModalEscape?.topmost()) {
                        restoreFocus();
                        const title = unit ? apartmentText('confirmed', 'Apartment reserved') : t('agreement.funding.confirmed', 'Contribution confirmed');
                        root.CbDialog.alert(message, { title }).then(restoreFocus);
                    }
                }
            });
            if (!ok) {
                input.readOnly = false;
                update();
                if (dialog.overlay.isConnected && doc.activeElement === doc.body) (unit ? primary : input).focus({ preventScroll: true });
            }
        }
        update();
        const unsubscribe = root.solanaWalletManager.on('stateChanged', update);
        input.addEventListener('input', () => { feedback(''); update(); });
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); primary.click(); }
        });
        await dialog.closed;
        unsubscribe();
        restoreFocus();
    }

    function draw(slot, context) {
        slot.__boostContext = context;
        const entry = cache.get(context.account);
        const crowdfunding = context.crowdfunding;
        const active = doc.activeElement;
        const focusKey = slot.contains(active) && ['data-agreement-boost-action', 'data-agreement-list-unit', 'data-agreement-reserve-unit',
            'data-agreement-schedule-unit', 'data-agreement-xray-unit', 'data-agreement-drawing-unit', 'data-apartment-round-search',
            'data-apartment-overview-cell', 'data-agreement-apartment-unit'].find(key => active.hasAttribute(key));
        const query = slot.querySelector('[data-apartment-round-search]')?.value || '';
        const focusSelector = focusKey && `[${focusKey}="${CSS.escape(active.getAttribute(focusKey))}"]`;
        const section = el('div', 'agreement-boost');
        if (!crowdfunding) section.append(el('h4', 'agreement-boost__title', t('agreement.boost.title', 'Boost')));
        if (!entry || entry.loading || entry.error) context.onFundingTotal?.(null);
        if (!entry || entry.loading) {
            section.append(el('p', 'agreement-panel-hint', crowdfunding ? t('agreement.funding.reading', 'Reading contributions…') : t('agreement.boost.reading', 'Reading boosts…')));
        } else if (entry.error) {
            section.append(el('p', 'agreement-panel-note agreement-panel-note--danger', crowdfunding ? entry.error : t('agreement.boost.readFailed', 'Boosts could not be read: {{reason}}', { reason: entry.error })));
        } else {
            const state = boostState({ chainStatus: context.chainStatus, escrow: entry.escrow, mine: entry.mine, boosts: entry.boosts });
            const accepting = state.canBoost && Math.floor(Date.now() / 1000) <= Math.floor(Date.parse(context.agreement.deadline) / 1000);
            const apartments = context.agreement.funding?.apartments;
            if (crowdfunding) {
                const raised = apartments ? root.ApartmentRound.model.roundView({ funding: context.agreement.funding, inventory: entry.inventory }).reservedDeposits
                    : state.usdc.amount;
                context.onFundingTotal?.(raised, state.usdc.released);
                if (apartments) section.append(inventoryView(slot, context, entry.inventory, accepting));
            } else {
                const facts = el('dl', 'agreement-panel-facts');
                const fact = (label, value) => { const row = el('div'); row.append(el('dt', null, label), el('dd', null, value)); facts.append(row); };
                fact('USDC', state.usdc.amount > 0n
                    ? t('agreement.boost.usdcTotal', '{{amount}} from {{count}} supporter(s){{released}}', { amount: formatAmount(state.usdc.amount), count: state.usdc.donors,
                        released: state.usdc.released ? t('agreement.boost.releasedSuffix', ', released to the sponsor') : '' })
                    : t('agreement.boost.none', 'None yet'));
                state.tokens.forEach(row => fact(row.symbol, t('agreement.boost.tokenTotal', '{{amount}} from {{count}} supporter(s)', { amount: formatAmount(row.amount), count: row.boosters })));
                section.append(facts);
            }
            const actions = el('div', 'agreement-panel-actions');
            const add = (action, icon, label, handler, primary = false) => {
                const button = el('button', `btn${primary ? ' btn-primary' : ''}`);
                button.type = 'button'; button.dataset.agreementBoostAction = action;
                const glyph = el('i', icon); glyph.setAttribute('aria-hidden', 'true');
                button.append(glyph, doc.createTextNode(` ${label}`));
                button.addEventListener('click', () => handler(slot, button));
                actions.append(button);
            };
            if (crowdfunding && !apartments && accepting) {
                add('boost', 'fas fa-coins', t('agreement.funding.contribute', 'Contribute'), s => contribute(s), true);
            } else if (!crowdfunding && state.canBoost) add('boost', 'fas fa-rocket', t('agreement.boost.title', 'Boost'), boost, true);
            if (state.canRelease) add('release', 'fas fa-hand-holding-dollar', crowdfunding ? t('agreement.funding.release', 'Release USDC to the developer') : t('agreement.boost.release', 'Release USDC boosts to the sponsor'),
                (s, b) => run(s, b, onStatus => root.AgreementBridge.releaseDonations({ agreement: context.agreement, onStatus })));
            if (state.canRefund) {
                const batchSize = root.AgreementBridge.MAX_REFUNDS_PER_TX;
                const count = entry.mine.filter(item => !item.refunded).length;
                const label = crowdfunding && count > batchSize ? t('agreement.funding.refundBatch', 'Reclaim {{batch}} of {{count}} contributions', { batch: batchSize, count })
                    : t('agreement.boost.refund', 'Take back my {{amount}} USDC', { amount: formatAmount(state.refundable) });
                add('refund', 'fas fa-rotate-left', label, (s, b) => run(s, b, onStatus => root.AgreementBridge.refundDonations({ agreement: context.agreement, onStatus })));
            }
            if (actions.childElementCount) section.append(actions);
            if (state.canBoost) section.append(el('p', 'agreement-panel-hint', crowdfunding ? t('agreement.funding.settlement', 'Execution unlocks contributions for the developer. Cancellation or expiry lets each investor reclaim their USDC.')
                : t('agreement.boost.rule', 'City-token boosts settle when the agreement ends: 30% to the sponsor and 70% to the parcel owners if it executes, back to you if not.')));
        }
        const line = el('p', 'agreement-panel-hint agreement-boost__status'); line.dataset.agreementBoostStatus = ''; line.setAttribute('role', 'status'); line.setAttribute('aria-live', 'polite');
        const confirmation = contributionConfirmations.get(context.account);
        if (crowdfunding && confirmation && confirmation.wallet === context.wallet) {
            line.textContent = contributionText(confirmation.amount);
            line.classList.add('agreement-boost__status--success');
        }
        const contributeButton = crowdfunding && section.querySelector('[data-agreement-boost-action="boost"]');
        if (contributeButton) contributeButton.after(line);
        else section.append(line);
        slot.replaceChildren(section);
        const search = query && slot.querySelector('[data-apartment-round-search]');
        if (search) { search.value = query; search.dispatchEvent(new Event('input')); }
        // A donate approval link may have opened the agreement before this lazy module loaded.
        // This is presentation readiness only; ApprovalLink focuses the button and never clicks it.
        doc.dispatchEvent(new CustomEvent('agreement-boost-ready', { detail: { cid: context.agreement?.published?.cid || context.agreement?.cid || null } }));
        if (focusSelector) slot.querySelector(focusSelector)?.focus({ preventScroll: true });
    }

    /** Draw into the panel's slot from the cache, reading the boosts when there are none yet. */
    function mount(slot, { agreement, chainStatus, onFundingTotal }) {
        const account = root.AgreementBridge.onchainRef(agreement)?.account;
        if (!slot || !account) return;
        slot.dataset.agreementBoost = account;
        const wallet = root.AgreementBridge.connectedWallet?.() || null;
        const sponsor = agreement.published?.sponsor || agreement.sponsor;
        const context = { agreement, account, chainStatus, wallet, crowdfunding: agreement.rule?.electorate === 'investors', city: agreement.city || null,
            isSponsor: !!wallet && !!sponsor && wallet === sponsor, onFundingTotal };
        const previous = cache.get(account);
        if (!previous || previous.wallet !== wallet || previous.chainStatus !== chainStatus) load(context);
        draw(slot, context);
    }

    return { model, mount, mountDraft, refresh: account => cache.delete(account) };
});
