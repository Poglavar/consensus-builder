// Epoch buckets: čista logika vremenske crte (frontend/js/proposals/epoch.js,
// UMD — u nodeu izvozi samo čisti dio) i mapiranje epoch_year kroz serializer.
//
// Epoha se postavlja izbornikom na kartici u listi prijedloga. DOM dio modula se
// u nodeu ne izvršava (nema window), pa se te funkcije dižu iz izvora i pokreću s
// podmetnutim suradnicima — inače bi ostao samo grep, koji ne može pasti.

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serializeProposalRow } from '../proposals/serializer.js';

const require = createRequire(import.meta.url);
const epoch = require('../../frontend/js/proposals/epoch.js');

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const epochSrc = read('../../frontend/js/proposals/epoch.js');

/** Izvor između dvije oznake; kraj se traži OD početka, ne od nule. */
function sliceBetween(src, from, to) {
    const start = src.indexOf(from);
    expect(start, `nema "${from}"`).toBeGreaterThan(-1);
    const end = src.indexOf(to, start);
    expect(end, `nema "${to}" iza toga`).toBeGreaterThan(start);
    return src.slice(start, end);
}

describe('parseEpochYear', () => {
    it('prihvaća cijele godine u rasponu, i kao string', () => {
        expect(epoch.parseEpochYear(2045)).toBe(2045);
        expect(epoch.parseEpochYear('2066')).toBe(2066);
        expect(epoch.parseEpochYear(2026)).toBe(2026);
        expect(epoch.parseEpochYear(2966)).toBe(2966);
    });

    it('sve krivo daje null, nikad broj', () => {
        expect(epoch.parseEpochYear(null)).toBe(null);
        expect(epoch.parseEpochYear(undefined)).toBe(null);
        expect(epoch.parseEpochYear('')).toBe(null);
        expect(epoch.parseEpochYear('kifla')).toBe(null);
        expect(epoch.parseEpochYear(2025)).toBe(null);   // ispod raspona
        expect(epoch.parseEpochYear(2967)).toBe(null);   // iznad raspona
        expect(epoch.parseEpochYear(2045.5)).toBe(null); // nije cijeli broj
        expect(epoch.parseEpochYear(0)).toBe(null);
    });
});

describe('distinctEpochs', () => {
    it('sortirane različite godine; bez epohe se preskače', () => {
        const lista = [
            { epochYear: 2055 }, { epochYear: 2035 }, { epochYear: 2055 },
            { epochYear: null }, {}, { epochYear: 'x' }
        ];
        expect(epoch.distinctEpochs(lista)).toEqual([2035, 2055]);
        expect(epoch.distinctEpochs([])).toEqual([]);
        expect(epoch.distinctEpochs(null)).toEqual([]);
    });
});

describe('kumulativna pripadnost i filtar liste', () => {
    const p35 = { epochYear: 2035 }, p55 = { epochYear: 2055 }, bez = {};

    it('bez epohe je uvijek unutra (postojeće stanje grada)', () => {
        expect(epoch.belongsCumulative(bez, 2035)).toBe(true);
        expect(epoch.belongsCumulative(p35, 2035)).toBe(true);
        expect(epoch.belongsCumulative(p55, 2035)).toBe(false);
        expect(epoch.belongsCumulative(p55, 2055)).toBe(true);
    });

    it('filterEntriesCumulative radi nad {proposal} zapisima; null godina = sve', () => {
        const entries = [{ proposal: p35 }, { proposal: p55 }, { proposal: bez }];
        expect(epoch.filterEntriesCumulative(entries, null)).toHaveLength(3);
        expect(epoch.filterEntriesCumulative(entries, 2035).map(e => e.proposal))
            .toEqual([p35, bez]);
        expect(epoch.filterEntriesCumulative(entries, 'nevaljalo')).toHaveLength(3);
    });
});

describe('epochDiff — što još primijeniti, što maknuti za odabranu godinu', () => {
    const prijedlozi = [
        { id: 'a', epochYear: 2035, applied: true },
        { id: 'b', epochYear: 2035, applied: false },   // pripada, a nije primijenjen
        { id: 'c', epochYear: 2055, applied: true },    // ne pripada, a primijenjen je
        { id: 'd', epochYear: 2055, applied: false },
        { id: 'e', applied: false }                     // bez epohe: pripada uvijek
    ];
    const isApplied = p => p.applied === true;

    it('2035: primijeni b i e, makni c', () => {
        const d = epoch.epochDiff(prijedlozi, 2035, isApplied);
        expect(d.toApply.map(p => p.id)).toEqual(['b', 'e']);
        expect(d.toUnapply.map(p => p.id)).toEqual(['c']);
    });

    it('bez godine nema razlike', () => {
        const d = epoch.epochDiff(prijedlozi, null, isApplied);
        expect(d.toApply).toEqual([]);
        expect(d.toUnapply).toEqual([]);
    });
});

