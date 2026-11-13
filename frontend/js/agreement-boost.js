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

    const DECIMALS = 6;
    const ONE = 10n ** BigInt(DECIMALS);

    // ---- pure model --------------------------------------------------------------------------------

    /** "12.5" → 12500000n (6 decimals); null for anything that is not a positive amount. */
    function parseAmount(text) {
        const value = String(text ?? '').trim().replace(',', '.');
        if (!/^\d+(\.\d{1,6})?$/.test(value)) return null;
        const [whole, fraction = ''] = value.split('.');
        const atomic = BigInt(whole) * ONE + BigInt(fraction.padEnd(DECIMALS, '0'));
        return atomic > 0n ? atomic : null;
    }

    function formatAmount(atomic) {
        const value = BigInt(atomic);
        const fraction = (value % ONE).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
        return fraction ? `${value / ONE}.${fraction}` : String(value / ONE);
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

    async function load(agreement, account) {
        const entry = { loading: true, error: null, escrow: null, mine: [], boosts: [], balances: [] };
        cache.set(account, entry);
        try {
            const [chain, boosts, balances] = await Promise.all([
                root.AgreementBridge.donations(agreement),
                root.BetsTrading ? root.BetsTrading.agreementBoosts(account) : [],
                root.BetsTrading ? root.BetsTrading.asset() === 'points' ? root.BetsTrading.cityTokens().catch(() => null)
                    : null : null
            ]);
            Object.assign(entry, { escrow: chain.escrow, mine: chain.mine, boosts, balances: balances?.balances || [] });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [AgreementBoost] reading the boosts of ${account} failed`, error);
            entry.error = error?.message || String(error);
        }
        entry.loading = false;
        const slot = slotOf(account);
        if (slot) draw(slot, slot.__boostContext);
    }

    function status(slot, message, tone = '') {
        const line = slot.querySelector('[data-agreement-boost-status]');
        if (!line) return;
        line.textContent = message;
        line.className = `agreement-panel-hint agreement-boost__status${tone ? ` agreement-boost__status--${tone}` : ''}`;
    }

    async function run(slot, button, work) {
        const context = slot.__boostContext;
        try {
            await root.BusyControl.track(button, () => work(item => {
                if (item?.state === 'awaiting_signature') status(slot, t('bets.trade.sign', 'Confirm in your wallet…'));
                else if (item?.state === 'submitted') status(slot, t('bets.trade.submitted', 'Waiting for confirmation…'));
            }));
            await load(context.agreement, context.account);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [AgreementBoost] action failed`, error);
            const current = slotOf(context.account);
            if (current) status(current, error?.message || String(error), 'danger');
        }
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

    function draw(slot, context) {
        slot.__boostContext = context;
        const entry = cache.get(context.account);
        const section = el('div', 'agreement-boost');
        section.append(el('h4', 'agreement-boost__title', t('agreement.boost.title', 'Boost')));
        if (!entry || entry.loading) {
            section.append(el('p', 'agreement-panel-hint', t('agreement.boost.reading', 'Reading boosts…')));
        } else if (entry.error) {
            section.append(el('p', 'agreement-panel-note agreement-panel-note--danger', t('agreement.boost.readFailed', 'Boosts could not be read: {{reason}}', { reason: entry.error })));
        } else {
            const state = boostState({ chainStatus: context.chainStatus, escrow: entry.escrow, mine: entry.mine, boosts: entry.boosts });
            const facts = el('dl', 'agreement-panel-facts');
            const fact = (label, value) => { const row = el('div'); row.append(el('dt', null, label), el('dd', null, value)); facts.append(row); };
            fact('USDC', state.usdc.amount > 0n
                ? t('agreement.boost.usdcTotal', '{{amount}} from {{count}} supporter(s){{released}}', { amount: formatAmount(state.usdc.amount), count: state.usdc.donors,
                    released: state.usdc.released ? t('agreement.boost.releasedSuffix', ', released to the sponsor') : '' })
                : t('agreement.boost.none', 'None yet'));
            state.tokens.forEach(row => fact(row.symbol, t('agreement.boost.tokenTotal', '{{amount}} from {{count}} supporter(s)', { amount: formatAmount(row.amount), count: row.boosters })));
            section.append(facts);
            const actions = el('div', 'agreement-panel-actions');
            const add = (action, icon, label, handler, primary = false) => {
                const button = el('button', `btn${primary ? ' btn-primary' : ''}`);
                button.type = 'button'; button.dataset.agreementBoostAction = action;
                const glyph = el('i', icon); glyph.setAttribute('aria-hidden', 'true');
                button.append(glyph, doc.createTextNode(` ${label}`));
                button.addEventListener('click', () => handler(slot, button));
                actions.append(button);
            };
            if (state.canBoost) add('boost', 'fas fa-rocket', t('agreement.boost.title', 'Boost'), boost, true);
            if (state.canRelease) add('release', 'fas fa-hand-holding-dollar', t('agreement.boost.release', 'Release USDC boosts to the sponsor'),
                (s, b) => run(s, b, onStatus => root.AgreementBridge.releaseDonations({ agreement: context.agreement, onStatus })));
            if (state.canRefund) add('refund', 'fas fa-rotate-left', t('agreement.boost.refund', 'Take back my {{amount}} USDC', { amount: formatAmount(state.refundable) }),
                (s, b) => run(s, b, onStatus => root.AgreementBridge.refundDonations({ agreement: context.agreement, onStatus })));
            if (actions.childElementCount) section.append(actions);
            if (state.canBoost) section.append(el('p', 'agreement-panel-hint', t('agreement.boost.rule', 'City-token boosts settle when the agreement ends: 30% to the sponsor and 70% to the parcel owners if it executes, back to you if not.')));
        }
        const line = el('p', 'agreement-panel-hint agreement-boost__status'); line.dataset.agreementBoostStatus = ''; line.setAttribute('role', 'status'); line.setAttribute('aria-live', 'polite');
        section.append(line);
        slot.replaceChildren(section);
    }

    /** Draw into the panel's slot from the cache, reading the boosts when there are none yet. */
    function mount(slot, { agreement, chainStatus }) {
        const account = root.AgreementBridge.onchainRef(agreement)?.account;
        if (!slot || !account) return;
        slot.dataset.agreementBoost = account;
        const context = { agreement, account, chainStatus, city: agreement.city || null };
        draw(slot, context);
        if (!cache.has(account)) load(agreement, account);
    }

    return { model, mount, refresh: account => cache.delete(account) };
});
