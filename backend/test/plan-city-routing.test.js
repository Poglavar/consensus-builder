// A named-plan link has to put the app in the plan's city BEFORE it fetches anything, because
// parcel requests are routed by the current city and the default is New York. Opening the Sibenik
// plan on an untouched default sent 2,985 parcel lookups to /parcel-nyc, every one of them a 400,
// with no prompt: the per-proposal city check reads payload.city, which is null on a proposal
// record. The plan record carries the city, and this is what acts on it.
//
// Executed, not scanned: the function is lifted out of core.js and run against fake city managers,
// so each branch is exercised for what it DOES — navigate, defer, or leave well alone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/core.js', import.meta.url)), 'utf8');

function loadEnsurePlanCity(sandbox) {
    const start = source.indexOf('async function ensurePlanCity(');
    if (start < 0) throw new Error('core.js no longer declares ensurePlanCity');
    const end = source.indexOf('\n}\n', start);
    if (end < 0) throw new Error('could not find the end of ensurePlanCity');
    const context = vm.createContext(sandbox);
    vm.runInContext(
        `${source.slice(start, end + 2)}\nglobalThis.__ensurePlanCity = ensurePlanCity;`,
        context,
        { filename: 'ensure-plan-city.js' }
    );
    return context.__ensurePlanCity;
}

function makeSandbox({ current = 'new_york', stored = false, promptResult = false, navigateThrows = false } = {}) {
    const calls = { navigated: [], prompted: [] };
    const window = {
        CityConfigManager: {
            getCurrentCityId: () => current,
            hasStoredCityId: () => stored,
            navigateToCity: (id) => {
                if (navigateThrows) throw new Error('navigation blocked');
                calls.navigated.push(id);
                return true;
            }
        }
    };
    const sandbox = {
        window,
        console: { log() {}, warn() {} },
        promptCityMismatchForProposal: async (id) => { calls.prompted.push(id); return promptResult; }
    };
    sandbox.globalThis = sandbox;
    return { sandbox, calls };
}

describe('a named plan settles its city before loading', () => {
    it('switches away from an untouched default, and tells the caller to stop', async () => {
        const { sandbox, calls } = makeSandbox({ current: 'new_york', stored: false });
        const ensurePlanCity = loadEnsurePlanCity(sandbox);

        await expect(ensurePlanCity('sibenik')).resolves.toBe(true);
        expect(calls.navigated).toEqual(['sibenik']);
        expect(calls.prompted, 'asked about a city the visitor never chose').toEqual([]);
    });

    it('does nothing when the plan is already in the current city', async () => {
        const { sandbox, calls } = makeSandbox({ current: 'sibenik', stored: false });
        const ensurePlanCity = loadEnsurePlanCity(sandbox);

        await expect(ensurePlanCity('sibenik')).resolves.toBe(false);
        expect(calls.navigated).toEqual([]);
        expect(calls.prompted).toEqual([]);
    });

    it('defers to the prompt when the visitor picked their city deliberately', async () => {
        const { sandbox, calls } = makeSandbox({ current: 'zagreb', stored: true, promptResult: true });
        const ensurePlanCity = loadEnsurePlanCity(sandbox);

        await expect(ensurePlanCity('sibenik')).resolves.toBe(true);
        expect(calls.navigated, 'overrode a city the visitor chose').toEqual([]);
        expect(calls.prompted).toEqual(['sibenik']);
    });

    it('passes the prompt\'s answer back, so a declined switch does not stop the load', async () => {
        const { sandbox } = makeSandbox({ current: 'zagreb', stored: true, promptResult: false });
        const ensurePlanCity = loadEnsurePlanCity(sandbox);

        await expect(ensurePlanCity('sibenik')).resolves.toBe(false);
    });

    it('stays out of the way when there is no city to act on', async () => {
        const { sandbox, calls } = makeSandbox({ current: 'new_york', stored: false });
        const ensurePlanCity = loadEnsurePlanCity(sandbox);

        for (const value of [null, undefined, '']) {
            await expect(ensurePlanCity(value)).resolves.toBe(false);
        }
        expect(calls.navigated).toEqual([]);
    });

    // Progress must never be the thing that breaks a load: a plan that cannot switch city is worse
    // off, but it should still open rather than throw out of the route handler.
    it('survives a manager that throws, and lets the load continue', async () => {
        const { sandbox, calls } = makeSandbox({ current: 'new_york', stored: false, navigateThrows: true });
        const ensurePlanCity = loadEnsurePlanCity(sandbox);

        await expect(ensurePlanCity('sibenik')).resolves.toBe(false);
        expect(calls.navigated).toEqual([]);
    });

    it('does nothing without a city manager at all', async () => {
        const sandbox = { window: {}, console: { log() {}, warn() {} } };
        sandbox.globalThis = sandbox;
        const ensurePlanCity = loadEnsurePlanCity(sandbox);

        await expect(ensurePlanCity('sibenik')).resolves.toBe(false);
    });
});
