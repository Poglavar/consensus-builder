// Characterizes the real lens console wiring (frontend/js/lens-console.js) on a fake DOM: the
// operator attests the decision of an agreement by its CID (POST /lens/agreements/:cid/decision), the
// result says issued / reused / refused / invalid in data-outcome and data-code with the tally the
// member judged on, and only an attested decision redraws the issued counts and attestations.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const LensCore = require('../../frontend/js/lens-core.js');
const Cid = require('../../frontend/js/cid.js');
const source = readFileSync(new URL('../../frontend/js/lens-console.js', import.meta.url), 'utf8');
const KEY = LensCore.base58Encode(Uint8Array.from({ length: 32 }, () => 7));
const CID = Cid.cidOfObject({ schema: 'agreement/v1', title: 'Block seven' });
const OTHER_CID = Cid.cidOfObject({ schema: 'agreement/v1', title: 'Block eight' });
const TALLY = { ready: true, passed: true, reason: null, acceptedOwners: 4, totalOwners: 4, acceptedAreaM2: 175, totalAreaM2: 175 };

class Node {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.children = [];
        this.listeners = {};
        this.attributes = {};
        this.dataset = {};
        this.value = '';
        this.disabled = false;
        this.className = '';
        this.parentNode = null;
    }
    adopt(children) {
        children.forEach(child => { if (child && typeof child === 'object') child.parentNode = this; });
        return children;
    }
    append(...children) { this.children.push(...this.adopt(children)); }
    prepend(child) { this.children.unshift(...this.adopt([child])); }
    replaceChildren(...children) { this.children = this.adopt(children); }
    replaceWith(node) {
        const siblings = this.parentNode.children;
        siblings[siblings.indexOf(this)] = node;
        node.parentNode = this.parentNode;
    }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    get lastChild() { return this.children.at(-1); }
    get textContent() { return this.children.map(child => child?.textContent || '').join(' '); }
    set textContent(value) { this.children = [{ textContent: String(value) }]; }
}

// The console booted on a fake page. `answer` is what the member's decision endpoint returns.
function boot({ answer = { outcome: { kind: 'ok' }, body: decisionBody() } } = {}) {
    const ids = [
        'lc-language', 'lc-run-own', 'lc-service-url', 'lc-directory', 'lc-service-load', 'lc-attestations-load',
        'lc-wallet-connect', 'lc-wallet', 'lc-filter-kind', 'lc-filter-parcel', 'lc-status', 'lc-attestations',
        'lc-decision-form', 'lc-decision-cid', 'lc-decision-token', 'lc-decision-result'
    ];
    const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
    nodes['lc-decision-token'].value = 'operator-token';
    nodes['lc-decision-cid'].value = ` ${CID} `;
    let statusReads = 0;
    let attestationReads = 0;
    const posted = [];
    const client = {
        async fetchDirectory() { return { outcome: { kind: 'ok' }, members: [] }; },
        async fetchStatus() {
            statusReads += 1;
            return { outcome: { kind: 'ok' }, body: { key: KEY, kind: 'notary', counts: { decision: statusReads - 1 } } };
        },
        async fetchAttestations() {
            attestationReads += 1;
            return {
                outcome: { kind: 'ok' },
                attestations: attestationReads === 1 ? [] : [{ kind: 'decision', address: KEY, payload: { agreementCid: CID, decision: 'satisfied' } }]
            };
        },
        async postAgreementDecision(request) {
            posted.push(request);
            return answer;
        }
    };
    const document = {
        readyState: 'complete',
        createElement(tag) { return new Node(tag); },
        getElementById(id) { return nodes[id]; },
        addEventListener() {}
    };
    const window = {
        document,
        LensCore,
        Cid,
        LensServiceClient: client,
        location: { search: '' },
        localStorage: { getItem() { return null; }, setItem() {} },
        getBackendBase() { return 'https://api.example'; },
        addEventListener() {}
    };
    vm.runInNewContext(source, { window, URLSearchParams, console });
    const load = async () => {
        nodes['lc-service-url'].value = 'https://member.example';
        await nodes['lc-service-load'].listeners.click();
    };
    const submit = () => nodes['lc-decision-form'].listeners.submit({ preventDefault() {} });
    const result = nodes['lc-decision-result'];
    return { nodes, posted, load, submit, result, reads: () => ({ statusReads, attestationReads }) };
}

function decisionBody(extra = {}) {
    return { address: KEY, kind: 'decision', reused: false, counted: 4, tally: TALLY,
        payload: { agreementCid: CID, sponsor: KEY, decision: 'satisfied', evidenceRef: `sha256:${'a'.repeat(64)}`, sourceObservedAt: 1_790_000_000 }, ...extra };
}

