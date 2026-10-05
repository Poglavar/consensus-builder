// Exercises the actual username updater with untrusted display text to prevent markup injection.
import { describe, expect, it } from 'vitest';
import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const userSource = readFileSync(new URL('../../frontend/js/user-management.js', import.meta.url), 'utf8');
const utilitySource = readFileSync(new URL('../../frontend/js/shared-utils.js', import.meta.url), 'utf8');
const escapeSource = utilitySource.slice(
    utilitySource.indexOf('const HTML_ESCAPE_CHARS'),
    utilitySource.indexOf('// A value passed as a string argument')
);

function declaration(source, name) {
    const ast = parse(source, { sourceType: 'script' });
    const node = ast.program.body.find(entry => entry.type === 'FunctionDeclaration' && entry.id?.name === name);
    if (!node) throw new Error(`Could not find ${name}`);
    return source.slice(node.start, node.end);
}

describe('username display HTML', () => {
    it('renders an untrusted username as text inside the real display updater', () => {
        const display = {
            dataset: {},
            addEventListener() {},
            click() {},
            innerHTML: ''
        };
        const context = {
            document: { getElementById(id) { return id === 'username-display' ? display : null; } },
            window: { walletManager: null },
            currentUserAgent: { name: '<img src=x onerror=alert(1)>', avatarIndex: 2, isGuest: false, id: 'agent-1' },
            userNotifications: { getUnseenCount() { return 0; } },
            getAvatarImagePath(index) { return `/avatars/${index}.png`; },
            showWelcomeModal() {},
            showAgentDialog() {}
        };
        vm.runInNewContext(`${escapeSource}\n${declaration(userSource, 'updateUsernameDisplay')}\nupdateUsernameDisplay();`, context);

        expect(display.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(display.innerHTML).not.toContain('<span id="username-text"><img');
    });
});
