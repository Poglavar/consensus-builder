// "Share applied designs" opens a panel that builds a row per applied design, then checks which of
// them are published. On a real plan that is seconds of work: the button stayed put, the page froze,
// and the panel's rows filled in silently long after it appeared.
//
// Two spinners, because there are two waits: the sidebar button covers the synchronous build (which
// needs a yield, or the spinner never paints before the freeze), and the panel counts out its
// listing and publication check, which outlive it. (Whether a design is published is its own CID,
// DesignSync.publishedCid, since M2: the check asks no server.)

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

/** Gumb kakav funkcija očekuje: natpis, podnatpis i spinner (skriven, kao u index.html). */
function fakeButton() {
    const parts = {
        '.share-plan-label': { hidden: false },
        '.share-plan-subtext': { hidden: false },
        '.share-plan-spinner': { hidden: true }
    };
    return {
        dataset: {},
        disabled: false,
        querySelector: sel => parts[sel] || null,
        parts
    };
}

describe('spinner na gumbu', () => {
    const body = sliceBetween(routes, 'function setSharePlanButtonBusy(busy) {', 'function shareAppliedProposals(');
    const load = button => new Function('document',
        `${body} return setSharePlanButtonBusy;`)({ getElementById: () => button });

    it('zauzet: natpis ustupa mjesto spinneru, gumb se zaključa', () => {
        const button = fakeButton();
        load(button)(true);
        expect(button.disabled).toBe(true);
        expect(button.dataset.sharePlanBusy).toBe('1');
        expect(button.parts['.share-plan-label'].hidden).toBe(true);
        expect(button.parts['.share-plan-subtext'].hidden).toBe(true);
        expect(button.parts['.share-plan-spinner'].hidden).toBe(false);
    });

    it('gotovo: sve se vrati kako je bilo', () => {
        const button = fakeButton();
        const setBusy = load(button);
        setBusy(true);
        setBusy(false);
        expect(button.disabled).toBe(false);
        expect(button.dataset.sharePlanBusy).toBeUndefined();
        expect(button.parts['.share-plan-label'].hidden).toBe(false);
        expect(button.parts['.share-plan-subtext'].hidden).toBe(false);
        expect(button.parts['.share-plan-spinner'].hidden).toBe(true);
    });

    it('skriva atributom hidden, ne inline stilom: izgled ostaje u stilovima', () => {
        expect(body).not.toContain('.style.display');
        expect(read('../../frontend/css/proposals.css')).toMatch(/\.share-plan-spinner\[hidden\]\s*\{\s*display: none;/);
    });

    it('keeps a loading Share tab enabled so arrow-key navigation retains focus', () => {
        const button = fakeButton();
        button.getAttribute = () => 'tab';
        load(button)(true);
        expect(button.disabled).toBe(false);
        expect(button.parts['.share-plan-spinner'].hidden).toBe(false);
    });

    it('bez gumba ne puca — panel se otvara i iz drugih putanja', () => {
        expect(() => new Function('document', `${body} return setSharePlanButtonBusy;`)(
            { getElementById: () => null })(true)).not.toThrow();
    });
});

describe('otvaranje plana', () => {
    const body = sliceBetween(routes, 'function shareAppliedProposals(', 'function resolveDesignToShare(');

    // guestPolicyBlocks: the share link's name gate (guest-policy.js); null = allowed.
    function harness({ panel, nameGate = () => null } = {}) {
        const frames = [];
        const spies = {
            setSharePlanButtonBusy: vi.fn(),
            showSharePlanPanel: vi.fn(panel || (() => { })),
            guestPolicyBlocks: vi.fn(nameGate)
        };
        const run = new Function('setSharePlanButtonBusy', 'showSharePlanPanel', 'requestAnimationFrame', 'guestPolicyBlocks',
            `${body} return shareAppliedProposals;`)(
            spies.setSharePlanButtonBusy, spies.showSharePlanPanel, cb => frames.push(cb), spies.guestPolicyBlocks);
        return { run, spies, frames, tick: () => frames.splice(0).forEach(cb => cb()) };
    }

    it('opens sharing for a guest: only publication requires an author', async () => {
        const { run, spies, tick } = harness({ nameGate: () => 'Choose a profile name to share' });
        const ready = run(); tick(); tick(); await ready;
        expect(spies.guestPolicyBlocks).not.toHaveBeenCalled();
        expect(spies.showSharePlanPanel).toHaveBeenCalledTimes(1);
    });

    it('cancels a deferred open when Designs was closed or another tab chosen', async () => {
        const { run, spies, tick } = harness();
        let current = true;
        const ready = run({ isCurrent: () => current });
        tick();
        current = false;
        tick();
        await ready;
        expect(spies.showSharePlanPanel).not.toHaveBeenCalled();
        expect(spies.setSharePlanButtonBusy).toHaveBeenLastCalledWith(false);
    });

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
        const run = new Function('setSharePlanButtonBusy', 'showSharePlanPanel', 'requestAnimationFrame', 'guestPolicyBlocks',
            `${body} return shareAppliedProposals;`)(
            spies.setSharePlanButtonBusy, spies.showSharePlanPanel, undefined, () => null);
        run();
        expect(spies.showSharePlanPanel).toHaveBeenCalledTimes(1);
    });
});

