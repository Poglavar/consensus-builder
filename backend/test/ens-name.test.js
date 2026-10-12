import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharedUtils = require('../../frontend/js/shared-utils.js');
globalThis.escapeHtml = sharedUtils.escapeHtml;
globalThis.inlineJsArg = sharedUtils.inlineJsArg;
require('../../frontend/js/ens/ens-name.js');

describe('proposalEnsName', () => {
    const proposalEnsName = globalThis.proposalEnsName;
    const compactEnsName = globalThis.compactEnsName;
    const ensNameLineHtml = globalThis.ensNameLineHtml;
    const ensAppUrl = globalThis.ensAppUrl;

    it('keeps legacy numeric proposal labels', () => {
        expect(proposalEnsName('51')).toBe('51.proposals.urbangametheory.eth');
    });

    it('uses a short chain-qualified label from the canonical mirror id', () => {
        const proposal = { chainMirrorProposalId: `chain_${'a'.repeat(64)}` };
        expect(proposalEnsName(proposal)).toBe(`chain-${'a'.repeat(48)}.proposals.urbangametheory.eth`);
        expect(`chain-${'a'.repeat(48)}`.length).toBeLessThan(63);
    });

    it('does not generate a name from a bare token id or malformed mirror id', () => {
        expect(proposalEnsName({ tokenId: '51', chainId: '84532' })).toBe('');
        expect(proposalEnsName({ proposalId: 'chain_not-a-hash' })).toBe('');
    });

    it('shortens display-only chain labels and long parcel names to at most 36 characters', () => {
        const chainName = proposalEnsName({ chainMirrorProposalId: `chain_${'a'.repeat(64)}` });
        expect(compactEnsName(chainName)).toBe(`chain-${'a'.repeat(8)}…proposals…eth`);
        expect(compactEnsName(chainName).length).toBeLessThanOrEqual(36);

        const parcelName = globalThis.parcelEnsName('long-geometry-parcel-identifier-123456789');
        const compactParcelName = compactEnsName(parcelName);
        expect(compactParcelName.length).toBeLessThanOrEqual(36);
        expect(compactParcelName.startsWith('long-geo')).toBe(true);
        expect(compactParcelName.endsWith('…parcels…eth')).toBe(true);
    });

    it('leaves short canonical and numeric names unchanged', () => {
        const numeric = proposalEnsName('51');
        const shortParcel = globalThis.parcelEnsName('HR-1');
        expect(compactEnsName(numeric)).toBe(numeric);
        expect(compactEnsName(shortParcel)).toBe(shortParcel);
        expect(compactEnsName('')).toBe('');
    });

    it('shows compact text while retaining the full canonical destination and copy value', () => {
        const full = proposalEnsName({ chainMirrorProposalId: `chain_${'b'.repeat(64)}` });
        const html = ensNameLineHtml(full);

        expect(html).toContain(`href="${ensAppUrl(full)}"`);
        expect(html).toContain(`title="View ENS name: ${full}"`);
        expect(html).toContain(`title="Copy ENS name: ${full}"`);
        expect(html).toContain(`aria-label="Copy ENS name: ${full}"`);
        expect(html).toContain(`>${compactEnsName(full)}</button>`);
        expect(html).toContain(`onclick="copyEnsName(&quot;${full}&quot;, this)"`);
        expect(html).not.toContain(`>${full}</button>`);
        expect(html).toContain('<button type="button" class="cb-link cb-link--quiet ens-name-value"');
    });

    it('escapes display text and attribute values defensively', () => {
        const malicious = 'x"<img src=x onerror=alert(1)>&.parcels.urbangametheory.eth';
        const html = ensNameLineHtml(malicious);
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
        expect(html).toContain('title="View ENS name: x&quot;&lt;img');
        expect(html).toContain('aria-label="Copy ENS name: x&quot;&lt;img');
        expect(html).toContain('onclick="copyEnsName(&quot;x\\&quot;&lt;img');
        expect(html).toContain(`href="${ensAppUrl(malicious)}"`);
    });
});
