// Unapply changes the proposal record while the details panel may replace its action button.
// The completion path must resolve the CURRENT button and render from authoritative state; putting
// the captured pre-await HTML back made a successfully parked proposal still say "Unapply".

import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ProposalMapAction = require('../../frontend/js/proposals/map-action.js');
const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/layer-render.js', import.meta.url)), 'utf8');
const executionSource = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/execution.js', import.meta.url)), 'utf8');
const dictionary = locale => JSON.parse(readFileSync(
    fileURLToPath(new URL(`../../frontend/i18n/${locale}.json`, import.meta.url)),
    'utf8'
));

function loadReconciler(document, proposal) {
    const start = source.indexOf('function reconcileProposalMapActionButton(');
    const end = source.indexOf('\nfunction proposalUnapplyPhaseLabel(', start);
    expect(start, 'reconcileProposalMapActionButton not found').toBeGreaterThanOrEqual(0);
    expect(end, 'end of reconcileProposalMapActionButton not found').toBeGreaterThan(start);
    const body = source.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function(
        'document', 'getProposalByIdOrHash', 'proposalStorage', 'isProposalApplied', 'isApplied', 'getProposalI18nHelper', 'ProposalMapAction',
        `${body}; return reconcileProposalMapActionButton;`
    )(
        document,
        () => proposal,
        null,
        value => value.applied === true,
        value => value.applied === true,
        () => (key, fallback) => ({
            'panel.proposal.actions.apply': 'Apply to map',
            'panel.proposal.actions.remove': 'Unapply'
        }[key] || fallback),
        ProposalMapAction
    );
}

function button() {
    const attributes = new Map();
    return {
        attributes,
        className: '',
        innerHTML: '',
        disabled: true,
        style: { opacity: '0.6', cursor: 'wait' },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        removeAttribute(name) { attributes.delete(name); }
    };
}

describe('proposal action after unapply', () => {
    it('turns the current button into Apply from the parked record state', () => {
        const current = button();
        const document = { getElementById: () => current };
        const proposal = { proposalId: 'park', applied: true };
        const reconcile = loadReconciler(document, proposal);

        reconcile('park');
        // Unapply is the destructive role of the vocabulary (docs/design-language.md).
        expect(current.className).toBe('btn btn-danger');
        expect(current.innerHTML).toContain('fa-box-archive');
        expect(current.attributes.get('onclick')).toBe("removeProposalFromMap('park')");

        proposal.applied = false;
        reconcile('park');

        expect(current.disabled).toBe(false);
        expect(current.className).toContain('btn-success');
        expect(current.innerHTML).toContain('fa-check');
        expect(current.innerHTML).toContain('Apply to map');
        expect(current.attributes.get('onclick')).toBe("applyProposalToMap('park')");
        expect(current.attributes.get('data-default-action')).toBe('true');
        expect(current.attributes.get('aria-keyshortcuts')).toBe('Enter');
    });

    it('uses the same applied presentation before and after reconciliation', () => {
        const initial = ProposalMapAction.presentation(true, (_key, fallback) => fallback);
        const current = button();
        const document = { getElementById: () => current };
        const reconcile = loadReconciler(document, { proposalId: 'park', applied: true });

        reconcile('park');

        expect(current.className).toBe(initial.className);
        expect(current.innerHTML).toContain(initial.iconClass);
        expect(current.innerHTML).toContain(initial.label);
    });

    it('re-resolves the button after the awaited manager operation', () => {
        const remove = source.slice(
            source.indexOf('async function removeProposalFromMap('),
            source.indexOf('\nfunction focusOnRemovedParcelLocation(', source.indexOf('async function removeProposalFromMap('))
        );
        const finallyBody = remove.slice(remove.indexOf('} finally {'));
        expect(finallyBody).toContain('reconcileProposalMapActionButton(proposalId');
        expect(finallyBody).not.toContain('button.innerHTML = original');
    });

    it.each(['en', 'hr', 'sr', 'es'])('%s names every visible unapply phase', locale => {
        const actions = dictionary(locale).panel.proposal.actions;
        ['unapplying', 'restoringGround', 'saving', 'unappliedStatus']
            .forEach(key => expect(actions[key], `${locale} missing ${key}`).toBeTruthy());
        expect(actions.unappliedStatus).toContain('{{name}}');
    });
});

