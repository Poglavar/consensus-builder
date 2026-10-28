// These renderers feed the 2D/3D click stack or the panels hosted inside it. Keep fixed
// presentation in CSS so themes and hosted sizing can act on semantic classes. The approval meter
// keeps its one data-driven width; any additional inline style needs an explicit review.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const generators = Object.entries({
    'click-stack shell': '../../frontend/js/click-stack/click-stack-panel.js',
    '3D click-stack shell': '../../frontend/js/three-click-stack.js',
    '3D map view': '../../frontend/js/three-mode.js',
    'design details': '../../frontend/js/proposals/details-panel.js',
    'parcel panel': '../../frontend/js/parcels/ui/parcel-panel.js',
    'parcel ownership': '../../frontend/js/parcels/ownership-ui.js',
    'parcel road view': '../../frontend/js/parcels/ui/road.js',
    'planning views': '../../frontend/js/planning/views.js',
    'design membership sections': '../../frontend/js/design-memberships.js',
    'design membership relations': '../../frontend/js/click-stack/click-stack-relations.js',
    'ENS name helper': '../../frontend/js/ens/ens-name.js',
    'agreement panel': '../../frontend/js/agreement-panel.js',
    'agreement consultation content': '../../frontend/js/community/consultation.js',
    'agreement voting content': '../../frontend/js/community/voting-ui.js',
    'agreement voting roster': '../../frontend/js/community/voting-roster.js',
    'agreement owner approval content': '../../frontend/js/proposals/approval-panel.js'
});

const dynamicStyleAllowlist = new Map([
    ['../../frontend/js/proposals/approval-panel.js', new Map([['width: ${percent}%', 1]])]
]);

function inlineStyleAttributes(source) {
    const findings = [];
    const attribute = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi;
    for (const match of source.matchAll(attribute)) {
        findings.push({ index: match.index, value: match[2] });
    }
    return findings;
}

describe('click-stack rendered content uses semantic styling', () => {
    it.each(generators)('%s has no unapproved inline style attributes', (name, relativePath) => {
        const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
        const findings = inlineStyleAttributes(source);
        const allowlist = dynamicStyleAllowlist.get(relativePath) || new Map();
        const details = findings.map(({ index, value }) => `offset ${index}: style="${value}"`).join('\n');
        for (const [value, expectedCount] of allowlist) {
            expect(findings.filter(finding => finding.value === value), `${name} dynamic style ${value}`).toHaveLength(expectedCount);
        }
        const unexpected = findings.filter(finding => !allowlist.has(finding.value));
        const unexpectedDetails = unexpected.map(({ index, value }) => `offset ${index}: style="${value}"`).join('\n');
        expect(unexpected, `${name} contains unapproved inline styles:\n${unexpectedDetails || details}`).toEqual([]);
    });
});