describe('epochYearChoices — ponuđene godine u izborniku', () => {
    it('zadane godine kad prijedlog nema epohu', () => {
        expect(epoch.epochYearChoices(null)).toEqual([...epoch.DEFAULT_CHOICES]);
        expect(epoch.epochYearChoices('kifla')).toEqual([...epoch.DEFAULT_CHOICES]);
    });

    it('godinu izvan ponude ubacuje na njeno mjesto, bez ponavljanja', () => {
        // Bez ovoga bi izbornik na kartici tiho pokazivao KRIVU godinu za prijedlog
        // upisan kroz "Druga godina…" — vrijednost koje nema među opcijama otpada.
        expect(epoch.epochYearChoices(2040)).toEqual([2035, 2040, 2045, 2055, 2066]);
        expect(epoch.epochYearChoices(2045)).toEqual([...epoch.DEFAULT_CHOICES]);
        expect(epoch.epochYearChoices(2966)).toEqual([...epoch.DEFAULT_CHOICES, 2966]);
    });
});

// Kartica nosi izbornik: pokazuje godinu i postavlja je. Prije je nosila kvačicu za
// skupnu dodjelu (+ traku iznad liste) i značku, a godina se mijenjala u detaljima.
describe('izbornik epohe na kartici', () => {
    const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cardHtml = new Function('epochOf', 'epochYearChoices', 't', 'esc',
        sliceBetween(epochSrc, 'function yearOptionList(', '/** Popuni <select>')
        + sliceBetween(epochSrc, 'function cardEpochSelectHtml(', '/** Odabir s kartice')
        + ' return cardEpochSelectHtml;'
    )(epoch.epochOf, epoch.epochYearChoices, (key, fallback) => fallback, escHtml);

    it('pokazuje godinu prijedloga kao odabranu, i zna koja je kartica', () => {
        const html = cardHtml({ epochYear: 2045 }, 'c-abc');
        expect(html).toContain('data-proposal-id="c-abc"');
        expect(html).toContain('<option value="2045" selected>2045.</option>');
        expect(html.match(/ selected>/g)).toHaveLength(1);
        expect(html).not.toContain('is-empty');
    });

    it('bez epohe drži "Bez epohe" i blijedi chip', () => {
        const html = cardHtml({}, 'c-abc');
        expect(html).toContain('class="proposal-epoch-card-select is-empty"');
        expect(html).toContain('<option value="" selected>No epoch</option>');
        expect(html.match(/ selected>/g)).toHaveLength(1);
    });

    it('godinu izvan ponude pokazuje kao odabranu, umjesto da tiho padne na drugu', () => {
        const html = cardHtml({ epochYear: 2077 }, 'c-abc');
        expect(html).toContain('<option value="2077" selected>2077.</option>');
        expect(html.indexOf('value="2066"')).toBeLessThan(html.indexOf('value="2077"'));
    });

    it('"Druga godina…" ostaje dohvatljiva s kartice', () => {
        expect(cardHtml({ epochYear: 2035 }, 'c-abc')).toContain('<option value="custom">Other year…</option>');
    });

    it('bježi ključ prijedloga — inače je navodnik u njemu izlaz iz atributa', () => {
        const html = cardHtml({}, 'c-a"><script>x</script>');
        expect(html).not.toContain('<script>');
        expect(html).toContain('data-proposal-id="c-a&quot;&gt;&lt;script&gt;');
    });
});

