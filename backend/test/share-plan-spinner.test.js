// "Share entire plan" opens a panel that builds a row and a map overlay per applied proposal, then
// asks the server about each one in turn. On a real plan that is seconds of nothing: the button
// stayed put, the page froze, and the panel's rows filled in silently long after it appeared.
//
// Two spinners, because there are two waits: the sidebar button covers the synchronous build (which
// needs a yield, or the spinner never paints before the freeze), and the panel counts out the
// per-proposal server checks that outlive it.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const routes = read('../../frontend/js/proposals/sharing-routes.js');
const dialog = read('../../frontend/js/proposals/dialog-share.js');
const listUi = read('../../frontend/js/proposals/list-ui.js');

function sliceBetween(src, from, to) {
    const start = src.indexOf(from);
    expect(start, `nema "${from}"`).toBeGreaterThan(-1);
    const end = src.indexOf(to, start);
    expect(end, `nema "${to}" iza toga`).toBeGreaterThan(start);
    return src.slice(start, end);
}

/** Gumb kakav funkcija očekuje: natpis, podnatpis i spinner. */
function fakeButton() {
    const make = () => ({ style: { display: '' } });
    const parts = {
        '.share-plan-label': make(),
        '.share-plan-subtext': make(),
        '.share-plan-spinner': make()
    };
    return {
        dataset: {},
        disabled: false,
        querySelector: sel => parts[sel] || null,
        parts
    };
}

describe('spinner na gumbu', () => {
    const body = sliceBetween(routes, 'function setSharePlanButtonBusy(busy) {', 'function shareAppliedProposals() {');
    const load = button => new Function('document',
        `${body} return setSharePlanButtonBusy;`)({ getElementById: () => button });

    it('zauzet: natpis ustupa mjesto spinneru, gumb se zaključa', () => {
        const button = fakeButton();
        load(button)(true);
        expect(button.disabled).toBe(true);
        expect(button.dataset.sharePlanBusy).toBe('1');
        expect(button.parts['.share-plan-label'].style.display).toBe('none');
        expect(button.parts['.share-plan-subtext'].style.display).toBe('none');
        expect(button.parts['.share-plan-spinner'].style.display).toBe('inline-flex');
    });

    it('gotovo: sve se vrati kako je bilo', () => {
        const button = fakeButton();
        const setBusy = load(button);
        setBusy(true);
        setBusy(false);
        expect(button.disabled).toBe(false);
        expect(button.dataset.sharePlanBusy).toBeUndefined();
        expect(button.parts['.share-plan-label'].style.display).toBe('');
        expect(button.parts['.share-plan-spinner'].style.display).toBe('none');
    });

    it('bez gumba ne puca — panel se otvara i iz drugih putanja', () => {
        expect(() => new Function('document', `${body} return setSharePlanButtonBusy;`)(
            { getElementById: () => null })(true)).not.toThrow();
    });
});

describe('otvaranje plana', () => {
    const body = sliceBetween(routes, 'function shareAppliedProposals() {', 'function shareSingleProposal(');

    function harness({ panel } = {}) {
        const frames = [];
        const spies = {
            setSharePlanButtonBusy: vi.fn(),
            showSharePlanPanel: vi.fn(panel || (() => { }))
        };
        const run = new Function('setSharePlanButtonBusy', 'showSharePlanPanel', 'requestAnimationFrame',
            `${body} return shareAppliedProposals;`)(
            spies.setSharePlanButtonBusy, spies.showSharePlanPanel, cb => frames.push(cb));
        return { run, spies, frames, tick: () => frames.splice(0).forEach(cb => cb()) };
    }

    it('spinner se upali PRIJE nego što išta krene', () => {
        const { run, spies } = harness();
        run();
        expect(spies.setSharePlanButtonBusy).toHaveBeenCalledWith(true);
        expect(spies.showSharePlanPanel).not.toHaveBeenCalled();
    });

    it('gradnja čeka dva okvira, da spinner stigne na ekran', () => {
        // Jedan okvir primijeni stil; drugi jamči da je i nacrtan. Bez toga sinkroni blok
        // zamrzne stranicu prije nego što se gumb uopće promijenio.
        const { run, spies, tick } = harness();
        run();
        tick();
        expect(spies.showSharePlanPanel).not.toHaveBeenCalled();
        tick();
        expect(spies.showSharePlanPanel).toHaveBeenCalledTimes(1);
    });

    it('spinner se gasi kad je panel gotov', () => {
        const { run, spies, tick } = harness();
        run();
        tick(); tick();
        expect(spies.setSharePlanButtonBusy).toHaveBeenLastCalledWith(false);
    });

    it('i kad otvaranje pukne — inače gumb zauvijek vrti', () => {
        const { run, spies, tick } = harness({ panel: () => { throw new Error('boom'); } });
        run();
        tick();
        expect(() => tick()).toThrow('boom');
        expect(spies.setSharePlanButtonBusy).toHaveBeenLastCalledWith(false);
    });

    it('bez requestAnimationFrame se svejedno otvori', () => {
        const spies = { setSharePlanButtonBusy: vi.fn(), showSharePlanPanel: vi.fn() };
        const run = new Function('setSharePlanButtonBusy', 'showSharePlanPanel', 'requestAnimationFrame',
            `${body} return shareAppliedProposals;`)(
            spies.setSharePlanButtonBusy, spies.showSharePlanPanel, undefined);
        run();
        expect(spies.showSharePlanPanel).toHaveBeenCalledTimes(1);
    });
});