describe('napredak u panelu', () => {
    it('broji popisane i provjerene dizajne, ne samo "radim nešto"', () => {
        const fill = sliceBetween(dialog, '(async () => {', "    } catch (error) {\n        console.error('showSharePlanPanel failed'");
        expect(fill).toContain("'proposals.share.panel.listing', 'Listing {{done}}/{{total}} designs…'");
        expect(fill).toContain("'proposals.share.panel.checking', 'Checking {{done}}/{{total}} designs…'");
        // Each step reports its own position (executed below, in "punjenje panela u odsječcima").
        expect(sliceBetween(dialog, 'const inChunks = async', "document.getElementById('designs-share').replaceChildren(panelRoot);"))
            .toContain('showProgress(phraseKey, fallback, i + 1, total);');
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
    const body = sliceBetween(dialog, 'const FRAME_BUDGET_MS = 12;', "document.getElementById('designs-share').replaceChildren(panelRoot);");

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
        const done = await h.inChunks(['a', 'b', 'c'], item => seen.push(item), 'proposals.share.panel.listing', 'x');
        expect(done).toBe(true);
        expect(seen).toEqual(['a', 'b', 'c']);
        expect(h.progress).toEqual(['proposals.share.panel.listing 1/3', 'proposals.share.panel.listing 2/3', 'proposals.share.panel.listing 3/3']);
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

    it('redoslijed je bitan: svi redci, pa provjera objave', () => {
        const fill = sliceBetween(dialog, '(async () => {', "    } catch (error) {\n        console.error('showSharePlanPanel failed'");
        const rows = fill.indexOf("'proposals.share.panel.listing'");
        const checks = fill.indexOf("'proposals.share.panel.checking'");
        expect(rows).toBeGreaterThan(-1);
        expect(checks).toBeGreaterThan(rows);
        // Faze slojeva nema: otvaranje popisa ne crta ništa po karti.
        expect(fill).not.toContain("'proposals.share.panel.drawing'");
        // Obje faze staju ako se panel zatvorio.
        expect(fill.match(/if \(!await inChunks\(/g) || []).toHaveLength(2);
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s imenuje obje faze, s brojačem', locale => {
        const panel = JSON.parse(read(`../../frontend/i18n/${locale}.json`)).proposals.share.panel;
        for (const key of ['listing', 'checking']) {
            expect(panel[key], `${locale} nema ${key}`).toBeTruthy();
            expect(panel[key]).toContain('{{done}}');
            expect(panel[key]).toContain('{{total}}');
        }
    });
});

// Ne provjerava crtanje (za to treba preglednik), nego da pravilo postoji: gumb Objavi u retku zadrži
// centriranje kakav god display dobio — <button> kao flex KONTEJNER gubi centriranje koje inače radi
// sam, i natpis padne u gornji lijevi kut kutije visoke 40px (.btn min-height). JS ga samo skriva i
// otkriva (atribut hidden), ne razmješta.
describe('natpis na gumbu za objavu', () => {
    const css = read('../../frontend/css/proposals.css');

    it('centriran je u oba smjera, pa mu display ne može pobjeći', () => {
        const rule = sliceBetween(css, '.share-plan-row .btn {', '}');
        expect(rule).toContain('align-items: center;');
        expect(rule).toContain('justify-content: center;');
        expect(rule).toContain('text-align: center;');
    });

    it('JS i dalje samo pokazuje i skriva, ne razmješta', () => {
        const state = sliceBetween(dialog, 'const updateRowState = (key) => {', 'const onCheckboxChange');
        expect(state).toContain('controls.publishBtn.hidden = !!state.cid;');
        expect(state).toContain('controls.publishedLabel.hidden = !state.cid;');
        expect(state).not.toContain('alignItems');
        expect(state).not.toContain('.style.');
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
        expect(button).toContain('mapShell.share');
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s zna reći oboje', locale => {
        const dict = JSON.parse(read(`../../frontend/i18n/${locale}.json`));
        expect(dict.sidebar.proposals.shareButtonPreparing).toBeTruthy();
        const checking = dict.proposals.share.panel.checking;
        expect(checking).toBeTruthy();
        expect(checking).toContain('{{done}}');
        expect(checking).toContain('{{total}}');
    });
});
