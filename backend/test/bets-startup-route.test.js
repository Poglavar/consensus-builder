// How bets-sheet.js opens a bet's dialog on an agreement's chain account: from a shared bet link at
// startup (a delayed window load must use the original link, not a URL written by an in-app click),
// and from the agreement panel's Bet action (window.AgreementBets).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BetsLink = require('../../frontend/js/bets/bets-link.js');
const BetsModel = require('../../frontend/js/bets/bets-model.js');
const source = fs.readFileSync(new URL('../../frontend/js/bets/bets-sheet.js', import.meta.url), 'utf8');
const ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const OTHER = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';

function boot(href) {
  const listeners = new Map();
  const opened = [];
  const messages = [];
  const root = {
    // No sheet content on the page: a markets read finds nowhere to render and fetches nothing.
    document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
    location: new URL(href), BetsLink, BetsModel,
    addEventListener(name, callback) { listeners.set(name, callback); },
    whenAppBooted: async () => {},
    openBetDialog(options) { opened.push(options); },
    showEphemeralMessage(text) { messages.push(text); },
  };
  vm.runInNewContext(source, { window: root, console });
  return { root, opened, messages, load: () => listeners.get('load')() };
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
    expect(app.opened).toEqual([{ account: ACCOUNT, entryPoint: 'deep-link' }]);
  });

  it('still opens a normal query-form shared link after app boot', async () => {
    const app = boot(`http://localhost/?city=zg&bets=${ACCOUNT}`);
    await app.load();
    expect(app.opened).toEqual([{ account: ACCOUNT, entryPoint: 'deep-link' }]);
  });
});

describe('Opening a bet’s published agreement', () => {
  it.each([true, false])('counts a completed review only when the requested agreement panel is visible: %s', async visible => {
    const app = boot('http://localhost/?city=sf');
    const events = [];
    app.root.BetsTelemetry = { track: (name, properties) => events.push({ name, ...properties }) };
    app.root.AgreementSync = { handleAgreementRoute: async () => {} };
    app.root.AgreementPanel = { isOpen: () => visible, current: () => 'local-agreement' };
    app.root.AgreementStore = { get: () => ({ published: { cid: 'bafy-requested' } }) };
    await app.root.BetsSheet.openAgreement({ cid: 'bafy-requested' }, { entryPoint: 'dialog' });
    expect(events.map(event => event.result)).toEqual(['started', visible ? 'succeeded' : 'unknown']);
    expect(events.every(event => event.entryPoint === 'dialog')).toBe(true);
  });

  it('refreshes a cached agreement through the shared-link path before opening its panel', async () => {
    const app = boot('http://localhost/?city=sf');
    const calls = [];
    const cid = 'bafkrei-published-agreement';
    app.root.MapShell = { closeSheets: () => calls.push('close-sheets') };
    app.root.AgreementStore = { list: () => [{ id: 'cached', published: { cid }, outputs: [{ geometry: null }] }] };
    app.root.AgreementPanel = { open: id => calls.push(['open-cached', id]) };
    app.root.AgreementSync = { handleAgreementRoute: async value => calls.push(['refresh-published', value]) };
    await app.root.BetsSheet.openAgreement({ cid });
    expect(calls).toEqual(['close-sheets', ['refresh-published', cid]]);
    expect(app.messages).toEqual([]);
  });
});

describe('The agreement panel\'s Bet action (window.AgreementBets)', () => {
  // Local agreements (js/agreement-record.js) as the panel's store holds them.
  const minted = {
    id: 'agreement-1', title: null, designs: [{ title: 'Courtyard' }, { title: 'Tower' }],
    published: { cid: 'bafkrei-minted', sponsor: OTHER },
    onchain: { chain: 'solana', cluster: 'devnet', account: ACCOUNT }
  };
  const proposed = { id: 'agreement-2', title: 'Corner deal', designs: [], published: { cid: 'bafkrei-proposed', sponsor: null }, onchain: null };
  const withStore = app => {
    app.root.AgreementStore = { get: id => [minted, proposed].find(item => item.id === id) || null };
    return app;
  };

  it('opens the bet\'s dialog on the account the mint recorded, named as its row is', async () => {
    const app = withStore(boot('http://localhost/?city=zg'));
    expect(app.root.AgreementBets.available(minted)).toBe(true);
    await app.root.AgreementBets.open('agreement-1');
    expect(app.opened).toEqual([{ account: ACCOUNT, title: 'Courtyard + Tower', entryPoint: 'agreement' }]);
  });

  it('offers no bet on an agreement that is not minted on devnet', async () => {
    const app = withStore(boot('http://localhost/?city=zg'));
    expect(app.root.AgreementBets.available(proposed)).toBe(false);
    // Markets read devnet: a pointer on another cluster names no pool.
    expect(app.root.AgreementBets.available({ ...minted, onchain: { ...minted.onchain, cluster: 'mainnet-beta' } })).toBe(false);
    expect(await app.root.AgreementBets.open('agreement-2')).toBeNull();
    expect(await app.root.AgreementBets.open('no-such-agreement')).toBeNull();
    expect(app.opened).toEqual([]);
    expect(app.messages).toEqual(['Not minted yet, so no pool']);
  });
});
