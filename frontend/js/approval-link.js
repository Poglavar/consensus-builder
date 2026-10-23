// Wallet approval links are validated navigation intents: parsing or selecting one never signs.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ApprovalLink = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const CID = /^baf(?:krei|ybei)[a-z2-7]{52}$/;
    const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const ACTIONS = ['mint', 'fund', 'decide', 'execute', 'cancel', 'expire', 'bet', 'pledge', 'donate'];
    const AMOUNT = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;
    function validate({ action, target, params = {} } = {}) {
        if (['pledge', 'donate'].includes(action)) throw Object.assign(new Error('The app has no pledge or donation wallet form yet; use the local signing tool.'), { code: 'approval-unavailable', next: { tool: action === 'pledge' ? 'ugt_pledge' : 'ugt_donate', action: 'Use an operator-controlled local devnet wallet, or choose a supported app action.' } });
        if (action === 'decide' && params.decision === 'reject') throw new Error('Owner decisions currently accept or withdraw acceptance; rejection is not a signed decision in the current contract');
        if (!ACTIONS.includes(action)) throw new Error('Unknown approval action');
        if (!(action === 'bet' ? ACCOUNT : CID).test(target)) throw new Error('Approval target must be an agreement CID, or a chain account for bet');
        if (params.amount != null && (!['fund', 'bet', 'pledge', 'donate'].includes(action) || !(action === 'fund' ? /^(?:0|[1-9]\d{0,8})(?:\.\d{1,9})?$/ : AMOUNT).test(String(params.amount)) || Number(params.amount) <= 0)) throw new Error('Approval amount must be a positive decimal with at most six places');
        if (params.side != null && (action !== 'bet' || !['yes', 'no'].includes(params.side))) throw new Error('Bet side must be yes or no');
        if (params.decision != null && (action !== 'decide' || !['accept', 'reject'].includes(params.decision))) throw new Error('Owner decision must be accept or reject');
        if (Object.keys(params).some(key => !['amount', 'side', 'decision', 'city'].includes(key))) throw new Error('Unknown approval parameter');
        if (params.city != null && !/^[a-z][a-z0-9_-]{0,79}$/.test(params.city)) throw new Error('Invalid city');
        return { action, target, params: { ...params } };
    }
    function build({ origin = '', ...intent } = {}) {
        const { action, target, params } = validate(intent);
        const query = new URLSearchParams({ act: action });
        for (const [key, value] of Object.entries(params)) if (value != null) query.set(key, String(value));
        return `${origin.replace(/\/+$/, '')}/${action === 'bet' ? 'bets' : 'agreements'}/${target}?${query}`;
    }
    function parse(loc) {
        const params = new URLSearchParams(loc.search || '');
        const match = String(loc.pathname || '').match(/^\/(agreements|bets)\/([^/]+)\/?$/);
        const action = params.get('act');
        if (!action) return null;
        const target = match?.[2] || params.get('bets');
        if (!target || (action === 'bet') !== (match?.[1] === 'bets' || params.has('bets'))) return null;
        const values = {};
        for (const key of ['amount', 'side', 'decision', 'city']) if (params.has(key)) values[key] = params.get(key);
        try { return validate({ action, target, params: values }); } catch (_) { return null; }
    }
    // Presentation only: focus an existing, enabled action; no click or wallet call is made.
    function preselect(container, intent) {
        if (!container || !intent) return false;
        const selector = intent.action === 'decide' ? '[data-approval-action="review"]' : `[data-agreement-action="${intent.action}"]`;
        const button = container.querySelector(selector);
        if (!button) return false;
        button.setAttribute('data-approval-selected', 'true');
        if (!button.disabled) button.focus({ preventScroll: true });
        return true;
    }
    return { ACTIONS, validate, build, parse, preselect };
});
