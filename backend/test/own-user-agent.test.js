// The browser's own profile is the one user-controlled agent: a new own profile (a guest at boot, a
// named profile from the welcome dialog) must unflag the older one, since getCurrentUserAgent()
// returns the first flagged agent and a stale guest kept a named user blocked from sharing.
import { describe, expect, it } from 'vitest';
import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const userSource = readFileSync(new URL('../../frontend/js/user-management.js', import.meta.url), 'utf8');
const agentSource = readFileSync(new URL('../../frontend/js/agents.js', import.meta.url), 'utf8');

function declaration(source, name) {
    const ast = parse(source, { sourceType: 'script' });
    const node = ast.program.body.find(entry => entry.type === 'FunctionDeclaration' && entry.id?.name === name);
    if (!node) throw new Error(`Could not find ${name}`);
    return source.slice(node.start, node.end);
}

function browser(agents) {
    const store = new Map(agents.map(agent => [agent.id, { ...agent }]));
    const context = {
        window: { dispatchEvent() {} },
        CustomEvent: class { constructor(type) { this.type = type; } },
        agentStorage: {
            getAllAgents: () => [...store.values()],
            addAgent: agent => store.set(agent.id, { ...agent }),
            updateAgent: (id, patch) => store.set(id, { ...store.get(id), ...patch })
        },
        generateGuestAlias: () => 'Guest 2',
        pickAvailableAvatarIndex: () => 1,
        updateUsernameDisplay() {},
        currentUserAgent: null,
        currentUsername: null
    };
    vm.runInNewContext([
        declaration(agentSource, 'createUserAgent'),
        declaration(agentSource, 'setUserControlledAgent'),
        declaration(userSource, 'addOwnUserAgent'),
        declaration(userSource, 'ensureGuestUserAgent'),
        declaration(userSource, 'getCurrentUserAgent'),
        'globalThis.api = { createUserAgent, addOwnUserAgent, ensureGuestUserAgent, getCurrentUserAgent };'
    ].join('\n'), context);
    return { api: context.api, flagged: () => [...store.values()].filter(agent => agent.userControlled).map(agent => agent.name) };
}

describe('the own user agent', () => {
    it('a named profile made beside an old guest becomes the only own profile', () => {
        const { api, flagged } = browser([{ id: 'old', name: 'Guest 1', userControlled: true, isGuest: true }]);
        api.addOwnUserAgent(api.createUserAgent('Live tester', 0));
        expect(flagged()).toEqual(['Live tester']);
        expect(api.getCurrentUserAgent()).toMatchObject({ name: 'Live tester', isGuest: false });
    });

    it('a guest made at boot unflags whatever profile was left flagged', () => {
        const { api, flagged } = browser([{ id: 'named', name: 'Earlier user', userControlled: true, isGuest: false }]);
        api.ensureGuestUserAgent();
        expect(flagged()).toEqual(['Guest 2']);
        expect(api.getCurrentUserAgent().name).toBe('Guest 2');
    });
});
