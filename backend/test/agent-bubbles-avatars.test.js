// Agent avatars load when a bubble first needs one, not at boot, and a bubble joins the map only
// once its avatar is decoded (never as a blank disc), unless it was removed in the meantime.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/agent-bubbles.js', import.meta.url), 'utf8');

function element(tag) {
    const node = {
        tag, children: [], className: '', style: {}, src: '', listeners: {}, parent: null,
        classList: { add() {}, remove() {}, contains: () => false },
        appendChild(child) { child.parent = node; node.children.push(child); return child; },
        querySelector(selector) { return selector === 'img' ? node.children.find(child => child.tag === 'img') || null : null; },
        addEventListener(type, listener) { node.listeners[type] = listener; },
        remove() { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); node.parent = null; }
    };
    if (tag === 'img') {
        let settle;
        node.decoded = new Promise(resolve => { settle = resolve; });
        node.decode = () => node.decoded;
        node.finishDecode = () => settle();
    }
    return node;
}

function load() {
    const images = [];
    const created = [];
    const context = {
        console, setInterval() {}, clearInterval() {},
        Image: function Image() { images.push(this); },
        getAvatarImagePath: index => `avatars/avatar${index}.png`,
        document: { createElement: tag => { const node = element(tag); created.push(node); return node; }, addEventListener() {}, getElementById: () => null }
    };
    context.window = context;
    vm.runInNewContext(source, context);
    const manager = context.agentBubbleManager;
    manager.map = {};
    manager.initialized = true;
    manager.bubbleContainer = element('div');
    manager.updateBubblePosition = vi.fn();
    return { manager, images, created };
}

const bubble = (agentId = 'agent-1') => ({ agentId, agentName: 'Ana', avatarIndex: 3, objectType: 'proposal', objectId: 'p-1',
    objectPosition: { lat: 45.8, lng: 15.97 }, action: 'created park design' });

describe('agent bubble avatars', () => {
    it('fetches no avatar at boot', () => {
        const { images, created } = load();
        expect(images).toEqual([]);
        expect(created).toEqual([]);
    });

    it('shows a bubble once its avatar is decoded, and only then', async () => {
        const { manager } = load();
        manager.addBubble(bubble());
        const [data] = manager.bubbles.values();
        const avatar = data.element.querySelector('img');
        expect(avatar.src).toBe('avatars/avatar3.png');
        expect(manager.bubbleContainer.children).toEqual([]);
        avatar.finishDecode();
        await avatar.decoded; await Promise.resolve();
        expect(manager.bubbleContainer.children).toEqual([data.element]);
        expect(manager.updateBubblePosition).toHaveBeenCalledWith(data);
    });

    it('keeps a bubble removed before its avatar decoded off the map', async () => {
        const { manager } = load();
        manager.addBubble(bubble());
        const [data] = manager.bubbles.values();
        manager.removeBubblesByAgent('agent-1');
        const avatar = data.element.querySelector('img');
        avatar.finishDecode();
        await avatar.decoded; await Promise.resolve();
        expect(manager.bubbleContainer.children).toEqual([]);
        expect(manager.updateBubblePosition).not.toHaveBeenCalled();
    });
});
