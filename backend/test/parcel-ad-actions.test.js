// A nested label click must open one destination, even after the ad URL changes.
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

it('updates the Marketplace button without adding a second handler to its label', () => {
    const open = vi.fn();
    let context;
    const element = () => ({
        onclick: null,
        setAttribute(name, value) {
            if (name === 'onclick') this.onclick = vm.runInContext(`(function () { ${value} })`, context);
        }
    });
    const button = element();
    button.onclick = () => open('https://example.invalid/old', '_blank', 'noopener,noreferrer');
    const label = { ...element(), closest: selector => selector === 'button' ? button : null };
    const dialog = {
        // Visibility is the hidden attribute, not an inline style, since 18c80ee42.
        hidden: true,
        setAttribute: vi.fn(),
        querySelector: selector => selector === '[data-i18n-key="panel.parcel.marketplace"]' ? label : null
    };
    const document = { getElementById: id => id === 'parcel-ad-dialog' ? dialog : null };
    const window = { document, open };
    context = vm.createContext({ window, document });
    vm.runInContext(readFileSync(new URL('../../frontend/js/parcels/ui/parcel-panel.js', import.meta.url), 'utf8'), context);

    for (const link of ['https://example.invalid/first', "https://example.invalid/owner's-ad"]) {
        window.toggleAdActionsDialog(link);
        expect(dialog.hidden).toBe(false);
        // A click bubbles from the label to the enclosing button.
        label.onclick?.();
        button.onclick?.();
        expect(open).toHaveBeenCalledExactlyOnceWith(link, '_blank', 'noopener,noreferrer');
        expect(label.onclick).toBeNull();
        open.mockClear();
        window.toggleAdActionsDialog(link);
        expect(dialog.hidden).toBe(true);
        expect(open).not.toHaveBeenCalled();
    }
});
