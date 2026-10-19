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
    function loadRemove({ result = false, throws = null, existingError = '' } = {}) {
        const buttonNode = button();
        const panelError = existingError ? { dataset: { proposalMapActionError: 'park' }, remove: vi.fn() } : null;
        const document = {
            getElementById: () => buttonNode,
            querySelectorAll: () => panelError ? [panelError] : []
        };
        const messages = vi.fn();
        const proposal = { proposalId: 'park', title: 'Park', applied: true };
        const manager = {
            applyProposal() {},
            unapplyProposal: vi.fn(async () => { if (throws) throw throws; return result; }),
            _getProposalChildParcels: () => []
        };
        const globals = {
            document,
            window: { __proposalMapActionFailures: existingError ? { park: existingError } : Object.create(null) },
            console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
            ProposalManager: manager,
            proposalStorage: { getProposal: () => proposal },
            getLifecycleStatus: () => 'Active',
            isApplied: value => value.applied === true,
            reconcileProposalMapActionButton: vi.fn(() => { buttonNode.disabled = false; }),
            getProposalI18nHelper: () => (key, fallback, params = {}) => String(fallback)
                .replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => params[name] ?? match),
            showEphemeralMessage: messages
        };
        const helpersStart = executionSource.indexOf('function proposalApplyFailureReason(');
        const helpersEnd = executionSource.indexOf('function openAcceptOwnershipTransferDialog(', helpersStart);
        const removeStart = source.indexOf('async function removeProposalFromMap(');
        const removeEnd = source.indexOf('\nfunction focusOnRemovedParcelLocation(', removeStart);
        runInNewContext(`${executionSource.slice(helpersStart, helpersEnd)}\n${source.slice(removeStart, removeEnd)}\nthis.remove = removeProposalFromMap;`, globals);
        return { remove: globals.remove, globals, manager, messages, panelError, button: buttonNode };
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
        expect(success.messages).not.toHaveBeenCalled();
    });
});
