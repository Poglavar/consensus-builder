// Opening shared designs (frontend/js/proposals/sharing-routes.js; plan-design-agreement.md, M2): a
// /designs/<cid>,<cid> link is read from the index, imported parked, applied in package order through
// the one-boundary replay materializer, framed on its latest-authored design and summarised. The
// progress labels, the materializer and the route itself run here against stubs of what they call.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const Cid = createRequire(import.meta.url)('../../frontend/js/cid.js');

const source = readFileSync(
    new URL('../../frontend/js/proposals/sharing-routes.js', import.meta.url),
    'utf8'
);

function loadSharedImportHelpers(overrides = {}) {
    const browserWindow = overrides.window || {};
    const context = {
        console,
        URLSearchParams,
        isProposalCurrentlyApplied: proposal => proposal?.applied === true,
        ...overrides,
        window: browserWindow
    };
    vm.createContext(context);
    vm.runInContext(
        `${source}\nthis.sharedImportHelpersForTest = { materializeQueuedSharedProposals, sharedPlanProgressView, sharedCorridorCountPhrase, latestAuthoredDesignId, handleSharedDesignRoute, context: this };`,
        context
    );
    return context.sharedImportHelpersForTest;
}

describe('shared-plan progress labels', () => {
    it('waits for a private draft import before entering its requested 3D view', () => {
        const setTimeout = vi.fn(), enterUrlDrivenView = vi.fn();
        const helpers = loadSharedImportHelpers({ window: { location: { pathname: '/designs', search: '?draft=https%3A%2F%2Fapp.example%2Fmcp%2Fpreviews%2Ftoken&3d' } },
            url3DModeHandled: false, is3DModeRequestedFromUrl: () => true, map: {}, setTimeout, enterUrlDrivenView });
        helpers.context.handleStandalone3DModeFromUrl();
        expect(setTimeout).not.toHaveBeenCalled();
        expect(enterUrlDrivenView).not.toHaveBeenCalled();
        helpers.context.window.location = { pathname: '/', search: '?3d' };
        helpers.context.handleStandalone3DModeFromUrl();
        expect(setTimeout).toHaveBeenCalledTimes(1);
    });
    const t = (_key, fallback, params = {}) => String(fallback).replace(/\{\{(\w+)\}\}/g,
        (_match, name) => Object.prototype.hasOwnProperty.call(params, name) ? params[name] : _match);

    it('names the full corridor batch instead of the first track in it', () => {
        const { sharedPlanProgressView } = loadSharedImportHelpers();
        const view = sharedPlanProgressView({
            phase: 'corridor-start',
            roads: 130,
            tracks: 1
        }, t);

        expect(view.status).toBe('Preparing 130 roads and 1 track…');
        expect(view.status).not.toContain('Sibenik 4');
    });

    it('reports parcel cutting as its own measured phase', () => {
        const { sharedPlanProgressView } = loadSharedImportHelpers();
        const view = sharedPlanProgressView({ phase: 'fabric-arrange', done: 75, total: 131 }, t);

        expect(view.status).toBe('Cutting affected cadastral parcels (75/131)…');
        expect(view.progress).toEqual({ done: 75, total: 131 });
    });

    it('renders the ground-load counts without leaving template placeholders', () => {
        const { sharedPlanProgressView } = loadSharedImportHelpers();
        const view = sharedPlanProgressView({ phase: 'ground-load-ids', done: 0, total: 3, requested: 2, cached: 1 }, t);
        expect(view.status).toBe('Loading 2 missing cadastral parcels; 1 already cached…');
        expect(view.progress).toEqual({ done: 1, total: 3 });
    });

    it('distinguishes waiting on an existing request from starting another fetch', () => {
        const { sharedPlanProgressView } = loadSharedImportHelpers();
        const view = sharedPlanProgressView({ phase: 'ground-wait-footprints' }, t);

        expect(view.status).toBe('Waiting for an existing footprint-ground request…');
    });

    it('names building lookup and final map refresh as separate phases', () => {
        const { sharedPlanProgressView } = loadSharedImportHelpers();
        const buildings = sharedPlanProgressView({
            phase: 'building-ground-progress',
            done: 1,
            total: 2,
            covered: 17
        }, t);
        const strips = sharedPlanProgressView({ phase: 'corridor-strips' }, t);

        expect(buildings.status).toBe('Loading affected buildings (batch 1/2, 17 areas covered)…');
        expect(strips.status).toBe('Refreshing road and track surfaces…');
    });
});

