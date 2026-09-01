// Unapply changes the proposal record while the details panel may replace its action button.
// The completion path must resolve the CURRENT button and render from authoritative state; putting
// the captured pre-await HTML back made a successfully parked proposal still say "Unapply".

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/layer-render.js', import.meta.url)), 'utf8');
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
        'document', 'getProposalByIdOrHash', 'proposalStorage', 'isProposalApplied', 'isApplied', 'getProposalI18nHelper',
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
        }[key] || fallback)
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
        expect(current.className).toBe('btn btn-warning');
        expect(current.attributes.get('onclick')).toBe("removeProposalFromMap('park')");

        proposal.applied = false;
        reconcile('park');

        expect(current.disabled).toBe(false);
        expect(current.className).toContain('btn-success');
        expect(current.innerHTML).toContain('Apply to map');
        expect(current.attributes.get('onclick')).toBe("applyProposalToMap('park')");
        expect(current.attributes.get('data-default-action')).toBe('true');
        expect(current.attributes.get('aria-keyshortcuts')).toBe('Enter');
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
        ['checkingGround', 'unapplying', 'restoringGround', 'saving', 'unappliedStatus']
            .forEach(key => expect(actions[key], `${locale} missing ${key}`).toBeTruthy());
        expect(actions.unappliedStatus).toContain('{{name}}');
    });
});
