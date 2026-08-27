// A reload replays the whole plan, and the status log said almost nothing about it.
//
// The "Applied ..." line came from each type's own tail, so buildings, structures, readjustments and
// merges each had one and ROADS had none at all — the road path derives its fabric and returns
// without a tail. On a plan with a hundred corridors that is a long silence with nothing in the log
// to say the app is working rather than wedged. And nothing anywhere announced the START of an
// apply, so even the types that spoke only spoke once it was over.
//
// Every type funnels through _runProposalApplyWithSummary, so that is where both lines belong.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const manager = read('../../frontend/js/proposal-manager.js');

// The announcer and its vocabulary, lifted and run for real.
function loadAnnouncer() {
    const start = manager.indexOf('const _APPLY_KIND_WORDS = {');
    expect(start, '_APPLY_KIND_WORDS not found').toBeGreaterThan(-1);
    const end = manager.indexOf('async function _runProposalApplyWithSummary(', start);
    expect(end, '_runProposalApplyWithSummary not found').toBeGreaterThan(start);
    const body = manager.slice(start, end);
    const applyRoute = require('../../frontend/js/proposals/apply/route.js');
    // eslint-disable-next-line no-new-func
    const factory = new Function('applyRoute', 'updateStatus', `${body} return { _proposalApplyKind, _announceApply };`);
    const said = [];
    const api = factory(applyRoute, message => said.push(message));
    return { ...api, said };
}

afterEach(() => vi.restoreAllMocks());

describe('what kind of thing is being applied', () => {
    const { _proposalApplyKind } = loadAnnouncer();

    it.each([
        ['road-track', 'road'],
        ['reparcellization', 'land readjustment'],
        ['decide-later', 'merge'],
        ['park', 'park'],
        ['square', 'square'],
        ['lake', 'lake'],
        ['buildings', 'building'],
        ['single', 'building'],
        ['row', 'row houses']
    ])('calls a %s a "%s"', (goal, word) => {
        expect(_proposalApplyKind({ goal })).toBe(word);
    });

    it('never comes back empty, whatever the record says', () => {
        expect(_proposalApplyKind({ goal: 'something-new' })).toBe('something-new');
        expect(_proposalApplyKind({})).toBe('proposal');
        expect(_proposalApplyKind(null)).toBe('proposal');
    });

    it('says nothing when there is no status log to say it to', () => {
        // The announcer is called from the apply path, which also runs in tests and in node.
        expect(() => loadAnnouncer()._announceApply('x')).not.toThrow();
    });
});

