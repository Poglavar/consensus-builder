// A tab that cannot own the saved workspace stops before the app (frontend/js/workspace-screen.js):
// the page claims the workspace in its head and stops at the first script in <body>, never inside
// <head>, where Chrome would never paint the screen.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../frontend/js/workspace-screen.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');

function element(tagName) {
    const el = {
        tagName, children: [], classList: { add: vi.fn(), remove: vi.fn() },
        setAttribute: vi.fn(), addEventListener: vi.fn(),
        append(...nodes) {
            this.children.push(...nodes);
            // A script the screen adds to load i18n "loads" at once.
            nodes.forEach(node => { if (node.tagName === 'script') queueMicrotask(() => node.onload?.()); });
        },
        replaceChildren(...nodes) { this.children = nodes; }
    };
    return el;
}

function loadScreen({ owned, inBody }) {
    let settle;
    const ready = new Promise(resolve => { settle = resolve; });
    const document = { head: element('head'), body: inBody ? element('body') : null, createElement: element };
    const root = {
        document,
        stop: vi.fn(),
        BrowserWorkspace: { status: owned ? 'ready' : 'blocked', ready },
        location: { reload: vi.fn() }
    };
    vm.runInNewContext(source, { window: root, Object, Promise, queueMicrotask });
    return { root, document, answer: () => settle(owned) };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the workspace screen stops a refused tab before the app', () => {
    it('waits for <body> when the refusal comes while the head is loading', async () => {
        const { root, document, answer } = loadScreen({ owned: false, inBody: false });
        answer();
        await flush();
        expect(root.stop).not.toHaveBeenCalled();

        document.body = element('body');
        root.WorkspaceScreen.bodyReached();
        expect(root.stop).toHaveBeenCalledOnce();
        await flush();
        expect(document.body.children.map(node => node.id)).toEqual(['workspace-screen']);
        expect(document.head.children.filter(node => node.tagName === 'script').map(node => node.src))
            .toEqual(['js/i18n.js', 'js/i18n-loader.js']);
    });

    it('stops at once when the refusal comes after <body> began', async () => {
        const { root, answer } = loadScreen({ owned: false, inBody: true });
        answer();
        await flush();
        expect(root.stop).toHaveBeenCalledOnce();
        root.WorkspaceScreen.bodyReached();
        expect(root.stop).toHaveBeenCalledOnce();
    });

    it('lets the owning tab load', async () => {
        const { root, answer } = loadScreen({ owned: true, inBody: false });
        answer();
        await flush();
        root.WorkspaceScreen.bodyReached();
        expect(root.stop).not.toHaveBeenCalled();
    });
});

describe('index.html claims the workspace before the app', () => {
    const head = indexHtml.slice(0, indexHtml.indexOf('<body'));
    const body = indexHtml.slice(indexHtml.indexOf('<body'));

    it('loads the claim and the screen in the head, before any app script list', () => {
        const claim = head.indexOf("'js/browser-workspace.js', 'js/workspace-screen.js'");
        expect(claim).toBeGreaterThan(-1);
        expect(head.indexOf('writeVersionedLocalScripts([', head.indexOf('js/build-info.js') + 1)).toBeGreaterThan(claim);
        expect(body).not.toContain("'js/browser-workspace.js'");
    });

    it('stops at the first script in <body>', () => {
        const firstScript = body.match(/<script>([\s\S]*?)<\/script>/)[1].trim();
        expect(firstScript).toBe('window.WorkspaceScreen.bodyReached();');
    });
});