describe('unapply failure feedback', () => {
    function loadRemove({ result = false, throws = null, existingError = '', effects = null, records = null, dependents = [], answer = 'leave' } = {}) {
        const buttonNode = button();
        const panelError = existingError ? { dataset: { proposalMapActionError: 'park' }, remove: vi.fn() } : null;
        const document = {
            getElementById: () => buttonNode,
            querySelectorAll: () => panelError ? [panelError] : []
        };
        const messages = vi.fn();
        const proposal = { proposalId: 'park', title: 'Park', applied: true };
        const byId = new Map((records || [proposal]).map(record => [record.proposalId, record]));
        const settle = async options => {
            if (throws) throw throws;
            if (result !== false && effects) options.onMutationEffects?.(effects);
            return result;
        };
        const manager = {
            applyProposal() {},
            unapplyProposal: vi.fn(async (_id, options) => settle(options)),
            unapplyProposals: vi.fn(async (_ids, options) => settle(options)),
            applyProposalPlan: vi.fn(async () => ({ ok: true })),
            findUnapplyDependents: vi.fn(() => dependents),
            _refreshUIAfterProposalChange: vi.fn(),
            _getProposalChildParcels: () => []
        };
        const globals = {
            document,
            window: { __proposalMapActionFailures: existingError ? { park: existingError } : Object.create(null),
                CbDialog: { choice: vi.fn(async () => answer) } },
            console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
            ProposalManager: manager,
            proposalStorage: { getProposal: id => (records ? byId.get(String(id)) || null : proposal) },
            getLifecycleStatus: () => 'Active',
            isApplied: value => value.applied === true,
            isProposalApplied: value => value.applied === true,
            reconcileProposalMapActionButton: vi.fn(() => { buttonNode.disabled = false; }),
            getProposalI18nHelper: () => (key, fallback, params = {}) => String(fallback)
                .replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => params[name] ?? match),
            showEphemeralMessage: messages
        };
        const helpersStart = executionSource.indexOf('function proposalApplyFailureReason(');
        const helpersEnd = executionSource.indexOf('function computeOwnershipStatsFromSelection(', helpersStart);
        // removeProposalFromMap first asks about the designs standing on this one; its helper sits
        // directly above it in the same file.
        const removeStart = source.indexOf('async function chooseUnapplyDependents(');
        const removeEnd = source.indexOf('\nfunction focusOnRemovedParcelLocation(', removeStart);
        expect(removeStart, 'chooseUnapplyDependents not found').toBeGreaterThanOrEqual(0);
        expect(source.indexOf('async function removeProposalFromMap(', removeStart), 'removeProposalFromMap not after its helper').toBeGreaterThan(removeStart);
        runInNewContext(`${executionSource.slice(helpersStart, helpersEnd)}\n${source.slice(removeStart, removeEnd)}\nthis.remove = removeProposalFromMap; this.unapplyMany = unapplyDesignsFromMap;`, globals);
        return { remove: globals.remove, unapplyMany: globals.unapplyMany, globals, manager, messages, panelError, button: buttonNode };
    }

    it('reports a false manager result with an explicit unapply fallback', async () => {
        const { remove, globals, messages, button: buttonNode } = loadRemove();

        await expect(remove('park')).resolves.toBe(false);

        expect(messages).toHaveBeenCalledWith('Could not remove this proposal from the map. Please try again.', 8000, 'error');
        expect(globals.window.__proposalMapActionFailures.park).toContain('Could not remove this proposal');
        expect(buttonNode.disabled).toBe(false);
    });

    it('reports an unapply exception and clears its stale apply error after a successful retry', async () => {
        const failure = loadRemove({ throws: new Error('ground restore failed') });
        await expect(failure.remove('park')).resolves.toBe(false);
        expect(failure.messages).toHaveBeenCalledWith('Could not remove this proposal from the map: ground restore failed', 8000, 'error');

        const success = loadRemove({ result: true, existingError: 'old apply error' });
        await expect(success.remove('park')).resolves.toBe(true);
        expect(success.globals.window.__proposalMapActionFailures).not.toHaveProperty('park');
        // The outcome is a notice with the way back.
        expect(success.messages).toHaveBeenCalledOnce();
        const [text, duration, type, action] = success.messages.mock.calls[0];
        expect(text).toBe('The design “Park” was unapplied and remains in Lists.');
        expect([duration, type, action.label]).toEqual([10000, 'info', 'Undo']);
    });

    describe('what an unapply took off the map', () => {
    const tower = { proposalId: 'tower', title: 'Tower', applied: true };
    const park = { proposalId: 'park', title: 'Park', applied: true };
    const school = { proposalId: 'school', title: 'School', applied: true };
    const flush = () => new Promise(resolve => setImmediate(resolve));

    it('names a design the change took off beside the one asked for, and Undo applies them all again', async () => {
        const { remove, manager, messages } = loadRemove({ result: true,
            effects: { unapplied: [{ proposalId: 'park', title: 'Park' }, { proposalId: 'tower', title: 'Tower' }], applied: [] } });
        await expect(remove('park')).resolves.toBe(true);
        expect(manager.unapplyProposal.mock.calls[0][1].onMutationEffects).toEqual(expect.any(Function));
        const [text, , type, action] = messages.mock.calls[0];
        expect(text).toBe('The design “Park” was unapplied and remains in Lists. Also taken off the map: “Tower”.');
        expect(type).toBe('warning');
        action.run();
        await flush();
        expect(manager.applyProposalPlan).toHaveBeenCalledWith(['park', 'tower']);
        expect(manager._refreshUIAfterProposalChange).toHaveBeenCalledWith(null);
        expect(messages).toHaveBeenLastCalledWith('2 designs are applied again.', 5000, 'success');
    });

    it('says why when Undo cannot apply the designs again', async () => {
        const { remove, manager, messages } = loadRemove({ result: true });
        manager.applyProposalPlan.mockResolvedValue(false);
        manager._lastFailedPlanApplySummary = { failed: [{ reason: 'ground is taken' }] };
        await remove('park');
        messages.mock.calls[0][3].run();
        await flush();
        expect(messages).toHaveBeenLastCalledWith('The designs could not be applied again: ground is taken', 8000, 'error');
    });

    it('takes several designs off in one change and reports how many', async () => {
        const { unapplyMany, manager, messages } = loadRemove({ result: true, records: [park, tower, { ...school, applied: false }],
            effects: { unapplied: [{ proposalId: 'park', title: 'Park' }, { proposalId: 'tower', title: 'Tower' }], applied: [] } });
        const cameOff = await unapplyMany(['park', 'tower', 'school', 'park', 'missing']);
        // Only what stands on the map is asked for, once each, in one manager call.
        expect(manager.unapplyProposals).toHaveBeenCalledOnce();
        expect(manager.unapplyProposals.mock.calls[0][0]).toEqual(['park', 'tower']);
        expect(manager.unapplyProposals.mock.calls[0][1].alsoUnapplyIds).toEqual([]);
        expect(cameOff.map(row => row.proposalId)).toEqual(['park', 'tower']);
        const [text, , type, action] = messages.mock.calls[0];
        expect(text).toBe('2 designs were unapplied and remain in Lists.');
        expect([type, action.label]).toEqual(['info', 'Undo']);
    });

    it('asks about the designs standing on a set, and unapplies them too or stops', async () => {
        const options = { result: true, records: [park, tower, school], dependents: [school] };
        const all = loadRemove({ ...options, answer: 'all',
            effects: { unapplied: [park, tower, school].map(({ proposalId, title }) => ({ proposalId, title })), applied: [] } });
        await all.unapplyMany(['park', 'tower']);
        expect(all.manager.findUnapplyDependents).toHaveBeenCalledWith(['park', 'tower']);
        expect(all.globals.window.CbDialog.choice.mock.calls[0][0]).toContain('These designs stand on the ones being unapplied: “School”.');
        expect(all.manager.unapplyProposals.mock.calls[0][1].alsoUnapplyIds).toEqual(['school']);
        // The chosen dependent was asked for too: nothing is reported as taken off beside the request.
        expect(all.messages.mock.calls[0][0]).toBe('3 designs were unapplied and remain in Lists.');

        const cancelled = loadRemove({ ...options, answer: 'cancel' });
        await expect(cancelled.unapplyMany(['park', 'tower'])).resolves.toBeNull();
        expect(cancelled.manager.unapplyProposals).not.toHaveBeenCalled();
        expect(cancelled.messages).not.toHaveBeenCalled();
    });

    it('reports a refused change and takes nothing as done', async () => {
        const { unapplyMany, messages } = loadRemove({ result: false, records: [park, tower] });
        await expect(unapplyMany(['park', 'tower'])).resolves.toBeNull();
        expect(messages).toHaveBeenCalledWith('The designs could not be unapplied.', 8000, 'error');
    });
    });
});