describe('napredak u panelu', () => {
    const checks = sliceBetween(dialog, 'const initializeUploadChecks = async () => {', '// The panel goes up EMPTY');

    it('broji provjerene prijedloge, ne samo "radim nešto"', () => {
        expect(checks).toContain('const total = proposalsByHash.size;');
        expect(checks).toContain('done += 1;');
        expect(checks).toContain("showProgress('checkingProposals'");
    });

    it('redak nestane kad je punjenje gotovo — i kad je puklo', () => {
        const fill = sliceBetween(dialog, '(async () => {', "    } catch (error) {\n        console.error('showSharePlanPanel failed'");
        expect(fill).toContain('} finally {');
        expect(fill.slice(fill.indexOf('} finally {'))).toContain('clearProgress();');
        expect(fill).toContain("console.error('share plan: filling the panel failed'");
    });

    it('redak postoji prije liste, pa ga se vidi čim se panel otvori', () => {
        const build = sliceBetween(dialog, "progressRow.className = 'share-plan-progress';", "listWrap.className = 'share-plan-list';");
        expect(build).toContain('fa-spinner fa-spin');
        expect(build).toContain('container.appendChild(progressRow);');
        expect(read('../../frontend/css/proposals.css')).toContain('.share-plan-progress {');
    });
});

