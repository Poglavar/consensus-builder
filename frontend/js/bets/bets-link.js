// Links to one agreement's bet, named by the agreement's chain account (the market's subject). The
// shareable form is /bets/<account>?city=<id>: the server answers it with a link preview
// (backend/routes/bets-share.js) and sends the browser on to the app form, /?city=<id>&bets=<account>,
// which opens the bet's dialog. Without the server in front, the app reads the path form itself.
// Pure: parsing and building only, shared by the sheet, the bet receipt and the server route.
(function attachBetsLink(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BetsLink = api;
})(typeof window !== 'undefined' ? window : globalThis, function betsLinkFactory() {
    'use strict';

    const PARAM = 'bets';
    const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;   // a base58 Solana account
    const PATH = /^\/bets\/([^/?#]+)\/?$/;
    const CITY = /^[a-z0-9_-]{1,40}$/i;                 // a city id or its short code
    const LANG = /^[a-z]{2}(-[a-z]{2})?$/i;

    function accountOf(value) {
        const text = String(value ?? '').trim();
        return ACCOUNT.test(text) ? text : null;
    }

    function cityOf(value) {
        const text = String(value ?? '').trim();
        return CITY.test(text) ? text : null;
    }

    function langOf(value) {
        const text = String(value ?? '').trim();
        return LANG.test(text) ? text : null;
    }

    function paramsOf(search) {
        try { return new URLSearchParams(String(search || '')); } catch (_) { return new URLSearchParams(); }
    }

    // What a location names: the agreement account from /bets/<account> or ?bets=<account>, with the
    // city and language the link carried. null when the location is not a bet link.
    function parse(loc) {
        const pathname = String((loc && loc.pathname) || '');
        const params = paramsOf(loc && loc.search);
        const fromPath = pathname.match(PATH);
        let raw = params.get(PARAM);
        if (fromPath) {
            try { raw = decodeURIComponent(fromPath[1]); } catch (_) { raw = fromPath[1]; }
        }
        const account = accountOf(raw);
        if (!account) return null;
        const codec = globalThis.ApprovalLink || (typeof require === 'function' ? require('../approval-link.js') : null);
        const intent = codec ? codec.parse(loc) : null;
        return { account, city: cityOf(params.get('city')), lang: langOf(params.get('lang')), ...(intent ? { approval: intent } : {}) };
    }

    function query(entries) {
        const params = new URLSearchParams();
        entries.forEach(([key, value]) => { if (value) params.set(key, value); });
        const text = params.toString();
        return text ? `?${text}` : '';
    }

    // The shareable link: /bets/<account>?city=<id>[&lang=<xx>] on the given origin.
    function build({ origin = '', city, account, lang } = {}) {
        const subject = accountOf(account);
        if (!subject) throw new Error('A bet link needs the Solana account of a minted agreement');
        return `${String(origin).replace(/\/+$/, '')}/bets/${subject}${query([['city', cityOf(city)], ['lang', langOf(lang)]])}`;
    }

    // The app form the server sends a browser to: /?city=<id>&bets=<account>[&lang=<xx>]. Without an
    // account it is the plain city link, for an account nobody has minted.
    function appHref({ city, account, lang, approval = null } = {}) {
        return `/${query([['city', cityOf(city)], [PARAM, accountOf(account)], ['lang', langOf(lang)], ...(approval ? [['act', 'bet'], ['side', approval.params.side], ['amount', approval.params.amount]] : [])])}`;
    }

    return { PARAM, accountOf, cityOf, parse, build, appHref };
});