describe('materializing a shared link', () => {
    it('gives the browser frames for cached-member progress and the two final phases', async () => {
        let clock = 0;
        const actions = [];
        const records = new Map([
            ['a', { proposalId: 'a', title: 'Block A', goal: 'building', buildingProposal: {} }],
            ['b', { proposalId: 'b', title: 'Block B', goal: 'building', buildingProposal: {} }]
        ]);
        const proposalStorage = {
            getProposal: id => records.get(id) || null,
            getAllProposals: () => [],
            beginBatch: vi.fn(),
            endBatch: vi.fn(),
            save: vi.fn()
        };
        const ProposalManager = {
            applyProposal: vi.fn(async id => {
                actions.push(`apply:${id}`);
                return true;
            }),
            _refreshUIAfterProposalChange: vi.fn(() => actions.push('refresh'))
        };
        const t = (_key, fallback, params = {}) => String(fallback).replace(/\{\{(\w+)\}\}/g,
            (_match, name) => Object.prototype.hasOwnProperty.call(params, name) ? params[name] : _match);
        const yieldToBrowser = vi.fn(async () => actions.push('paint'));
        const updateProposalLoadOverlay = vi.fn(view => actions.push(`status:${view.status}`));
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager,
            proposalStorage,
            applyRoute: { normalizeGoalKey: goal => goal, isBuildingGoal: goal => goal === 'building' },
            performance: { now: () => { clock += 100; return clock; } },
            window: { yieldToBrowser },
            getShareI18nHelper: () => t,
            updateProposalLoadOverlay
        });

        await materializeQueuedSharedProposals(['a', 'b']);

        expect(yieldToBrowser).toHaveBeenCalledTimes(4);
        expect(actions).toEqual([
            'status:Applying Block A (1/2)…',
            'paint',
            'apply:a',
            'status:Applying Block B (2/2)…',
            'paint',
            'apply:b',
            'status:Refreshing the map and designs list…',
            'paint',
            'refresh',
            'status:Saving applied designs…',
            'paint'
        ]);
    });

    it('time-budgets intermediate paints instead of yielding after every fast member', async () => {
        let clock = 0;
        const records = new Map(['a', 'b', 'c', 'd'].map(id => [id, {
            proposalId: id,
            title: `Block ${id.toUpperCase()}`,
            goal: 'building',
            buildingProposal: {}
        }]));
        const paint = vi.fn(async () => {});
        const ProposalManager = {
            applyProposal: vi.fn(async id => {
                clock += ({ a: 20, b: 70, c: 10, d: 10 })[id];
                return true;
            })
        };
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager,
            proposalStorage: {
                getProposal: id => records.get(id) || null,
                getAllProposals: () => [],
                save: vi.fn()
            },
            applyRoute: { normalizeGoalKey: goal => goal, isBuildingGoal: goal => goal === 'building' },
            performance: { now: () => clock },
            window: { yieldToBrowser: paint }
        });

        await materializeQueuedSharedProposals(['a', 'b', 'c', 'd']);

        // First member, the first member after the 80 ms budget, final member, presentation, save.
        expect(paint).toHaveBeenCalledTimes(5);
    });

    it('materialises only the queued ids through scoped apply, never a whole-plan rebuild', async () => {
        const applyProposal = vi.fn(async id => id !== 'bad');
        const ProposalManager = { applyProposal };
        const proposalStorage = {
            getProposal: id => ({ proposalId: id, goal: id === 'new-b' ? 'road-track' : 'building' })
        };
        const applyRoute = { normalizeGoalKey: goal => goal };
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({ ProposalManager, proposalStorage, applyRoute });

        const result = await materializeQueuedSharedProposals(['new-a', 'bad', 'new-b', 'new-a']);

        expect(result).toEqual({
            appliedIds: ['new-b', 'new-a'],
            failedIds: ['bad']
        });
        // Shared members go straight through the one-boundary replay materializer. The live
        // unrelated-holder check is a separate in-memory gate, not the interactive rival path.
        expect(applyProposal.mock.calls.map(([id]) => id)).toEqual(['new-b', 'new-a', 'bad']);
        applyProposal.mock.calls.forEach(([id, options]) => {
            expect(options.silent, id).toBe(true);
            expect(options.replay, id).toBe(true);
            expect(options.deferPresentation, id).toBe(true);
        });
        expect(ProposalManager.rebuildAppliedFabric).toBeUndefined();
    });

    it('refuses an externally-held ordinary member before replay without stopping its siblings', async () => {
        const applyProposal = vi.fn(async () => true);
        const alreadyStanding = { proposalId: 'outside', goal: 'building', buildingProposal: {}, applied: true };
        // A design of this link that was already on the map (the route's skipped local copy).
        const planMate = { proposalId: 'standing-mate', goal: 'building', buildingProposal: {}, applied: true };
        const records = new Map([
            ['clear', { proposalId: 'clear', goal: 'building', buildingProposal: {} }],
            ['held', { proposalId: 'held', goal: 'building', buildingProposal: {} }],
            ['outside', alreadyStanding],
            ['standing-mate', planMate]
        ]);
        const validateSharedProposalGround = vi.fn(id => ({ ok: id !== 'held', blockers: id === 'held' ? [{}] : [] }));
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager: { applyProposal, validateSharedProposalGround },
            proposalStorage: {
                getProposal: id => records.get(id) || null,
                getAllProposals: () => [...records.values()]
            },
            applyRoute: { normalizeGoalKey: goal => goal }
        });

        const result = await materializeQueuedSharedProposals(['clear', 'held'], {
            planMemberIds: new Set(['standing-mate'])
        });

        expect(result).toEqual({ appliedIds: ['clear'], failedIds: ['held'] });
        expect(applyProposal).toHaveBeenCalledOnce();
        expect(applyProposal).toHaveBeenCalledWith('clear', {
            replay: true,
            silent: true,
            deferPresentation: true
        });
        expect(validateSharedProposalGround).toHaveBeenCalledTimes(2);
        const membership = validateSharedProposalGround.mock.calls[0][1];
        expect([...membership].sort()).toEqual(['clear', 'held', 'standing-mate']);
        expect(validateSharedProposalGround.mock.calls[0][2], 'plan-mates were scanned as external holders')
            .toEqual([alreadyStanding]);
    });

    it('persists and refreshes presentation once for the whole materialization batch', async () => {
        let batchDepth = 0;
        let pending = false;
        let writes = 0;
        const records = new Map([
            ['a', { proposalId: 'a', goal: 'building', buildingProposal: {} }],
            ['b', { proposalId: 'b', goal: 'building', buildingProposal: {} }]
        ]);
        const proposalStorage = {
            getProposal: id => records.get(id) || null,
            beginBatch: vi.fn(() => { batchDepth += 1; }),
            save: vi.fn(() => {
                if (batchDepth) pending = true;
                else writes += 1;
            }),
            endBatch: vi.fn(() => {
                batchDepth -= 1;
                if (!batchDepth && pending) {
                    pending = false;
                    writes += 1;
                }
            })
        };
        const refresh = vi.fn();
        const applyProposal = vi.fn(async id => {
            proposalStorage.save();
            return id !== 'b';
        });
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager: {
                applyProposal,
                validateSharedProposalGround: () => ({ ok: true, blockers: [] }),
                _refreshUIAfterProposalChange: refresh
            },
            proposalStorage,
            applyRoute: { normalizeGoalKey: goal => goal }
        });

        const result = await materializeQueuedSharedProposals(['a', 'b']);

        expect(result).toEqual({ appliedIds: ['a'], failedIds: ['b'] });
        expect(proposalStorage.beginBatch).toHaveBeenCalledOnce();
        expect(proposalStorage.endBatch).toHaveBeenCalledOnce();
        expect(writes).toBe(1);
        expect(refresh).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledWith(null);
    });

    it('materialises package roads in one batch, then parcel layouts, buildings and public spaces', async () => {
        const applyProposal = vi.fn(async () => true);
        const materializeCorridorBatch = vi.fn(async ids => ({
            ok: true,
            appliedIds: ids,
            failedIds: []
        }));
        const records = new Map([
            ['plots', { goal: 'parcel-layout' }],
            ['park', { goal: 'park' }],
            ['building-a', { goal: 'single', buildingProposal: {} }],
            ['building-b', { goal: 'single', buildingProposal: {} }],
            ['road-a', { goal: 'road-track' }],
            ['road-b', { roadProposal: { definition: {} } }]
        ]);
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager: { applyProposal, materializeCorridorBatch },
            proposalStorage: { getProposal: id => records.get(id) || null },
            applyRoute: { normalizeGoalKey: goal => goal }
        });

        const result = await materializeQueuedSharedProposals([
            'park', 'building-a', 'road-a', 'building-b', 'plots', 'road-b'
        ]);

        expect(materializeCorridorBatch).toHaveBeenCalledWith(
            ['road-a', 'road-b'],
            expect.objectContaining({
                deferPresentation: true,
                deferSave: true,
                onProgress: expect.any(Function)
            })
        );
        expect(applyProposal.mock.calls.map(call => call[0]))
            .toEqual(['plots', 'building-a', 'building-b', 'park']);
        expect(result).toEqual({
            appliedIds: ['road-a', 'road-b', 'plots', 'building-a', 'building-b', 'park'],
            failedIds: []
        });
    });

    it('keeps one externally-held road out of the corridor batch without failing clear roads', async () => {
        const applyProposal = vi.fn(async () => true);
        const materializeCorridorBatch = vi.fn(async ids => ({
            ok: true,
            appliedIds: ids,
            failedIds: []
        }));
        const outside = { proposalId: 'outside', goal: 'building', applied: true };
        const records = new Map([
            ['road-clear-a', { proposalId: 'road-clear-a', goal: 'road-track' }],
            ['road-held', { proposalId: 'road-held', goal: 'road-track' }],
            ['road-clear-b', { proposalId: 'road-clear-b', goal: 'road-track' }],
            ['building', { proposalId: 'building', goal: 'single', buildingProposal: {} }],
            ['outside', outside]
        ]);
        const validateSharedProposalGround = vi.fn(id => ({
            ok: id !== 'road-held',
            blockers: id === 'road-held' ? [outside] : []
        }));
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager: { applyProposal, materializeCorridorBatch, validateSharedProposalGround },
            proposalStorage: {
                getProposal: id => records.get(id) || null,
                getAllProposals: () => [...records.values()]
            },
            applyRoute: { normalizeGoalKey: goal => goal }
        });

        const result = await materializeQueuedSharedProposals([
            'road-clear-a', 'road-held', 'road-clear-b', 'building'
        ]);

        expect(materializeCorridorBatch).toHaveBeenCalledOnce();
        expect(materializeCorridorBatch).toHaveBeenCalledWith(
            ['road-clear-a', 'road-clear-b'],
            expect.objectContaining({ deferPresentation: true, deferSave: true })
        );
        expect(validateSharedProposalGround.mock.calls.map(call => call[0]))
            .toEqual(['road-clear-a', 'road-held', 'road-clear-b', 'building']);
        expect(validateSharedProposalGround.mock.calls[0][2]).toEqual([outside]);
        expect(applyProposal).toHaveBeenCalledWith('building', {
            replay: true,
            silent: true,
            deferPresentation: true
        });
        expect(result).toEqual({
            appliedIds: ['road-clear-a', 'road-clear-b', 'building'],
            failedIds: ['road-held']
        });
    });

    it('uses the ordinary corridor-before-layout order regardless of legacy metadata', async () => {
        const events = [];
        const applyProposal = vi.fn(async id => { events.push(id); return true; });
        const materializeCorridorBatch = vi.fn(async ids => {
            events.push(`roads:${ids.join('+')}`);
            return { ok: true, appliedIds: ids, failedIds: [] };
        });
        const validateSharedProposalGround = vi.fn(() => ({ ok: true }));
        const records = new Map([
            ['plots', { goal: 'parcel-layout', coordinatedPlanId: 'legacy-plan' }],
            ['park', { goal: 'park', coordinatedPlanId: 'legacy-plan' }],
            ['building', { goal: 'single', buildingProposal: {}, coordinatedPlanId: 'legacy-plan' }],
            ['road-a', { goal: 'road-track', coordinatedPlanId: 'legacy-plan' }],
            ['road-b', { roadProposal: { definition: {} }, coordinatedPlanId: 'legacy-plan' }]
        ]);
        const { materializeQueuedSharedProposals } = loadSharedImportHelpers({
            ProposalManager: { applyProposal, materializeCorridorBatch, validateSharedProposalGround },
            proposalStorage: { getProposal: id => records.get(id) || null },
            applyRoute: {
                normalizeGoalKey: goal => goal,
                isBuildingGoal: goal => goal === 'single'
            }
        });

        const result = await materializeQueuedSharedProposals([
            'park', 'road-a', 'building', 'plots', 'road-b'
        ]);

        expect(events).toEqual(['roads:road-a+road-b', 'plots', 'building', 'park']);
        expect(validateSharedProposalGround.mock.calls.map(([id]) => id))
            .toEqual(['road-a', 'road-b', 'plots', 'building', 'park']);
        expect(applyProposal.mock.calls).toEqual([
            ['plots', { replay: true, silent: true, deferPresentation: true }],
            ['building', { replay: true, silent: true, deferPresentation: true }],
            ['park', { replay: true, silent: true, deferPresentation: true }]
        ]);
        expect(result).toEqual({
            appliedIds: ['road-a', 'road-b', 'plots', 'building', 'park'],
            failedIds: []
        });
    });

    // Deleted behaviour, pinned so it cannot come back. A partly applied plan used to be taken off
    // the map entirely — every standing member unapplied one at a time — and then re-applied. It
    // could not converge: one member that can never apply leaves the plan permanently "partly
    // applied", so every re-open unapplied 298 members to re-derive the same 298 (measured on the
    // Sibenik plan). What is on the map now stays on the map; only the missing members are applied.
    it('never takes standing members off the map to refresh a partly applied plan', () => {
        expect(source, 'the partial-plan reset is back')
            .not.toMatch(/resetPartiallyAppliedSharedPlan/);
        expect(source, 'the plan route unapplies members again')
            .not.toMatch(/coveredIncomingIds\.size > 0 && coveredIncomingIds\.size < totalProposals/);
        // Rebuilding the applied composition is the boot replay, reported in the status line
        // while the shared-proposal link waits for it to finish.
        expect(source).toMatch(/await ProposalManager\.reapplyAppliedProposals\(\{\s*onProgress: window\.ReplayStatus\.statusReporter\(tShare,/);
    });
});

describe('the design a shared link frames', () => {
    it('is the latest-authored of the standing designs, the later one on a tie', () => {
        const records = new Map([
            ['old', { proposalId: 'old', createdAt: '2026-10-01T10:00:00.000Z' }],
            ['new', { proposalId: 'new', createdAt: '2026-10-20T10:00:00.000Z' }],
            ['same-a', { proposalId: 'same-a', createdAt: '2026-10-05T10:00:00.000Z' }],
            ['same-b', { proposalId: 'same-b', createdAt: '2026-10-05T10:00:00.000Z' }],
            ['undated', { proposalId: 'undated' }]
        ]);
        const { latestAuthoredDesignId } = loadSharedImportHelpers({ proposalStorage: { getProposal: id => records.get(id) || null } });

        expect(latestAuthoredDesignId(['old', 'new', 'undated'])).toBe('new');
        expect(latestAuthoredDesignId(['same-a', 'same-b'])).toBe('same-b');
        expect(latestAuthoredDesignId(['gone', 'undated'])).toBe('undated');
        expect(latestAuthoredDesignId(['gone'])).toBeNull();
        expect(latestAuthoredDesignId([])).toBeNull();
    });
});

const cidOf = text => Cid.cidOf(new TextEncoder().encode(text));
const translate = (_key, fallback, params = {}) => String(fallback).replace(/\{\{(\w+)\}\}/g,
    (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
// An index row as DesignSync.fetchDesigns hands it over (routes/designs.js serializeDesignRow).
const row = (name, { goal = 'park', authoredAt = '2026-10-10T10:00:00.000Z', city = 'zagreb', parcels = [`HR-${name}`] } = {}) => ({
    cid: cidOf(name), city, title: name, goal, parcels,
    content: { schema: 'design/v1', goal, title: name, authoredAt }
});

// A /designs link opened against stubs of everything the route calls. `designs` are the rows the index
// holds; `local` the local copies DesignSync.localCopyOf finds, by CID; `refused` the local ids the
// apply precheck refuses, with its message; `failing` the local ids whose apply fails, with the stored
// failure. A row's groundContext fixture represents a geometry-derived source switch.
function designLink({ designs = [], local = {}, refused = {}, failing = {}, held = {}, conflictChoice = 'cancel', planFailure = null, leaveForCity = true,
    wants3D = false, replayDone = true, tookOver = false, fetchError = null, arrivalView = null } = {}) {
    const records = new Map(Object.values(local).map(record => [record.proposalId, record]));
    const rows = new Map(designs.map(design => [design.cid, design]));
    const order = [];
    const takeover = { stop: vi.fn(), tookOver: () => tookOver };
    const window = {
        location: { search: "" },
        WorldEntry: { arrivalMapView: () => arrivalView },
        Cid,
        DesignSync: {
            fetchDesigns: vi.fn(async cids => {
                if (fetchError) throw fetchError;
                return {
                    rows: new Map(cids.filter(cid => rows.has(cid)).map(cid => [cid, rows.get(cid)])),
                    missing: cids.filter(cid => !rows.has(cid))
                };
            }),
            localCopyOf: vi.fn(cid => local[cid] || null),
            importDesign: vi.fn(design => {
                const payload = design.goal === 'single' ? { buildingProposal: {} } : { structureProposal: {} };
                const record = { proposalId: `design-${design.cid}`, goal: design.goal, title: design.title, createdAt: design.content.authoredAt,
                    cadastreParcelIds: design.parcels, applied: false, ...payload };
                records.set(record.proposalId, record);
                order.push(`import:${design.title}`);
                return record;
            })
        },
        CityConfigManager: { foreignGroundContextFor: design => design.groundContext || null },
        shouldSkipWelcomeForProposalLink: () => true,
        ReplayStatus: { watchUserTakeover: vi.fn(() => takeover), statusReporter: vi.fn(() => vi.fn()) },
        __claims: { cadastreParcelIdsOf: record => (record && record.cadastreParcelIds) || [] },
        __applyValidate: {
            validatePlan: vi.fn(items => {
                const blocked = items.filter(item => refused[item.proposalId])
                    .map(item => ({ proposalId: item.proposalId, verdict: { code: 'held', message: refused[item.proposalId] } }));
                return { applicable: items.filter(item => !refused[item.proposalId]), blocked, total: items.length };
            })
        },
        __applyRoute: { classifyApplyRoute: () => 'replay' }
    };
    window.CbDialog = { choice: vi.fn(async () => conflictChoice) };
    const ProposalManager = {
        _initialReapplyDone: replayDone,
        runParcelMutation: vi.fn(async (_kind, _id, operation) => {
            const before = records.size;
            const result = await operation({ _parcelMutation: { proposals: stubs.proposalStorage } });
            if (records.size !== before) stubs.proposalStorage.save();
            return result;
        }),
        reapplyAppliedProposals: vi.fn(async () => { order.push('replay'); ProposalManager._initialReapplyDone = true; }),
        applyProposal: vi.fn(async id => {
            order.push(`apply:${records.get(id).title}`);
            if (failing[id]) return false;
            records.get(id).applied = true;
            return true;
        }),
        validateSharedProposalGround: vi.fn((id, members, candidates) => {
            const blockers = (candidates || []).filter(record => record.applied && !members.has(record.proposalId) && (held[id] || []).includes(record.proposalId));
            return { ok: !blockers.length, blockers };
        }),
        applyProposalPlan: vi.fn(async (ids, options = {}) => {
            if (planFailure) { ProposalManager._lastFailedPlanApplySummary = { failed: Array.isArray(planFailure) ? planFailure : [{ reason: planFailure }] }; return false; }
            const conflicts = new Set(ids.flatMap(id => held[id] || []).filter(id => !ids.includes(id) && !(options.retainedProposalIds || []).includes(id)));
            (options.releaseProposalIds || []).forEach(id => conflicts.add(id));
            conflicts.forEach(id => { if (records.has(id)) records.get(id).applied = false; });
            ids.forEach(id => { records.get(id).applied = true; });
            return { ok: true, releasedIds: [...conflicts] };
        }),
        _refreshUIAfterProposalChange: vi.fn()
    };
    const stubs = {
        console: { log() {}, info() {}, debug() {}, warn: vi.fn(), error: vi.fn() },
        document: {},
        map: { fitBounds: vi.fn(), setView: vi.fn(), getZoom: () => 19 },
        proposalStorage: { getProposal: id => records.get(String(id)) || null, getAllProposals: () => [...records.values()], save: vi.fn(() => { order.push('save'); }) },
        ProposalManager,
        CadastralParcelRepository: { ensureIds: vi.fn(async () => { order.push('ground'); }) },
        promptCityMismatchForProposal: vi.fn(async () => leaveForCity),
        getProposalI18nHelper: () => translate,
        getShareI18nHelper: () => translate,
        formatSharedProposalLabel: (record, fallback) => (record && record.title) || String(fallback),
        getStoredApplyFailureInfo: id => (failing[id] ? { message: failing[id] } : null),
        calculateBoundsForLastAppliedProposal: vi.fn(id => ({ id, ids: [id], isValid: () => true,
            extend(bounds) { this.ids.push(...bounds.ids); return this; } })),
        focusProposalDetails: vi.fn(async () => {}),
        showProposalLoadOverlay: vi.fn(), updateProposalLoadOverlay: vi.fn(), hideProposalLoadOverlay: vi.fn(),
        updateProposalLayer: vi.fn(), updateShowProposalsButton: vi.fn(),
        showSimpleShareModal: vi.fn(), showEphemeralMessage: vi.fn(),
        escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        is3DModeRequestedFromUrl: () => wants3D,
        url3DModeHandled: false,
        enterUrlDrivenView: vi.fn()
    };
    const helpers = loadSharedImportHelpers({ ...stubs, window });
    return { ...stubs, window, records, order, takeover, context: helpers.context, open: (cids, options) => helpers.handleSharedDesignRoute(cids, options) };
}

describe('opening a /designs link', () => {
    const park = row('Park', { authoredAt: '2026-10-02T10:00:00.000Z', parcels: ['HR-1', 'HR-2'] });
    const block = row('Block', { goal: 'single', authoredAt: '2026-10-09T10:00:00.000Z', parcels: ['HR-3'] });
    const square = row('Square', { authoredAt: '2026-09-30T10:00:00.000Z', parcels: ['HR-4'] });
    const standingSquare = { proposalId: 'local-square', title: 'Square', goal: 'park', createdAt: '2026-09-30T10:00:00.000Z', applied: true };

    function conflictingLink(conflictChoice, extra = {}) {
        const old = { proposalId: 'old-tower', title: 'Tower', goal: 'single', applied: true };
        const unrelated = { proposalId: 'elsewhere', title: 'Elsewhere', goal: 'park', applied: true };
        const tower = row('Tower', { goal: 'single' });
        return { tower, ...designLink({ designs: [tower, park], local: { old, unrelated },
            held: { [`design-${tower.cid}`]: [old.proposalId] }, conflictChoice, ...extra }) };
    }

    it('warns before unapplying only the existing conflicts and applies the plan together', async () => {
        const link = conflictingLink('replace');
        const choice = link.window.CbDialog.choice;
        choice.mockImplementation(async () => {
            expect(link.records.get('old-tower').applied).toBe(true);
            expect(link.records.get(`design-${link.tower.cid}`).applied).toBe(false);
            expect(link.ProposalManager.applyProposal).not.toHaveBeenCalled();
            return 'replace';
        });
        const result = await link.open([link.tower.cid, park.cid]);
        expect(choice.mock.calls[0][0]).toContain('Tower');
        expect(choice.mock.calls[0][0]).not.toContain('Elsewhere');
        expect(choice.mock.calls[0][1].map(action => action.value)).toEqual(['replace','skip','cancel']);
        expect(link.ProposalManager.applyProposalPlan).toHaveBeenCalledExactlyOnceWith(
            [`design-${link.tower.cid}`, `design-${park.cid}`], { silent: true, onProgress: expect.any(Function) });
        expect(result.failed).toEqual([]);expect(result.omitted).toEqual([]);
        expect(link.records.get('old-tower').applied).toBe(false);
        expect(link.records.get('elsewhere').applied).toBe(true);
        expect(link.records.size).toBe(4);
    });

    it('frames the full confirmed replacement instead of restoring an off-site named-plan URL view', async () => {
        const link = conflictingLink('replace', { arrivalView: { lat: 52.50539, lon: -1.95889, zoom: 19 } });
        const result = await link.open([link.tower.cid, park.cid], { frame: false, openDetails: false });
        const incoming = [`design-${link.tower.cid}`, `design-${park.cid}`];
        expect(result.applied).toEqual(incoming);
        expect(link.map.fitBounds).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ids: incoming }),
            { padding: [80, 80], maxZoom: 18, animate: false });
        expect(link.map.setView).not.toHaveBeenCalled();
        expect(link.focusProposalDetails).not.toHaveBeenCalled();
    });

    it('focuses every replaced member in an already open 3D scene', async () => {
        const link = conflictingLink('replace', { arrivalView: { lat: 52.50539, lon: -1.95889, zoom: 19 } });
        link.window.isThreeModeActive = () => true;
        link.window.focusThreeModeOnProposals = vi.fn();
        await link.open([link.tower.cid, park.cid], { frame: false });
        expect(link.window.focusThreeModeOnProposals).toHaveBeenCalledExactlyOnceWith([`design-${link.tower.cid}`, `design-${park.cid}`]);
        expect(link.map.fitBounds).not.toHaveBeenCalled();
        expect(link.map.setView).not.toHaveBeenCalled();
    });

    it('drops the stale saved 3D camera after confirmed replacement', async () => {
        const link = conflictingLink('replace', { wants3D: true, arrivalView: { lat: 52.50539, lon: -1.95889, zoom: 19 } });
        link.window.proposedBuildings = [{ properties: { proposalId: `design-${link.tower.cid}` } }];
        await link.open([link.tower.cid, park.cid], { frame: false });
        expect(link.enterUrlDrivenView).toHaveBeenCalledExactlyOnceWith([`design-${link.tower.cid}`, `design-${park.cid}`], { restoreView: null });
    });

    it('lets explicit replacement framing suppress a saved camera at 3D entry', () => {
        const core = readFileSync(new URL('../../frontend/js/proposals/core.js', import.meta.url), 'utf8');
        const enter = core.slice(core.indexOf('function enterUrlDrivenView('), core.indexOf('function tryEnterThreeMode('));
        const camera = { targetLat: 52.50539, targetLng: -1.95889, range: 100 };
        const context = { window: { location: { search: '' }, MapShare: { arrivalOptions: () => ({ restoreView: camera, rotate: false }) } },
            isRealisticModeRequestedFromUrl: () => false, tryEnterThreeMode: vi.fn(() => true) };
        vm.runInNewContext(enter, context);
        context.enterUrlDrivenView(['incoming']);
        expect(context.tryEnterThreeMode).toHaveBeenLastCalledWith(expect.objectContaining({ restoreView: camera }));
        context.enterUrlDrivenView(['incoming'], { restoreView: null });
        expect(context.tryEnterThreeMode).toHaveBeenLastCalledWith(expect.objectContaining({ restoreView: null, focusProposalIds: ['incoming'], frameProposal: true }));
    });

    it.each(['cancel', 'skip'])('keeps the arrival view when replacement was not confirmed (%s)', async choice => {
        const link = conflictingLink(choice, { arrivalView: { lat: 52.50539, lon: -1.95889, zoom: 19 } });
        await link.open([link.tower.cid, park.cid], { frame: false });
        expect(link.map.fitBounds).not.toHaveBeenCalled();
        if (choice === 'skip') expect(link.map.setView).toHaveBeenCalledExactlyOnceWith([52.50539, -1.95889], 19, { animate: false });
        else expect(link.map.setView).not.toHaveBeenCalled();
    });

    it('does not frame a failed replacement or override a visitor who took over the view', async () => {
        const failed = conflictingLink('replace', { planFailure: 'Invalid layout', arrivalView: { lat: 52.5, lon: -1.9, zoom: 18 } });
        await failed.open([failed.tower.cid, park.cid], { frame: false });
        expect(failed.map.fitBounds).not.toHaveBeenCalled();
        const moved = conflictingLink('replace', { replayDone: false, tookOver: true, arrivalView: { lat: 52.5, lon: -1.9, zoom: 18 } });
        await moved.open([moved.tower.cid, park.cid], { frame: false });
        expect(moved.map.fitBounds).not.toHaveBeenCalled();
        expect(moved.map.setView).not.toHaveBeenCalled();
    });

    it('keeps the camera unchanged when a remote shared-plan revision replaces the current plan', async () => {
        const link = conflictingLink('replace', { arrivalView: { lat: 52.50539, lon: -1.95889, zoom: 19 } });

        await link.open([link.tower.cid, park.cid], { sharedPlanSessionRemote: true, replaceAppliedIds: ['old-tower'], frame: false });

        expect(link.ProposalManager.applyProposalPlan).toHaveBeenCalledOnce();
        expect(link.map.fitBounds).not.toHaveBeenCalled();
        expect(link.map.setView).not.toHaveBeenCalled();
    });

    it('applies remote additions and removals atomically without treating retained members as rivals', async () => {
        const retained = { proposalId: 'retained', title: 'Retained', goal: 'park', applied: true };
        const link = designLink({ designs: [park], local: { retained }, held: { [`design-${park.cid}`]: ['retained'] } });
        const added = await link.open([park.cid], { sharedPlanSessionRemote: true, retainedProposalIds: ['retained'] });
        expect(added.blocked).toBe(false);
        expect(link.ProposalManager.applyProposalPlan).toHaveBeenCalledWith([`design-${park.cid}`], expect.objectContaining({ sharedPlanSessionRemote: true, retainedProposalIds: ['retained'] }));
        expect(link.records.get('retained').applied).toBe(true);
        link.ProposalManager.applyProposalPlan.mockClear();
        await link.open([], { sharedPlanSessionRemote: true, retainedProposalIds: ['retained'], replaceAppliedIds: ['removed'] });
        expect(link.ProposalManager.applyProposalPlan).toHaveBeenCalledWith([], expect.objectContaining({ releaseProposalIds: ['removed'], retainedProposalIds: ['retained'] }));
    });
    it('refuses a remote revision that would replace unrelated local work', async () => {
        const link = conflictingLink('replace');
        const result = await link.open([link.tower.cid, park.cid], { sharedPlanSessionRemote: true, replaceAppliedIds: ['another-member'] });
        expect(result.blocked).toBe(true);
        expect(link.window.CbDialog.choice).not.toHaveBeenCalled();
        expect(link.ProposalManager.applyProposalPlan).not.toHaveBeenCalled();
        expect(link.ProposalManager.applyProposal).not.toHaveBeenCalled();
        expect(link.records.get('old-tower').applied).toBe(true);
    });

    it('skips conflicting incoming designs by choice, keeping existing work and applying clear members', async () => {
        const link = conflictingLink('skip');
        const result = await link.open([link.tower.cid, park.cid]);
        expect(result).toMatchObject({ applied: [`design-${park.cid}`], omitted: [`design-${link.tower.cid}`], failed: [] });
        expect(link.records.get('old-tower').applied).toBe(true);
        expect(link.records.get(`design-${link.tower.cid}`).applied).toBe(false);
        expect(link.ProposalManager.applyProposalPlan).not.toHaveBeenCalled();
        expect(link.showSimpleShareModal).not.toHaveBeenCalled();
        expect(link.showEphemeralMessage.mock.calls[0][0]).toContain('skipping 1 conflicting');
    });

    it('warns about a stale road version even when the linked road was applied by a previous partial open', async () => {
        const road = row('Spine', { goal:'road-track' });
        const linked = { proposalId:'linked-spine', title:'Spine', goal:'road-track', applied:true };
        const old = { proposalId:'old-spine', title:'Original spine', goal:'road-track', applied:true };
        const link = designLink({ designs:[road,block], local:{[road.cid]:linked,old}, held:{[linked.proposalId]:[old.proposalId]}, conflictChoice:'replace' });
        const result=await link.open([road.cid,block.cid]);
        expect(link.window.CbDialog.choice.mock.calls[0][0]).toContain('Original spine');
        expect(link.ProposalManager.applyProposalPlan).toHaveBeenCalledExactlyOnceWith(
            [linked.proposalId,`design-${block.cid}`],{silent:true,onProgress:expect.any(Function)});
        expect(result.failed).toEqual([]);expect(link.records.get(old.proposalId).applied).toBe(false);
    });

    it.each(['cancel', null])('cancel/close leaves the previous map applied (%s)', async conflictChoice => {
        const link = conflictingLink(conflictChoice);
        const result = await link.open([link.tower.cid, park.cid]);
        expect(result.blocked).toBe(true);expect(result.applied).toEqual([]);
        expect(link.records.get('old-tower').applied).toBe(true);
        expect(link.ProposalManager.applyProposal).not.toHaveBeenCalled();
        expect(link.ProposalManager.applyProposalPlan).not.toHaveBeenCalled();
    });

    it('reports an atomic replacement failure without claiming any new member applied', async () => {
        const link = conflictingLink('replace', { planFailure: 'The proposed plots do not cover the site.' });
        const result = await link.open([link.tower.cid, park.cid]);
        expect(result.applied).toEqual([]);expect(result.failed[0].reason).toContain('cover the site');
        expect(link.records.get('old-tower').applied).toBe(true);
        expect(link.records.get(`design-${link.tower.cid}`).applied).toBe(false);
    });

    it('names each failed design from the carried content even when the local record is missing', async () => {
        const link = conflictingLink('replace');
        const towerId = `design-${link.tower.cid}`, parkId = `design-${park.cid}`;
        link.ProposalManager.applyProposalPlan.mockImplementation(async () => {
            link.records.delete(towerId);
            link.ProposalManager._lastFailedPlanApplySummary = { failed: [
                { proposalId: towerId, reason: 'This proposal is no longer available.' },
                { proposalId: parkId, reason: 'This proposal was withdrawn.' }
            ] };
            return false;
        });
        const result = await link.open([link.tower.cid, park.cid]);
        expect(result.failed.map(failure => [failure.id, failure.label])).toEqual([[towerId, 'Tower'], [parkId, 'Park']]);
        const body = link.showSimpleShareModal.mock.calls[0][0].body;
        expect(body).toContain('2 of the shared designs');
        expect(body).toContain('Tower · This proposal is no longer available.');
        expect(body).toContain('Park · This proposal was withdrawn.');
        expect(result.applied).toEqual([]);
    });

    it('imports the designs parked, applies what is not on the map in package order and frames the latest-authored', async () => {
        const link = designLink({ designs: [park, block, square], local: { [square.cid]: standingSquare } });

        const result = await link.open([park.cid, block.cid, square.cid]);

        expect(link.window.DesignSync.fetchDesigns).toHaveBeenCalledExactlyOnceWith([park.cid, block.cid, square.cid]);
        // The square stands on the map already: used as it is, never imported or applied again.
        expect(link.window.DesignSync.importDesign.mock.calls.map(([design, options]) => [design.title, options._parcelMutation.proposals]))
            .toEqual([['Park', link.proposalStorage], ['Block', link.proposalStorage]]);
        expect(link.ProposalManager.runParcelMutation).toHaveBeenCalledExactlyOnceWith(
            'import-shared-designs', null, expect.any(Function), { _mapMutation: false });
        // One write for all the imports, then one ground prefetch for what will be applied; buildings go
        // before public spaces through the one-boundary replay materializer, which writes once at its end.
        expect(link.CadastralParcelRepository.ensureIds).toHaveBeenCalledExactlyOnceWith(['HR-1', 'HR-2', 'HR-3'], expect.any(Object));
        expect(link.order).toEqual(['replay', 'import:Park', 'import:Block', 'save', 'ground', 'apply:Block', 'apply:Park', 'save']);
        expect(link.ProposalManager.applyProposal.mock.calls.map(([, options]) => options))
            .toEqual([{ replay: true, silent: true, deferPresentation: true }, { replay: true, silent: true, deferPresentation: true }]);

        const parkId = `design-${park.cid}`;
        const blockId = `design-${block.cid}`;
        expect(result.applied).toEqual([parkId, blockId]);
        expect(result.skipped).toEqual(['local-square']);
        expect(result.failed).toEqual([]);
        expect(result.blocked).toBe(false);
        expect([...result.localIds]).toEqual([[park.cid, parkId], [block.cid, blockId], [square.cid, 'local-square']]);

        // The latest-authored standing design is framed and opened.
        expect(link.map.fitBounds).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: blockId }),
            { padding: [80, 80], maxZoom: 18, animate: false });
        expect(link.focusProposalDetails).toHaveBeenCalledExactlyOnceWith(blockId, { centerOnProposal: false, showDetails: true });
        expect(link.showEphemeralMessage).toHaveBeenCalledExactlyOnceWith('Applied 2 shared designs.', 5000, 'info');
        expect(link.showSimpleShareModal).not.toHaveBeenCalled();
        expect(link.updateProposalLayer).toHaveBeenCalledOnce();
        expect(link.hideProposalLoadOverlay).toHaveBeenCalled();
    });

    it('reports every design it could not open in one dialog and still applies the rest', async () => {
        const held = row('Held lot', { goal: 'single' });
        const broken = row('Broken <road>');
        const gone = cidOf('never published');
        const heldId = `design-${held.cid}`;
        const brokenId = `design-${broken.cid}`;
        const link = designLink({
            designs: [park, held, broken],
            refused: { [heldId]: 'Another applied design holds this ground.' },
            failing: { [brokenId]: 'The ground changed under it.' }
        });

        const result = await link.open(['p-12', gone, held.cid, broken.cid, park.cid]);

        // Not a CID: never asked for.
        expect(link.window.DesignSync.fetchDesigns).toHaveBeenCalledExactlyOnceWith([gone, held.cid, broken.cid, park.cid]);
        expect(result.failed).toEqual([
            { id: 'p-12', label: 'p-12', reason: 'This is not a design link.' },
            { id: gone, label: gone, reason: 'This design is not on the server.' },
            { id: heldId, label: 'Held lot', reason: 'Another applied design holds this ground.' },
            { id: brokenId, label: 'Broken <road>', reason: 'The ground changed under it.' }
        ]);
        // The refused design never reaches the materializer; the failing one is tried, the park applies.
        expect(link.order.filter(step => step.startsWith('apply:'))).toEqual(['apply:Broken <road>', 'apply:Park']);
        expect(result.applied).toEqual([`design-${park.cid}`]);

        expect(link.showSimpleShareModal).toHaveBeenCalledOnce();
        const dialog = link.showSimpleShareModal.mock.calls[0][0];
        expect(dialog.title).toBe('Shared designs');
        expect(dialog.body).toContain('4 of the shared designs could not be opened:');
        expect(dialog.body).toContain('<li>Held lot · Another applied design holds this ground.</li>');
        expect(dialog.body).toContain('<li>Broken &lt;road&gt; · The ground changed under it.</li>');
        expect(link.showEphemeralMessage).not.toHaveBeenCalled();
    });

    it('says the designs are already on the map when every one stands there', async () => {
        const standingPark = { proposalId: 'local-park', title: 'Park', goal: 'park', createdAt: '2026-10-02T10:00:00.000Z', applied: true };
        const link = designLink({ designs: [park, square], local: { [park.cid]: standingPark, [square.cid]: standingSquare } });

        const result = await link.open([park.cid, square.cid]);

        expect(result).toMatchObject({ applied: [], skipped: ['local-park', 'local-square'], failed: [] });
        expect(link.window.DesignSync.importDesign).not.toHaveBeenCalled();
        expect(link.ProposalManager.applyProposal).not.toHaveBeenCalled();
        expect(link.proposalStorage.save).not.toHaveBeenCalled();
        expect(link.showEphemeralMessage).toHaveBeenCalledExactlyOnceWith('These shared designs are already on the map.', 4000, 'info');
        expect(link.focusProposalDetails).toHaveBeenCalledExactlyOnceWith('local-park', { centerOnProposal: false, showDetails: true });
    });

    it('switches to the ground source required by geometry, independently of the city label', async () => {
        const split = { ...row('Riva', { city: 'wrong-label' }), groundContext: 'split' };
        const link = designLink({ designs: [park, split] });

        const result = await link.open([park.cid, split.cid]);

        expect(link.promptCityMismatchForProposal).toHaveBeenCalledExactlyOnceWith('split');
        expect(result.blocked).toBe(true);
        expect(link.window.DesignSync.importDesign).not.toHaveBeenCalled();
        expect(link.ProposalManager.reapplyAppliedProposals).not.toHaveBeenCalled();
        expect(link.hideProposalLoadOverlay).toHaveBeenCalled();
    });

    it('applies the designs and nothing else for the agreement route', async () => {
        const link = designLink({ designs: [park, block] });

        const result = await link.open([park.cid, block.cid], { openDetails: false, frame: false, summary: false, enter3D: false });

        expect(result.applied).toEqual([`design-${park.cid}`, `design-${block.cid}`]);
        expect([...result.localIds.keys()]).toEqual([park.cid, block.cid]);
        expect(link.map.fitBounds).not.toHaveBeenCalled();
        expect(link.focusProposalDetails).not.toHaveBeenCalled();
        expect(link.showEphemeralMessage).not.toHaveBeenCalled();
        expect(link.showSimpleShareModal).not.toHaveBeenCalled();
    });

    it('enters 3D framed on its own designs when the link asks for it, once', async () => {
        const link = designLink({ designs: [park, square], wants3D: true });

        await link.open([park.cid, square.cid]);
        expect(link.enterUrlDrivenView).toHaveBeenCalledExactlyOnceWith([`design-${park.cid}`, `design-${square.cid}`], {});
        expect(link.context.url3DModeHandled).toBe(true);

        await link.open([park.cid]);
        expect(link.enterUrlDrivenView).toHaveBeenCalledOnce();
    });

    it('waits for the boot replay, and leaves the view alone when the visitor took over meanwhile', async () => {
        const link = designLink({ designs: [park], replayDone: false, tookOver: true });

        const result = await link.open([park.cid]);

        expect(link.window.ReplayStatus.watchUserTakeover).toHaveBeenCalledExactlyOnceWith(link.document);
        expect(link.ProposalManager.reapplyAppliedProposals.mock.calls[0][0]).toEqual({ onProgress: expect.any(Function) });
        expect(link.takeover.stop).toHaveBeenCalledOnce();
        expect(link.order.indexOf('replay')).toBeLessThan(link.order.indexOf('import:Park'));
        // The design is applied; the map and the details stay where the visitor put them.
        expect(result.applied).toEqual([`design-${park.cid}`]);
        expect(link.map.fitBounds).not.toHaveBeenCalled();
        expect(link.focusProposalDetails).not.toHaveBeenCalled();
    });

    it('reports an index that cannot be read instead of throwing', async () => {
        const link = designLink({ fetchError: new Error('The server could not be reached.') });

        const result = await link.open([park.cid]);

        expect(result.failed).toEqual([{ id: null, label: '', reason: 'The server could not be reached.' }]);
        expect(link.showEphemeralMessage).toHaveBeenCalledExactlyOnceWith('The server could not be reached.', 8000, 'error');
        expect(link.hideProposalLoadOverlay).toHaveBeenCalled();
        expect(link.ProposalManager.applyProposal).not.toHaveBeenCalled();
    });
});
