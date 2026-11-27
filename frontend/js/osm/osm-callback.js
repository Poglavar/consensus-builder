// OpenStreetMap sign-in callback (osm-callback.html): passes the code, or OSM's error, to the app page
// waiting in osm/osm-account.js over a same-origin BroadcastChannel (OSM's opener policy leaves this
// window no opener), then closes the window.
(function () {
    'use strict';
    const query = new URLSearchParams(location.search);
    const answer = { type: 'cb-osm-auth', state: query.get('state'), code: query.get('code'),
        error: query.get('error') ? query.get('error_description') || query.get('error') : null };
    const status = document.getElementById('osm-callback-status');
    if (!answer.state || (!answer.code && !answer.error)) {
        status.textContent = 'This page finishes signing in with OpenStreetMap; open it from the app.';
        return;
    }
    const channel = new BroadcastChannel('cb-osm-auth');
    channel.postMessage(answer);
    channel.close();
    status.textContent = answer.error ? `OpenStreetMap did not sign you in: ${answer.error}. You can close this window.` : 'Signed in. You can close this window.';
    window.close();
})();
