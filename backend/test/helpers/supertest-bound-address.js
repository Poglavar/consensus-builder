// supertest connects every request to 127.0.0.1, but the server it starts listens on the wildcard [::].
// macOS lets another process (a Codex app server, a dev tool) hold 127.0.0.1 on the very port the OS
// handed to [::], and the request then reaches that process and comes back 401. Connect to the
// loopback of the family the server actually bound instead.
import { createRequire } from 'node:module';
import { Server as HttpsServer } from 'node:https';

const require = createRequire(import.meta.url);
const Test = require('supertest/lib/test.js');

Test.prototype.serverAddress = function serverAddress(app, path) {
    if (!app.address()) this._server = app.listen(0);
    const { address, port, family } = app.address();
    const ipv6 = family === 'IPv6' || family === 6 || String(address).includes(':');
    const host = ipv6 ? '[::1]' : '127.0.0.1';
    return `${app instanceof HttpsServer ? 'https' : 'http'}://${host}:${port}${path}`;
};