describe('promjena epohe s kartice', () => {
    const body = sliceBetween(epochSrc, 'async function handleCardEpochChange(select) {', '// Delegirani listeneri');

    function harness({ proposal = { proposalId: 'c-1', epochYear: 2035 }, save } = {}) {
        const spies = {
            setEpoch: vi.fn(save || (async () => { })),
            renderList: vi.fn(),
            askCustomYear: vi.fn(() => 2077),
            alert: vi.fn(),
            console: { error: vi.fn() }
        };
        const run = new Function('findProposal', 'askCustomYear', 'parseEpochYear', 'setEpoch',
            'renderList', 't', 'alert', 'console', `${body} return handleCardEpochChange;`)(
            () => proposal, spies.askCustomYear, epoch.parseEpochYear, spies.setEpoch,
            spies.renderList, (key, fallback) => fallback, spies.alert, spies.console);
        return { run, spies, proposal };
    }
    const select = value => ({ value, dataset: { proposalId: 'c-1' }, disabled: false });

    it('odabrana godina se sprema na taj prijedlog', async () => {
        const { run, spies, proposal } = harness();
        await run(select('2055'));
        expect(spies.setEpoch).toHaveBeenCalledWith(proposal, 2055);
        expect(spies.alert).not.toHaveBeenCalled();
    });

    it('prazan odabir briše epohu (null, ne 0)', async () => {
        const { run, spies } = harness();
        await run(select(''));
        expect(spies.setEpoch.mock.calls[0][1]).toBe(null);
    });

    it('"Druga godina…" pita, pa sprema upisanu godinu', async () => {
        const { run, spies } = harness();
        await run(select('custom'));
        expect(spies.askCustomYear).toHaveBeenCalled();
        expect(spies.setEpoch.mock.calls[0][1]).toBe(2077);
    });

    it('odustajanje od "Druga godina…" ne sprema ništa i vraća prikaz', async () => {
        const { run, spies } = harness();
        spies.askCustomYear.mockReturnValue(undefined);
        await run(select('custom'));
        expect(spies.setEpoch).not.toHaveBeenCalled();
        expect(spies.renderList).toHaveBeenCalled();
    });

    it('neuspjelo spremanje se kaže i prikaz se vrati — izbornik ne smije pokazivati godinu koja nije zapisana', async () => {
        const { run, spies } = harness({ save: async () => { throw new Error('HTTP 500'); } });
        await run(select('2055'));
        expect(spies.alert).toHaveBeenCalledWith('Failed to save the epoch.');
        expect(spies.renderList).toHaveBeenCalled();
        expect(spies.console.error).toHaveBeenCalled();
    });

    it('nepoznata kartica ne sprema ništa', async () => {
        const { run, spies } = harness({ proposal: null });
        await run(select('2055'));
        expect(spies.setEpoch).not.toHaveBeenCalled();
        expect(spies.renderList).toHaveBeenCalled();
    });
});

// Kvačica, traka skupne dodjele, značka i redak u detaljima su zamijenjeni, ne
// zadržani uz izbornik — dva mjesta za istu godinu su dvije prilike da se raziđu.
describe('stara putanja je maknuta', () => {
    const listUi = read('../../frontend/js/proposals/list-ui.js');
    const css = read('../../frontend/css/modals.css');

    it.each(['selectCheckboxHtml', 'refreshBulkBar', 'applyEpochToSelected', 'proposal-bulk-check',
             'epochBadgeHtml', 'injectEpochRow'])('epoch.js više ne zna za %s', name => {
        expect(epochSrc).not.toContain(name);
    });

    it('kartica crta izbornik, a klik na njega ne otvara prijedlog', () => {
        expect(listUi).toContain('window.__proposalEpoch.cardEpochSelectHtml(proposal, proposalId)');
        expect(listUi).toContain("closest('.proposal-epoch-card-select')) return;");
        expect(listUi).not.toContain('proposal-bulk-check');
    });

    it('panel detalja više ne nudi epohu', () => {
        expect(read('../../frontend/js/proposals/details-panel.js')).not.toContain('__proposalEpoch');
    });

    it('lista i dalje crta vremensku crtu, bez trake skupne dodjele', () => {
        const share = read('../../frontend/js/proposals/dialog-share.js');
        expect(share).toContain('injectTimeline(modal)');
        expect(share).not.toContain('refreshBulkBar');
    });

    it.each(['.proposal-epoch-badge', '.proposal-epoch-row', '.proposal-bulk-check', '.proposal-epoch-bulk'])(
        'CSS više ne stilizira %s', selector => {
            expect(css).not.toContain(selector);
        });

    it('CSS stilizira chip-izbornik, i praznu i punu epohu', () => {
        expect(css).toContain('.proposal-epoch-card-select {');
        expect(css).toContain('.proposal-epoch-card-select.is-empty {');
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s ima ključeve koji se koriste i nijedan skupni', locale => {
        const e = JSON.parse(read(`../../frontend/i18n/${locale}.json`))
            .modal.roadWidth.proposalList.epoch;
        for (const key of ['rowLabel', 'none', 'custom', 'customPrompt', 'saveError',
                           'timelineLabel', 'all', 'cumulative', 'toApply', 'toUnapply']) {
            expect(e[key], `${locale} nema ${key}`).toBeTruthy();
        }
        for (const key of ['badgeTooltip', 'selectForBulk', 'selectedCount', 'assignTo',
                           'assign', 'clearSelection', 'bulkPartial']) {
            expect(e[key], `${locale} još ima ${key}`).toBeUndefined();
        }
    });
});

