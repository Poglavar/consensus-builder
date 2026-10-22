// Browser ENS name helpers (frontend/js/ens/ens-name.js): a parcel's name, the same one the gateway
// derives (backend/ens/slug.js), and its compact copy-on-click display. Proposal names are gone:
// the gateway names published agreements and designs by CID (plan-design-agreement.md, M3).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { parcelToSlug as gatewaySlug } from '../ens/slug.js';

const require = createRequire(import.meta.url);
const sharedUtils = require('../../frontend/js/shared-utils.js');
globalThis.escapeHtml = sharedUtils.escapeHtml;
globalThis.inlineJsArg = sharedUtils.inlineJsArg;
require('../../frontend/js/ens/ens-name.js');

describe('ENS names in the browser', () => {
    const parcelEnsName = globalThis.parcelEnsName;
    const compactEnsName = globalThis.compactEnsName;
    const ensNameLineHtml = globalThis.ensNameLineHtml;
    const ensAppUrl = globalThis.ensAppUrl;
    const longParcelName = () => parcelEnsName('long-geometry-parcel-identifier-123456789');
    // A published agreement's name at the gateway: <cid>.proposals.urbangametheory.eth.
    const agreementName = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku.proposals.urbangametheory.eth';

    it('names a parcel exactly as the gateway does', () => {
        expect(parcelEnsName('HR-335258-4341/2')).toBe('hr-335258-4341-2.parcels.urbangametheory.eth');
        for (const id of ['US-NY-6201001005440048', '001-005-027A', ' HR--335258//4341 ']) {
            expect(parcelEnsName(id)).toBe(`${gatewaySlug(id)}.parcels.urbangametheory.eth`);
        }
        for (const id of ['', '  ', '//', null, undefined]) expect(parcelEnsName(id)).toBe('');
    });

    it('shortens long parcel names and published-record names to at most 36 characters', () => {
        const compactParcelName = compactEnsName(longParcelName());
        expect(compactParcelName.length).toBeLessThanOrEqual(36);
        expect(compactParcelName.startsWith('long-geo')).toBe(true);
        expect(compactParcelName.endsWith('…parcels…eth')).toBe(true);

        const compactAgreementName = compactEnsName(agreementName);
        expect(compactAgreementName.length).toBeLessThanOrEqual(36);
        expect(compactAgreementName.startsWith('bafkreihdwd')).toBe(true);
        expect(compactAgreementName.endsWith('…proposals…eth')).toBe(true);
    });

    it('leaves short names unchanged', () => {
        const shortParcel = parcelEnsName('HR-1');
        expect(compactEnsName(shortParcel)).toBe(shortParcel);
        expect(compactEnsName('')).toBe('');
        expect(compactEnsName(null)).toBe('');
    });

    it('shows compact text while retaining the full canonical destination and copy value', () => {
        const full = longParcelName();
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
