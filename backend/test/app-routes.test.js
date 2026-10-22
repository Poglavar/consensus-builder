// App routes: which paths the browser app answers, the noindex marking of unknown ones, and that
// every router's path prefix and nginx's file rule agree with that list.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAppPath, markUnknownPath } = require('../../frontend/js/app-routes.js');
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Published designs and agreements are linked by CID (plan-design-agreement.md M2).
const DESIGN = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const AGREEMENT = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const appPaths = [
    '/', '/index.html', '/proposals', `/designs/${DESIGN}`, `/designs/${DESIGN},${AGREEMENT}`, `/agreements/${AGREEMENT}`,
    '/parcel/HR-335533-2895',
    '/bets/5x8hiYo9V6kWpG8eVoyXZf4BHXnKSoCP3r7r3PyMBg4z', '/monitors/3', `/designs/${DESIGN}/monitors/12/`
];

describe('isAppPath', () => {
    it.each(appPaths)('%s is an app path', (path) => {
        expect(isAppPath(path)).toBe(true);
    });

    // Row ids, named plans and their scores are gone with the server's proposal writes (M2), and the
    // on-chain proposal location /proposals/<chain>/<id>/<contract>/<token> with the proposal mint (M3).
    it.each(['/foo', '/how-to-use', '/plans', '/plans/borovje', '/plans/borovje/score', '/proposals/879', '/proposals/12,13',
        '/proposals/borovje-v3', '/proposals/solana/devnet/abc/7', '/proposals/evm/84532/0xabc/5',
        '/designs', '/agreements', '/parcel', '/monitors', '/admin/login', '/proposalsx'])('%s is not', (path) => {
        expect(isAppPath(path)).toBe(false);
    });
});

describe('markUnknownPath', () => {
    const fakeDoc = () => {
        const head = { children: [], appendChild(node) { this.children.push(node); } };
        return { head, createElement: () => ({}) };
    };

    it('adds noindex and notifies once for an unknown path', () => {
        const doc = fakeDoc();
        let notices = 0;
        expect(markUnknownPath({ doc, pathname: '/districts/4', notify: () => notices++ })).toBe(true);
        expect(doc.head.children).toEqual([{ name: 'robots', content: 'noindex' }]);
        expect(notices).toBe(1);
    });

    it('leaves an app path alone', () => {
        const doc = fakeDoc();
        let notices = 0;
        expect(markUnknownPath({ doc, pathname: `/agreements/${AGREEMENT}`, notify: () => notices++ })).toBe(false);
        expect(doc.head.children).toEqual([]);
        expect(notices).toBe(0);
    });
});

describe('routers and nginx agree with the route list', () => {
    const jsFiles = (dir) => readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (name === 'bundles' || name === 'vendor') return [];
        return statSync(path).isDirectory() ? jsFiles(path) : (name.endsWith('.js') ? [path] : []);
    });

    // Literal prefixes the frontend tests location.pathname against: startsWith('/x'), === '/x',
    // match(/^\/x...). A new router prefix missing from js/app-routes.js would be marked noindex.
    const prefixes = new Set();
    for (const file of jsFiles(join(repoRoot, 'frontend/js'))) {
        const source = readFileSync(file, 'utf8');
        const tests = /pathname\s*(?:\.startsWith\(\s*['"`]\/|===\s*['"`]\/|\.match\(\s*\/\^\\\/)([a-z][a-z0-9-]*)/g;
        for (const match of source.matchAll(tests)) prefixes.add(match[1]);
        // A path regex kept in a constant (const PATH = /^\/bets\/.../) in a file that reads pathname.
        if (!/pathname/.test(source)) continue;
        for (const match of source.matchAll(/=\s*\/\^\\\/([a-z][a-z0-9-]*)\\\//g)) prefixes.add(match[1]);
    }

    it('finds the routers', () => {
        expect([...prefixes]).toEqual(expect.arrayContaining(['proposals', 'designs', 'agreements', 'parcel', 'bets']));
        expect([...prefixes]).not.toContain('plans');
    });

    it.each([...prefixes])('/%s/… is an app path', (prefix) => {
        expect(isAppPath(`/${prefix}/x`) || isAppPath(`/${prefix}`)).toBe(true);
    });

    it('nginx treats no app path as a file', () => {
        const conf = readFileSync(join(repoRoot, 'backend/nginx/urbangametheory.xyz.nginx.conf'), 'utf8');
        const fileRule = conf.match(/location ~ "(\\\.\[A-Za-z\][^"]*)" \{/);
        expect(fileRule).not.toBeNull();
        const looksLikeFile = new RegExp(fileRule[1]);
        for (const path of appPaths.filter(p => p !== '/index.html')) expect(looksLikeFile.test(path), path).toBe(false);
        for (const path of ['/js/missing.js', '/wp-login.php', '/.env', '/carto-config.js.map', '/old.html']) {
            expect(looksLikeFile.test(path), path).toBe(true);
        }
        expect(conf).toMatch(/location \/ \{[^}]*try_files \$uri \$uri\/ \/index\.html;/);
    });
});
