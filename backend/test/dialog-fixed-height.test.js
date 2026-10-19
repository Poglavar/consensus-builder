// A dialog whose content changes while it is open keeps one box (frontend/js/ui/dialogs.js
// fixedHeight, the .cb-dialog--fixed modifier in frontend/css/primitives.css): its body scrolls
// instead of the dialog growing and moving as a list loads or a row is added.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { dialogClassName } = require('../../frontend/js/ui/dialogs.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const primitives = readFileSync(path.join(here, '../../frontend/css/primitives.css'), 'utf8');

describe('fixed-height dialogs', () => {
    it('wear the fixed modifier only when asked', () => {
        expect(dialogClassName({ fixedHeight: true, className: 'lens-modal' }, 'lg')).toBe('cb-dialog cb-dialog--lg cb-dialog--fixed lens-modal');
        expect(dialogClassName({ className: 'city-switch-dialog' }, 'md')).toBe('cb-dialog cb-dialog--md city-switch-dialog');
        expect(dialogClassName({ message: true }, 'sm')).toBe('cb-dialog cb-dialog--sm cb-dialog--message');
    });

    it('get a definite height from the primitive, capped by the screen', () => {
        const rules = primitives.match(/\.cb-dialog--fixed\s*\{[^}]*\}/g) || [];
        expect(rules.length).toBe(2); // the desktop box and the phone sheet
        rules.forEach(rule => expect(rule).toMatch(/\bheight:\s*min\(var\(--cb-dialog-height/));
    });
});
