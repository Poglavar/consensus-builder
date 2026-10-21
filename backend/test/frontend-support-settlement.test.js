// Proposal alert messages (frontend/js/proposals/core.js showProposalAlertMessage): a transaction link
// keeps its slot whether the alert is translated or falls back. (Pledge and donation settlement left
// design details in M2, plan-design-agreement.md: funding is an agreement's.)
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const coreSource = readFileSync(new URL('../../frontend/js/proposals/core.js', import.meta.url), 'utf8');
const alertStart = coreSource.indexOf('function showProposalAlertMessage(');
const alertEnd = coreSource.indexOf('\nfunction isParcelReplacedByChildren(', alertStart);

for (const translated of [true, false]) {
    it(`keeps the transaction-link slot when an alert uses ${translated ? 'a translation' : 'its fallback'}`, () => {
        const alerts = [];
        const parameters = { amount: '1.25', currency: 'USDC', txLink: 'https://example.test/transaction' };
        const options = { linkUrl: parameters.txLink, linkText: 'See transaction' };
        const context = vm.createContext({
            window: { showStyledAlert: (...args) => alerts.push(args) },
            getProposalI18nHelper: () => (_key, fallback, values) => {
                const template = translated ? 'Supported with {{amount}} {{currency}}. See {{txLink}}' : fallback;
                return template.replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
            },
        });
        vm.runInContext(coreSource.slice(alertStart, alertEnd), context);
        context.showProposalAlertMessage('proposal_boost_success', 'Supported with {{amount}} {{currency}}.', parameters, options);
        expect(alerts).toHaveLength(1);
        expect(alerts[0][0]).toContain('Supported with 1.25 USDC.');
        expect(alerts[0][0].match(/\{\{txLink\}\}/g)).toHaveLength(1);
        expect(alerts[0][1]).toEqual(options);
        expect(parameters.txLink).toBe(options.linkUrl);
    });
}

it('keeps alerts without a transaction link as ordinary translated text', () => {
    const alerts = [];
    const context = vm.createContext({
        window: { showStyledAlert: (...args) => alerts.push(args) },
        getProposalI18nHelper: () => (_key, fallback) => fallback,
    });
    vm.runInContext(coreSource.slice(alertStart, alertEnd), context);
    context.showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
    expect(alerts).toEqual([['Proposal not found.', {}]]);
});
