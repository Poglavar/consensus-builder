// The activity explorer's action filter is built from ActorExplorer's action vocabulary. Every action
// type the live feed (routes/agent-activity.js) can emit must be in it, or that kind of activity can
// be seen but never filtered for (x402 payments and run status could not be, before).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { ACTION_LABELS, actionOptions } = require('../../frontend/js/actor-explorer.js');
const activityRoute = readFileSync(new URL('../routes/agent-activity.js', import.meta.url), 'utf8');

function liveActionTypes() {
    const chainBlock = activityRoute.match(/const CHAIN_ACTIONS = Object\.freeze\(\{([\s\S]*?)\}\);/);
    expect(chainBlock, 'CHAIN_ACTIONS block').not.toBeNull();
    const chain = [...chainBlock[1].matchAll(/:\s*'([A-Za-z0-9_]+)'/g)].map(match => match[1]);
    const literal = [...activityRoute.matchAll(/action:\s*\{\s*type:\s*'([A-Za-z0-9_]+)'/g)].map(match => match[1]);
    return [...new Set([...chain, ...literal])];
}

describe('activity action vocabulary', () => {
    it('covers every action type the live activity feed emits', () => {
        const types = liveActionTypes();
        expect(types).toEqual(expect.arrayContaining(['create', 'accept', 'x402Payment', 'run_status', 'voidPledge']));
        const missing = types.filter(type => !Object.prototype.hasOwnProperty.call(ACTION_LABELS, type));
        expect(missing).toEqual([]);
    });

    it('covers every action type the engine can describe (agent run summaries)', () => {
        const engine = readFileSync(new URL('../../frontend/js/agent-action-engine.js', import.meta.url), 'utf8');
        const described = [...new Set([...engine.matchAll(/action\.type === '([A-Za-z0-9_]+)'/g)].map(match => match[1]))];
        expect(described).toEqual(expect.arrayContaining(['certifyParcel', 'verdict']));
        expect(described.filter(type => !Object.prototype.hasOwnProperty.call(ACTION_LABELS, type))).toEqual([]);
    });

    it('covers what the simulation agents do', () => {
        ['create', 'accept', 'donate', 'pledge'].forEach(type => expect(ACTION_LABELS).toHaveProperty(type));
    });

    it('offers one option per type, labelled through the host translator', () => {
        const options = actionOptions((key, fallback) => (key === 'gameDialogs.log.actions.x402Payment' ? 'Plaćeno (x402)' : fallback));
        expect(options.map(option => option.value)).toEqual(Object.keys(ACTION_LABELS));
        expect(options.find(option => option.value === 'x402Payment').label).toBe('Plaćeno (x402)');
        expect(options.find(option => option.value === 'accept').label).toBe('Accepted');
        expect(actionOptions().find(option => option.value === 'run_status').label).toBe('Run status');
    });

    it('has a label in every locale for every action type', () => {
        for (const lang of ['en', 'hr', 'es', 'sr']) {
            const locale = JSON.parse(readFileSync(new URL(`../../frontend/i18n/${lang}.json`, import.meta.url), 'utf8'));
            const labels = locale.gameDialogs.log.actions || {};
            expect(Object.keys(ACTION_LABELS).filter(type => !labels[type]), lang).toEqual([]);
        }
    });
});