describe('DEFAULT_CHOICES su ponuđene godine, sve valjane', () => {
    it('rastu i prolaze parseEpochYear', () => {
        const g = epoch.DEFAULT_CHOICES;
        expect(g.length).toBeGreaterThan(1);
        expect([...g].sort((a, b) => a - b)).toEqual([...g]);
        for (const godina of g) expect(epoch.parseEpochYear(godina)).toBe(godina);
    });
});

describe('serializer: epoch_year → epochYear', () => {
    const osnovni = { proposal_id: 'p-1', type: 'road', proposal_data: {} };

    it('stupac iz baze pobjeđuje i pretvara se u broj', () => {
        const p = serializeProposalRow({ ...osnovni, epoch_year: '2045' });
        expect(p.epochYear).toBe(2045);
    });

    it('bez stupca: epochYear iz proposal_data, inače null', () => {
        const iz = serializeProposalRow({ ...osnovni, proposal_data: { epochYear: 2055 } });
        expect(iz.epochYear).toBe(2055);
        const prazan = serializeProposalRow(osnovni);
        expect(prazan.epochYear).toBe(null);
    });
});

// Raspodjela po epohama piše u svaki prijedlog. Poslano jedan po jedan, to je stotine zahtjeva i
// ravno u write rate limiter: raspodjela preko 300 prijedloga pala je na 429 nakon prve stotine i
// ostavila plan napola dodijeljen — što izgleda kao dodijeljen.
describe('epohe idu na server u JEDNOM zahtjevu', () => {
    // Kraj: prva funkcija IZA distributeEpochs. renderList je definiran prije njega, pa kao
    // oznaka kraja ne postoji 'iza' i rez bi bio prazan.
    const distribute = sliceBetween(epochSrc, 'async function distributeEpochs(', 'function findProposal(');
    const writer = sliceBetween(epochSrc, 'async function writeEpochsToServer(', 'async function distributeEpochs(');

    it('šalje skupni PATCH umjesto jednog po prijedlogu', () => {
        expect(writer).toContain("/proposals/epochs`");
        expect(writer).toContain("method: 'PATCH'");
        expect(writer).toContain('JSON.stringify({ epochs })');
    });

    it('lokalni upis preskače server, inače se svaka epoha piše dvaput', () => {
        expect(distribute).toContain('skipServer: true');
        expect(epochSrc).toContain('!options.skipServer');
    });

    it('imenuje prijedloge koje server nije našao umjesto da ih prešuti', () => {
        expect(writer).toContain("reason: 'no such proposal on the server'");
    });

    it('lokalni zapisi se pišu i kad server odbije — karta i lista slijede ono što je traženo', () => {
        expect(distribute).toContain('const serverFailure = await writeEpochsToServer(plan, failed);');
        expect(distribute).toContain("console.warn('[epoch] server side did not take the plan:'");
    });
});

// Ista provjera na serveru: jedan statement, pa cijeli plan sjedne ili ne sjedne nijedan.
describe('PATCH /proposals/epochs', () => {
    const routes = read('../routes/proposals.js');
    const handler = sliceBetween(routes, "app.patch('/proposals/epochs'", "app.patch('/proposals/:id/epoch'");

    it('je registriran prije rute s :id, pa ga ništa ne zasjenjuje', () => {
        expect(routes.indexOf("app.patch('/proposals/epochs'"))
            .toBeLessThan(routes.indexOf("app.patch('/proposals/:id/epoch'"));
    });

    it('piše sve odjednom, jednim UPDATE-om preko unnest', () => {
        expect(handler).toContain('unnest($1::text[])');
        expect(handler).toContain('unnest($2::int[])');
        expect(handler).toContain('WHERE p.proposal_id = v.id OR p.id::text = v.id');
    });

    it('provjerava SVAKI unos, da jedan loš ne uđe s 299 dobrih', () => {
        expect(handler).toContain('Number.isInteger(year)');
        expect(handler).toContain('year < 2026 || year > 2966');
        expect(handler).toContain('Every entry needs an id.');
    });

    it('ograničava veličinu zahtjeva i vraća što nije našao', () => {
        expect(handler).toContain('entries.length > 2000');
        expect(handler).toContain('const missing = ids.filter(id => !matched.has(id));');
        expect(handler).toContain('requested: ids.length, updated: updated.length, missing');
    });
});