describe('lens console: the decision of an agreement', () => {
    it('asks the member for the agreement\'s decision by its CID, shows it, and redraws counts and attestations', async () => {
        const page = boot();
        await page.load();
        await page.submit();

        expect(page.posted).toEqual([{ serviceUrl: 'https://member.example', token: 'operator-token', cid: CID }]);
        // The token is used once and never kept in the form.
        expect(page.nodes['lc-decision-token'].value).toBe('');
        expect(page.result.dataset).toEqual({ outcome: 'issued', code: '' });
        const text = page.result.textContent;
        expect(text).toContain('Decision attested.');
        expect(text).toContain('satisfied');
        expect(text).toContain('Decision rule met');
        expect(text).toContain('4 of 4 accepted');
        expect(text).toContain('Owner decisions counted 4');
        expect(text).toContain(KEY);
        expect(page.reads()).toEqual({ statusReads: 2, attestationReads: 2 });
        expect(page.nodes['lc-status'].textContent).toContain('decision: 1');
        expect(page.nodes['lc-attestations'].textContent).toContain(CID);
    });

    it('says when the member returned the decision it had already attested', async () => {
        const page = boot({ answer: { outcome: { kind: 'ok' }, body: decisionBody({ reused: true }) } });
        await page.load();
        await page.submit();
        expect(page.result.dataset).toEqual({ outcome: 'reused', code: '' });
        expect(page.result.textContent).toContain('Already attested; the stored decision was returned.');
    });

    it('names why the member would not attest, with the tally it judged on, and redraws nothing', async () => {
        const tally = { ready: true, passed: false, acceptedOwners: 3, totalOwners: 4, acceptedAreaM2: 120, totalAreaM2: 175 };
        const page = boot({ answer: { outcome: { kind: 'refused', status: 409, code: 'rule_not_met' }, body: { error: 'rule_not_met', tally } } });
        await page.load();
        await page.submit();
        expect(page.result.dataset).toEqual({ outcome: 'refused', code: 'rule_not_met' });
        const text = page.result.textContent;
        expect(text).toContain('The owner decisions relayed so far do not meet the agreement’s decision rule.');
        expect(text).toContain('Decision rule not met');
        expect(text).toContain('3 of 4 accepted');
        expect(page.reads()).toEqual({ statusReads: 1, attestationReads: 1 });
    });

    it('shows the member\'s own words for a refusal it has no sentence for', async () => {
        const page = boot({ answer: { outcome: { kind: 'error', status: 500, message: 'database down' }, body: null } });
        await page.load();
        await page.submit();
        expect(page.result.dataset).toEqual({ outcome: 'refused', code: 'http_500' });
        expect(page.result.textContent).toContain('The service answered 500: database down');
        expect(page.reads()).toEqual({ statusReads: 1, attestationReads: 1 });
    });

    it('does not show an answer about another agreement as this one\'s decision', async () => {
        const page = boot({ answer: { outcome: { kind: 'ok' }, body: decisionBody({ payload: { agreementCid: OTHER_CID, decision: 'satisfied' } }) } });
        await page.load();
        await page.submit();
        expect(page.result.dataset).toEqual({ outcome: 'refused', code: 'wrong_agreement' });
        expect(page.result.textContent).toContain('The member answered something other than the decision of this agreement.');
        expect(page.reads()).toEqual({ statusReads: 1, attestationReads: 1 });
    });

    it('asks nothing without a loaded service, an agreement CID and the operator token', async () => {
        const unloaded = boot();
        await unloaded.submit();
        expect(unloaded.result.dataset).toEqual({ outcome: 'invalid', code: 'service' });
        expect(unloaded.result.textContent).toContain('Load a service URL first.');

        const notACid = boot();
        await notACid.load();
        notACid.nodes['lc-decision-cid'].value = 'ag-1';
        await notACid.submit();
        expect(notACid.result.dataset).toEqual({ outcome: 'invalid', code: 'cid' });
        expect(notACid.result.textContent).toContain('Enter the CID of an agreement (bafkrei…).');

        const noToken = boot();
        await noToken.load();
        noToken.nodes['lc-decision-token'].value = '';
        await noToken.submit();
        expect(noToken.result.dataset).toEqual({ outcome: 'invalid', code: 'token' });

        for (const page of [unloaded, notACid, noToken]) expect(page.posted).toEqual([]);
    });
});
