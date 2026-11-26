import { describe, expect, it, vi } from 'vitest';
import approval from '../../frontend/js/approval-link.js';

const cid = `bafkrei${'a'.repeat(52)}`;

describe('apartment approval links', () => {
    it('builds reserve and list intents with a mandatory unit id and no amount', () => {
        expect(approval.parse(new URL(`/agreements/${cid}?act=reserve&unitId=a-101`, 'https://app.test'))).toMatchObject({ action: 'reserve', params: { unitId: 'a-101' } });
        expect(approval.build({ origin: 'https://app.test', action: 'list-apartment', target: cid, params: { unitId: 'a-101' } })).toContain('act=list-apartment&unitId=a-101');
        expect(() => approval.validate({ action: 'reserve', target: cid, params: {} })).toThrow(/unitId/);
        expect(() => approval.validate({ action: 'donate', target: cid, params: { unitId: 'a-101' } })).toThrow(/only valid for apartment/);
        expect(() => approval.validate({ action: 'reserve', target: cid, params: { unitId: '../wallet' } })).toThrow(/unitId/);
    });
    it('builds a lens member confirmation intent that focuses the panel\'s Confirm as lens member', () => {
        expect(approval.parse(new URL(`/agreements/${cid}?act=confirm-member`, 'https://app.test'))).toMatchObject({ action: 'confirm-member', target: cid });
        expect(() => approval.validate({ action: 'confirm-member', target: cid, params: { amount: '1' } })).toThrow(/amount/);
        const button = { disabled: false, setAttribute() {}, focus() { this.focused = true; }, closest() { return null; } };
        expect(approval.preselect({ querySelector: selector => (selector === '[data-agreement-action="confirm-member"]' ? button : null) }, { action: 'confirm-member', target: cid, params: {} })).toBe(true);
        expect(button.focused).toBe(true);
    });
    it('focuses the matching control only', () => {
        const button = { disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, focus() { this.focused = true; }, closest() { return null; } };
        const container = { listeners: {}, querySelector(selector) { return selector.includes('a-101') ? button : null; }, addEventListener(name, fn) { this.listeners[name] = fn; } };
        expect(approval.preselect(container, { action: 'reserve', target: cid, params: { unitId: 'a-101' } })).toBe(true);
        expect(button.focused).toBe(true); expect(button.attrs['data-approval-selected']).toBe('true');
    });

    it('waits for the chosen round and replaces a previous request when another unit is selected', () => {
        const container = new EventTarget();
        const buttons = new Map();
        container.querySelector = selector => buttons.get(selector);
        const intent = unitId => ({ action: 'reserve', target: cid, params: { unitId } });
        approval.preselect(container, intent('a-101'));
        approval.preselect(container, intent('a-102'));
        const button = () => ({ focus: vi.fn(), setAttribute: vi.fn() });
        const first = button(), second = button();
        buttons.set('[data-agreement-reserve-unit="a-101"]', first);
        buttons.set('[data-agreement-reserve-unit="a-102"]', second);
        const ready = target => container.dispatchEvent(new CustomEvent('agreement-boost-ready', { detail: { cid: target } }));
        ready('another-round');
        expect(second.focus).not.toHaveBeenCalled();
        ready(cid);
        ready(cid);
        expect(second.focus).toHaveBeenCalledTimes(1);
        expect(first.focus).not.toHaveBeenCalled();
    });
});
