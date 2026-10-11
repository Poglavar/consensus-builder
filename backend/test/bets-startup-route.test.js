// A delayed window load must use the original bet link, not a URL written by an in-app click.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BetsLink = require('../../frontend/js/bets/bets-link.js');
const source = fs.readFileSync(new URL('../../frontend/js/bets/bets-sheet.js', import.meta.url), 'utf8');
const ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const OTHER = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';

function boot(href) {
  const listeners = new Map();
  const opened = [];
  const root = {
    document: { readyState: 'loading', addEventListener() {} },
    location: new URL(href), BetsLink,
    addEventListener(name, callback) { listeners.set(name, callback); },
    whenAppBooted: async () => {},
    openBetDialog(options) { opened.push(options); },
  };
  vm.runInNewContext(source, { window: root, console });
  return { root, opened, load: () => listeners.get('load')() };
}

describe('Bets startup route', () => {
  it('does not reopen a bet that the user opened while images were still loading', async () => {
    const app = boot('http://localhost/?city=zg');
    app.root.location = new URL(`http://localhost/bets/${ACCOUNT}?city=zg`);
    await app.load();
    expect(app.opened).toEqual([]);
  });

  it('opens the original shared bet even if later navigation changes the address', async () => {
    const app = boot(`http://localhost/bets/${ACCOUNT}?city=zg`);
    app.root.location = new URL(`http://localhost/bets/${OTHER}?city=zg`);
    await app.load();
    expect(app.opened).toEqual([{ proposalAccount: ACCOUNT }]);
  });

  it('still opens a normal query-form shared link after app boot', async () => {
    const app = boot(`http://localhost/?city=zg&bets=${ACCOUNT}`);
    await app.load();
    expect(app.opened).toEqual([{ proposalAccount: ACCOUNT }]);
  });
});