describe('two lines per proposal, whatever its type', () => {
    const summary = manager.slice(
        manager.indexOf('async function _runProposalApplyWithSummary('),
        manager.indexOf('async function _runProposalMutationBoundary(')
    );

    it('announces the start and the end', () => {
        // Every announcement carries the proposal id, so the status log can offer to go there.
        // The VERB is a variable now — a replay says "Re-deriving"/"Re-derived" where a genuine
        // apply says "Applying"/"Applied" — so this pins the shape and the id, not the wording.
        expect(summary).toMatch(/_announceApply\(`\$\{gerund\} \$\{kind\} \$\{label\}\.\.\.`, proposalId\)/);
        expect(summary).toMatch(/_announceApply\(`\$\{verb\} \$\{kind\} \$\{label\}`, proposalId\)/);
    });

    it('distinguishes a replay from an apply, so a log of 299 lines says which happened', () => {
        expect(summary).toContain("const replaying = !!(ProposalManager && ProposalManager._rebuildInProgress === true);");
        expect(summary).toMatch(/const verb = replaying \? 'Re-derived' : 'Applied';/);
        expect(summary).toMatch(/const gerund = replaying \? 'Re-deriving' : 'Applying';/);
    });

    it('says so when an apply refuses, rather than going quiet', () => {
        expect(summary.match(/_announceApply\(`Could not apply/g) || []).toHaveLength(2); // false, and throw
    });

    it('defers per-member status DOM updates while a shared plan owns the progress overlay', () => {
        expect(summary).toContain('options.deferPresentation === true');
        expect(summary).toContain('if (!deferPresentation) _announceApply');
    });
});

// Two lines, not five: the per-type tails used to write their own "Applied ..." message, which would
// now be a second copy of the shared one.
describe('the per-type tails no longer duplicate it', () => {
    it.each([
        ['buildings.js', 'Applied building proposal'],
        ['structures.js', 'Applied ${kind} proposal'],
        ['parcels.js', 'Applied reparcellization proposal'],
        ['parcels.js', 'Applied decide later proposal']
    ])('%s no longer writes "%s"', (file, message) => {
        expect(read(`../../frontend/js/proposals/apply/${file}`)).not.toContain(message);
    });

    it('still refreshes the UI after applying', () => {
        ['buildings.js', 'structures.js', 'parcels.js'].forEach(file => {
            expect(read(`../../frontend/js/proposals/apply/${file}`)).toContain('refreshProposalUIAfterApply()');
        });
    });
});

// "Loaded 0 buildings" sat in the same log as the proposal applies and read like a proposal that
// produced nothing. It is the surveyed-building reference layer for the viewport — and in Šibenik it
// was asking for GDI, the ZAGREB survey, which is why the answer was always zero.
describe('the existing-buildings fetch', () => {
    const mapCore = read('../../frontend/js/map-core.js');
    const dataSource = read('../../frontend/js/data-source.js');

    // The gate, lifted and run against real city configs.
    function loadGate() {
        const start = dataSource.indexOf('    function buildBuildingRequestParams(bbox, source = \'gdi\') {');
        expect(start, 'buildBuildingRequestParams not found').toBeGreaterThan(-1);
        const end = dataSource.indexOf('    function initDataSourceUI() {', start);
        const body = dataSource.slice(start, end);
        // eslint-disable-next-line no-new-func
        const factory = new Function('CityConfigManager', 'getBackendBase', 'URLSearchParams',
            `${body} return buildBuildingRequestParams;`);
        return (config) => factory(
            { getCurrentCityConfig: () => config },
            () => 'http://backend',
            URLSearchParams
        );
    }
    const gateFor = loadGate();
    const BBOX = '1,2,3,4';

    it('asks for GDI in Zagreb, which declares no buildings source at all', () => {
        expect(gateFor({ id: 'zagreb' })(BBOX)).toMatchObject({ url: expect.stringContaining('source=gdi') });
        expect(gateFor({ id: 'zagreb', buildings: { source: 'gdi' } })(BBOX)).toBeTruthy();
    });

    it('does not ask for GDI where the footprints are Overture — Šibenik, Split, Belgrade', () => {
        expect(gateFor({ id: 'sibenik', buildings: { source: 'overture' } })(BBOX)).toBeNull();
        expect(gateFor({ id: 'new_york', buildings: { source: 'nyc' } })(BBOX)).toBeNull();
        expect(gateFor({ id: 'ljubljana', buildings: { source: 'none' } })(BBOX)).toBeNull();
    });

    it('still asks for DGU anywhere — it is the national registry, with its own toggle', () => {
        const req = gateFor({ id: 'sibenik', buildings: { source: 'overture' } })(BBOX, 'dgu');
        expect(req).toMatchObject({ url: expect.stringContaining('source=dgu') });
    });

    it('says nothing at all when there is nothing to fetch', () => {
        // The request is built BEFORE the status line, so a city with no GDI writes neither line.
        const start = mapCore.indexOf('async function fetchBuildings(boundsOverride = null, options = {}) {');
        expect(start, 'fetchBuildings not found').toBeGreaterThan(-1);
        const fetchFn = mapCore.slice(start, mapCore.indexOf('// The DGU CADASTRE reference layer', start));
        expect(fetchFn.indexOf('if (!req && !providerCity) return;'))
            .toBeLessThan(fetchFn.indexOf("updateStatus('Fetching existing buildings...')"));
    });

    it('fills the pool from the city\'s own provider when it is not GDI', () => {
        // Šibenik's stock is Overture, served by the same POST /buildings/footprints the urban-rule
        // editor reads. Without this the pool stayed empty there and a road could never find a
        // building to demolish.
        expect(mapCore).toContain('function footprintProviderCity()');
        expect(mapCore).toContain("if (!source || source === 'none' || source === 'gdi') return null;");
        expect(mapCore).toContain('await loadProviderFootprints(bounds, providerCity)');
        const loader = mapCore.slice(
            mapCore.indexOf('async function loadProviderFootprints(bounds, city)'),
            mapCore.indexOf('// Fetch buildings from data source.')
        );
        expect(loader).toContain('/buildings/footprints');
        // The provider serves WGS84 — converting it as if it were EPSG:3765 would put every
        // footprint in the sea.
        expect(loader).not.toContain('convertGeoJSON');
        // corridor-tunnel's identity accepts properties.id for the non-Zagreb sources, so these
        // are cut, tunnelled and demolished exactly like GDI objects.
        expect(loader).toContain('id: entry.id');
        expect(loader).toContain('truncated: payload.truncated === true');
    });

    it('only talks when the user asked to see them', () => {
        // Ticking the reference layer on is a request; a demolition scan preloading the ground
        // under a proposal is not, and on a reload of a big plan it fires once per proposal.
        expect(mapCore).toContain('async function fetchBuildings(boundsOverride = null, options = {}) {');
        expect(mapCore).toContain('const announce = options && options.announce === true;');
        expect(mapCore).toContain("if (announce && typeof updateStatus === 'function') {");
        expect(read('../../frontend/js/sidebar-management.js'))
            .toContain('fetchBuildings(null, { announce: true })');
        // A FAILURE still speaks, asked for or not — a silent one leaves a road cutting against a
        // pool that never loaded.
        expect(mapCore).toContain("updateStatus('Error fetching building data. Please try again.')");
    });

    it('names them as existing, and does not report a zero as a load', () => {
        expect(mapCore).toContain("updateStatus('Fetching existing buildings...')");
        expect(mapCore).toContain('`Loaded ${surveyed} existing buildings`');
        expect(mapCore).toContain("'No existing buildings surveyed here'");
        expect(mapCore).not.toContain('`Loaded ${(data.features || []).length} buildings`');
    });
});

// A reload does NOT apply corridors one at a time — they are takes, folded into the cadastre in one
// derivation, and each member is then just flipped to applied. So the type a plan has the most of
// was the one type a reload never mentioned, and the log filled with buildings while the roads that
// take the longest went by in silence.
describe('the corridor derivation announces itself', () => {
    const managerSource = read('../../frontend/js/proposal-manager.js');

    function loadPhrase() {
        const start = managerSource.indexOf('function _corridorCountPhrase(takes) {');
        expect(start, '_corridorCountPhrase not found').toBeGreaterThan(-1);
        const end = managerSource.indexOf('// EVERY type funnels through here', start);
        // eslint-disable-next-line no-new-func
        return new Function(`${managerSource.slice(start, end)} return _corridorCountPhrase;`)();
    }
    const phrase = loadPhrase();

    it('counts roads and tracks apart, because the number is the message', () => {
        expect(phrase([{ isTrack: false }, { isTrack: false }])).toBe('2 roads');
        expect(phrase([{ isTrack: true }])).toBe('1 track');
        expect(phrase([{ isTrack: false }, { isTrack: true }, { isTrack: true }])).toBe('1 road and 2 tracks');
        expect(phrase([])).toBe('0 roads');
        expect(phrase(null)).toBe('0 roads');
    });

    it('says it on the way in and on the way out, around the one derivation', () => {
        const pass = managerSource.slice(
            managerSource.indexOf('const componentTakes = this._appliedCorridorTakes(appliedList);'),
            managerSource.indexOf('const corridorIds = new Set(componentTakes.map(take => take.id));')
        );
        expect(pass).toContain('_announceApply(`Applying ${_corridorCountPhrase(componentTakes)}...`)');
        expect(pass).toContain('_announceApply(`Applied ${_corridorCountPhrase(componentTakes)}`)');
        // Nothing to say when the plan has no corridors at all.
        expect(pass.match(/if \(componentTakes\.length\)/g) || []).toHaveLength(2);
    });
});
