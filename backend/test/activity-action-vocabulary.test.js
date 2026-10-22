// The activity explorer's action filter is built from ActorExplorer's action vocabulary. Every action
// type the live feed (routes/agent-activity.js) can emit must be in it, or that kind of activity can
// be seen but never filtered for (run status could not be, before). And every type in it must still be
// emitted by something, so a removed action does not linger as a filter option no event can match.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { ACTION_LABELS, actionOptions } = require('../../frontend/js/actor-explorer.js');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const activityRoute = read('../routes/agent-activity.js');
// The settlement phase of the agent runs (decide → lens → attest → execute, or expire, then resolve →
// claim) records its steps through the action engine, so they reach the live feed as run activities.
const settlement = read('../agents/lifecycle-actions.js');
// An action type may carry a hyphen (`lens-decision`).
const TYPE = "'([A-Za-z0-9_-]+)'";

// The final vocabulary (plan-design-agreement.md, M3): designs and agreements from the index, the
// agreement, market and pledge programs' instructions, the settlement phase, local designs a simulated
// agent creates, and run status.
const VOCABULARY = [
    'create', 'design', 'propose', 'mint', 'fund', 'decide', 'lens-decision', 'attest', 'execute', 'cancel', 'expire',
    'createMarket', 'stake', 'resolve', 'claim', 'donate', 'pledge', 'revokePledge', 'fulfillPledge', 'voidPledge',
    'refundMyDonations', 'releaseDonations', 'run_status'
];

function block(source, pattern, name) {
    const match = source.match(pattern);
    expect(match, `${name} block`).not.toBeNull();
    return match[1];
}

function liveActionTypes() {
    // The agreement program's instructions → their actions, and the market and pledge instructions
    // (['instruction', 'action'] pairs), as the route maps them; plus the types it writes literally.
    const agreement = [...block(activityRoute, /const AGREEMENT_ACTIONS = Object\.freeze\(\{([\s\S]*?)\}\);/, 'AGREEMENT_ACTIONS')
        .matchAll(new RegExp(`:\\s*${TYPE}`, 'g'))].map(match => match[1]);
    const subject = [...block(activityRoute, /const SUBJECT_ACTIONS = new Map\(\[([\s\S]*?)\]\);/, 'SUBJECT_ACTIONS')
        .matchAll(new RegExp(`\\[\\s*'[a-z_]+'\\s*,\\s*${TYPE}\\s*\\]`, 'g'))].map(match => match[1]);
    const literal = [...activityRoute.matchAll(new RegExp(`action:\\s*\\{\\s*type:\\s*${TYPE}`, 'g'))].map(match => match[1]);
    const settled = [...settlement.matchAll(new RegExp(`perform\\(\\{\\s*type:\\s*${TYPE}`, 'g'))].map(match => match[1]);
    return [...new Set([...agreement, ...subject, ...literal, ...settled])];
}

function engineDescribedTypes() {
    const engine = read('../../frontend/js/agent-action-engine.js');
    return [...new Set([...engine.matchAll(new RegExp(`action\\.type === ${TYPE}`, 'g'))].map(match => match[1]))];
}

// What a simulated agent can do in a turn (frontend/js/agents.js); 'nothing' records no activity.
function simulationActionTypes() {
    const agents = read('../../frontend/js/agents.js');
    const list = block(agents, /const actions = \[([^\]]*)\];/, 'simulation actions');
    return [...list.matchAll(new RegExp(TYPE, 'g'))].map(match => match[1]).filter(type => type !== 'nothing');
}

const missingFrom = types => types.filter(type => !Object.prototype.hasOwnProperty.call(ACTION_LABELS, type));

describe('activity action vocabulary', () => {
    it('is the final set of action types, in filter order', () => {
        expect(Object.keys(ACTION_LABELS)).toEqual(VOCABULARY);
    });

    it('covers every action type the live activity feed emits', () => {
        const types = liveActionTypes();
        expect(types).toEqual(expect.arrayContaining(['propose', 'design', 'mint', 'createMarket', 'voidPledge', 'run_status', 'decide', 'lens-decision']));
        expect(missingFrom(types)).toEqual([]);
    });

    it('covers every action type the engine can describe (agent run summaries)', () => {
        const described = engineDescribedTypes();
        expect(described).toEqual(expect.arrayContaining(['design', 'attest', 'voidPledge']));
        expect(missingFrom(described)).toEqual([]);
    });

    it('covers what the simulation agents do', () => {
        const types = simulationActionTypes();
        expect(types).toContain('create');
        expect(missingFrom(types)).toEqual([]);
    });

    it('keeps no type that nothing emits any more', () => {
        const emitted = new Set([...liveActionTypes(), ...engineDescribedTypes(), ...simulationActionTypes()]);
        expect(Object.keys(ACTION_LABELS).filter(type => !emitted.has(type))).toEqual([]);
    });

    it('offers one option per type, labelled through the host translator', () => {
        const options = actionOptions((key, fallback) => (key === 'gameDialogs.log.actions.lens-decision' ? 'Odluka leće' : fallback));
        expect(options.map(option => option.value)).toEqual(Object.keys(ACTION_LABELS));
        expect(options.find(option => option.value === 'lens-decision').label).toBe('Odluka leće');
        expect(options.find(option => option.value === 'decide').label).toBe('Owner decision');
        expect(actionOptions().find(option => option.value === 'run_status').label).toBe('Run status');
    });

    it('has a label in every locale for every action type', () => {
        for (const lang of ['en', 'hr', 'es', 'sr']) {
            const locale = JSON.parse(read(`../../frontend/i18n/${lang}.json`));
            const labels = locale.gameDialogs.log.actions || {};
            expect(Object.keys(ACTION_LABELS).filter(type => !labels[type]), lang).toEqual([]);
        }
    });

    it('keeps no locale label for a type the vocabulary dropped', () => {
        for (const lang of ['en', 'hr', 'es', 'sr']) {
            const locale = JSON.parse(read(`../../frontend/i18n/${lang}.json`));
            const labels = Object.keys(locale.gameDialogs.log.actions || {});
            expect(labels.filter(type => !Object.prototype.hasOwnProperty.call(ACTION_LABELS, type)), lang).toEqual([]);
        }
    });
});