// The panel used to be built in one synchronous block — every row and every map overlay before a
// single pixel appeared. It now goes up empty and fills itself in slices.
describe('punjenje panela u odsječcima', () => {
    const body = sliceBetween(dialog, 'const FRAME_BUDGET_MS = 12;', 'document.body.appendChild(panelRoot);');

    /** Lifted with its own panel-state variable, so a test can "close" the panel mid-run. */
    function harness({ msPerItem = 0 } = {}) {
        let clock = 1000;
        const frames = [];
        const progress = [];
        const made = new Function('showProgress', 'performance', 'requestAnimationFrame', `
            let _sharePlanPanelState = null;
            ${body}
            return {
                inChunks,
                open: () => { _sharePlanPanelState = { token: panelToken }; },
                close: () => { _sharePlanPanelState = null; }
            };`)(
            (key, fallback, done, total) => progress.push(`${key} ${done}/${total}`),
            { now: () => { clock += msPerItem; return clock; } },
            cb => { frames.push(1); cb(); }
        );
        made.open();
        return { ...made, frames, progress };
    }

    it('obradi svaku stavku i javi napredak za svaku', async () => {
        const h = harness();
        const seen = [];
        const done = await h.inChunks(['a', 'b', 'c'], item => seen.push(item), 'listingProposals', 'x');
        expect(done).toBe(true);
        expect(seen).toEqual(['a', 'b', 'c']);
        expect(h.progress).toEqual(['listingProposals 1/3', 'listingProposals 2/3', 'listingProposals 3/3']);
    });

    it('ne pušta okvir dok je unutar proračuna', async () => {
        const h = harness({ msPerItem: 0 });
        await h.inChunks([1, 2, 3, 4, 5], () => { }, 'k', 'x');
        expect(h.frames).toHaveLength(0);
    });

    it('pusti okvir čim je držao dretvu predugo', async () => {
        // Sat skoči preko proračuna na svakoj stavci: svaka mora ustupiti okvir.
        const h = harness({ msPerItem: 20 });
        await h.inChunks([1, 2, 3], () => { }, 'k', 'x');
        expect(h.frames.length).toBeGreaterThanOrEqual(3);
    });

    it('stane kad se panel zatvori usred punjenja', async () => {
        // Inače otkazana gradnja i dalje crta slojeve po karti koja je otišla dalje.
        const h = harness();
        const seen = [];
        const done = await h.inChunks([1, 2, 3, 4], item => {
            seen.push(item);
            if (item === 2) h.close();
        }, 'k', 'x');
        expect(done).toBe(false);
        expect(seen).toEqual([1, 2]);
    });

    it('redoslijed je bitan: svi redci, pa slojevi, pa provjere', () => {
        const fill = sliceBetween(dialog, '(async () => {', "    } catch (error) {\n        console.error('showSharePlanPanel failed'");
        const rows = fill.indexOf("'listingProposals'");
        const uploads = fill.indexOf('await initializeUploadChecks();');
        expect(rows).toBeGreaterThan(-1);
        expect(uploads).toBeGreaterThan(rows);
        // Faze slojeva više nema: otvaranje popisa ne crta ništa po karti.
        expect(fill).not.toContain("'drawingProposals'");
        // Svaka faza staje ako se panel zatvorio.
        expect(fill.match(/if \(!await inChunks\(/g) || []).toHaveLength(1);
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s imenuje obje nove faze', locale => {
        const share = JSON.parse(read(`../../frontend/i18n/${locale}.json`)).modal.roadWidth.share;
        for (const key of ['listingProposals', 'preparingPlan']) {
            expect(share[key], `${locale} nema ${key}`).toBeTruthy();
        }
    });
});

// The modal's "Share the whole plan instead" closes the modal and hands over to the same panel —
// so the sidebar's spinner is behind a folded sidebar and the pressed control was about to vanish.
describe('spinner na "podijeli cijeli plan"', () => {
    const handler = sliceBetween(read('../../frontend/js/proposals/dialog-upload.js'),
        'sharePlanButton.addEventListener(\'click\', () => {', 'fragment.appendChild(sharePlanButton);');

    it('spinner ide na pritisnuti gumb, prije nego što se dijalog zatvori', () => {
        expect(handler).toContain('sharePlanButton.disabled = true;');
        expect(handler).toContain('fa-spinner fa-spin');
        expect(handler).toContain("tShare('preparingPlan'");
        const spin = handler.indexOf('fa-spinner');
        const close = handler.indexOf('share-modal-close');
        expect(spin).toBeGreaterThan(-1);
        expect(close).toBeGreaterThan(spin);
    });

    it('zatvaranje i predaja čekaju dva okvira, da spinner stigne na ekran', () => {
        expect(handler).toContain('requestAnimationFrame(() => requestAnimationFrame(go));');
        expect(handler).toContain('shareAppliedProposals();');
    });
});

// Ne provjerava crtanje (za to treba preglednik), nego da pravilo postoji: JS gumbu postavlja
// display:inline-flex da ga otkrije, čime <button> postaje flex KONTEJNER i gubi centriranje koje
// inače radi sam — natpis padne u gornji lijevi kut kutije visoke 40px (.btn min-height).
describe('natpis na gumbu za upload', () => {
    const css = read('../../frontend/css/proposals.css');

    it('centriran je u oba smjera, pa mu display ne može pobjeći', () => {
        const rule = sliceBetween(css, '.share-plan-row .btn {', '}');
        expect(rule).toContain('align-items: center;');
        expect(rule).toContain('justify-content: center;');
        expect(rule).toContain('text-align: center;');
    });

    it('JS i dalje samo pokazuje i skriva, ne razmješta', () => {
        const state = sliceBetween(dialog, 'const updateRowState = (key) => {', 'const toggleCheckbox');
        expect(state).toContain("controls.uploadBtn.style.display = 'inline-flex';");
        expect(state).not.toContain('alignItems');
    });
});

describe('gumb ne smije pobjeći iz zauzetog stanja', () => {
    it('osvježavanje liste ga ne otključa usred gradnje', () => {
        // updateShowProposalsButton ide na svaku promjenu prijedloga; da ga ovdje omogući,
        // drugi klik bi upao u napola izgrađen panel.
        expect(listUi).toContain("if (sharePlanButton && !sharePlanButton.dataset.sharePlanBusy) {");
    });

    it('stranica ima spinner u gumbu', () => {
        const html = read('../../frontend/index.html');
        const button = sliceBetween(html, 'id="shareAppliedProposalsButton"', '</button>');
        expect(button).toContain('class="share-plan-spinner"');
        expect(button).toContain('fa-spinner fa-spin');
        expect(button).toContain('sidebar.proposals.shareButtonPreparing');
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s zna reći oboje', locale => {
        const dict = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
        expect(dict.sidebar.proposals.shareButtonPreparing).toBeTruthy();
        const checking = dict.modal.roadWidth.share.checkingProposals;
        expect(checking).toBeTruthy();
        expect(checking).toContain('{{done}}');
        expect(checking).toContain('{{total}}');
    });
});
