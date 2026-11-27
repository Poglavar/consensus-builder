// OpenStreetMap account: "Sign in with OpenStreetMap" (OAuth 2.0 with PKCE, in the browser, no server
// of ours), so a person can save building facts to OSM as their own edit (osm/osm-edit.js). The app
// is registered on openstreetmap.org as a public client with the read_prefs and write_api scopes; the
// token stays in this browser and the person can revoke it in their OSM settings.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OsmAccount = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const SITE = 'https://www.openstreetmap.org';
    const API = 'https://api.openstreetmap.org';
    const CLIENT_ID = 't40Lq_4szAR12SnB1nUYNR96fNMrJ39I87zg3gJMedo';
    const SCOPE = 'read_prefs write_api';
    // Redirect URIs registered with the app; OSM accepts plain http only for 127.0.0.1.
    const REGISTERED = ['https://urbangametheory.xyz', 'http://127.0.0.1:5611'];
    const TOKEN_KEY = 'cb_osm_token';
    const USER_KEY = 'cb_osm_user';
    const MESSAGE = 'cb-osm-auth';

    // Where OSM sends the person back: our callback page on a registered origin; any other local
    // origin gets its own (OSM refuses it unless registered, with its own error page); else none.
    function redirectUri(location = root.location) {
        if (!location) return null;
        const local = ['localhost', '127.0.0.1'].includes(location.hostname);
        return REGISTERED.includes(location.origin) || local ? `${location.origin}/osm-callback.html` : null;
    }

    const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    function randomString(cryptoApi = root.crypto) {
        return base64url(cryptoApi.getRandomValues(new Uint8Array(32)));
    }
    async function challengeOf(verifier, cryptoApi = root.crypto) {
        return base64url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    }
    function authorizeUrl({ redirect, state, challenge }) {
        const query = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirect, scope: SCOPE,
            state, code_challenge: challenge, code_challenge_method: 'S256' });
        return `${SITE}/oauth2/authorize?${query}`;
    }

    const storage = () => root.localStorage;
    const token = () => storage()?.getItem(TOKEN_KEY) || null;
    function user() {
        try { return JSON.parse(storage()?.getItem(USER_KEY) || 'null'); } catch { return null; }
    }
    function signOut() {
        storage()?.removeItem(TOKEN_KEY);
        storage()?.removeItem(USER_KEY);
    }

    // The OSM account behind a token: { id, name }.
    async function readUser(accessToken, fetchFn = root.fetch.bind(root)) {
        const response = await fetchFn(`${API}/api/0.6/user/details.json`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!response.ok) throw new Error(`OpenStreetMap account HTTP ${response.status}`);
        const { user: details } = await response.json();
        return { id: details.id, name: details.display_name };
    }

    // Opens OSM's sign-in in a popup (call it from the click, so the popup is not blocked), waits for
    // the callback page's answer, trades the code for a token and remembers the account.
    // openstreetmap.org sends Cross-Origin-Opener-Policy: same-origin, which cuts the popup off from
    // this page (no window.opener, and popup.closed reads true), so the callback page answers on a
    // same-origin BroadcastChannel instead. Resolves { id, name }; rejects when the person declines,
    // or after `timeoutMs` without an answer (a closed popup sends none).
    async function signIn({ open = (url, name, features) => root.open(url, name, features), fetchFn = root.fetch.bind(root),
        channel = () => new root.BroadcastChannel(MESSAGE), timeoutMs = 5 * 60_000 } = {}) {
        const redirect = redirectUri();
        if (!redirect) throw new Error('Signing in with OpenStreetMap is not available on this site.');
        const popup = open('about:blank', 'cb-osm-sign-in', 'popup,width=560,height=720');
        if (!popup) throw new Error('The sign-in window was blocked: allow pop-ups for this site and try again.');
        const verifier = randomString(), state = randomString();
        const answers = channel();
        const answered = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { answers.close(); reject(new Error('Signing in did not finish: try again.')); }, timeoutMs);
            answers.onmessage = event => {
                if (event.data?.type !== MESSAGE || event.data.state !== state) return;
                clearTimeout(timer);
                answers.close();
                if (event.data.error) reject(new Error(`OpenStreetMap: ${event.data.error}`));
                else resolve(event.data.code);
            };
        });
        popup.location.href = authorizeUrl({ redirect, state, challenge: await challengeOf(verifier) });
        const code = await answered;
        const response = await fetchFn(`${SITE}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: CLIENT_ID, code_verifier: verifier }) });
        if (!response.ok) throw new Error(`OpenStreetMap sign-in HTTP ${response.status}`);
        const { access_token: accessToken } = await response.json();
        const account = await readUser(accessToken, fetchFn);
        storage().setItem(TOKEN_KEY, accessToken);
        storage().setItem(USER_KEY, JSON.stringify(account));
        return account;
    }

    return { SITE, API, CLIENT_ID, SCOPE, MESSAGE, redirectUri, randomString, challengeOf, authorizeUrl, token, user, signIn, signOut, readUser };
});
