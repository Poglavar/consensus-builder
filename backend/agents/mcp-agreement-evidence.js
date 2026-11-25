// ugt_agreement_evidence: who attested what for one agreement, as the public lens walkthrough
// (frontend/lens.html) shows it. Reads the same sources (index, relayed owner approvals, each lens
// member's statement service, the agreement account on Solana), runs the same checks and returns
// LensWalkthroughModel's checklist, so an agent and a person see the same answer.
import { createRequire } from 'node:module';
import { createRpcConnection } from '../solana/rpc.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const agreementClient = require('../../frontend/js/solana/agreement-client.js');
const agreementRecord = require('../../frontend/js/agreement-record.js');
const approval = require('../../frontend/js/proposals/approval.js');
const relay = require('../../frontend/js/proposals/approval-relay.js');
const evidence = require('../../frontend/js/lens-agreement-evidence.js');
const Model = require('../../frontend/js/lens-walkthrough-model.js');
agreementClient.configure({ web3 });

const DEFAULT_API_BASE = 'https://api.urbangametheory.xyz';
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const toJson = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));

export function createAgreementEvidenceTool({ env = process.env, fetchImpl = globalThis.fetch, createConnection = url => createRpcConnection(url, 'confirmed') } = {}) {
    const apiBase = String(env.UGT_API_BASE || env.AGENT_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
    let connection;
    const chain = () => (connection ??= createConnection(env.SOLANA_RPC_URL || DEFAULT_RPC_URL));
    async function json(url) {
        const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
        return response.json();
    }

    async function agreementEvidence({ agreementCid } = {}) {
        const record = await json(`${apiBase}/agreements/${encodeURIComponent(agreementCid)}`);
        if (record.cid !== agreementCid || record.content?.schema !== 'agreement/v1') throw new Error('the index answered another agreement');
        const programId = agreementClient.constants.AGREEMENT_PROGRAM_ID;
        const kind = Model.kindOf(record);
        const state = { record, programId, receipts: null, receiptsError: false, issued: [], services: {}, chain: null, chainError: false };
        const subject = { ...agreementRecord.approvalSubject(record.content), agreementCid };

        if (kind === 'owners') {
            try {
                const body = await json(`${apiBase}/agreements/${encodeURIComponent(agreementCid)}/decisions`);
                state.receipts = (body.decisions || []).map(receipt => ({ receipt, verified: relay.verifyLensReceipt(subject, receipt) }));
                const folded = relay.fold(subject, state.receipts.filter(row => row.verified).map(row => row.receipt), () => true);
                state.tally = approval.tally(subject, Object.keys(folded.ownerApprovals));
            } catch (error) {
                state.receiptsError = true;
                state.receiptsErrorMessage = error.message;
            }
        }

        if (kind !== 'poll' && record.content.sponsor && !Model.isRetiredProgram(record, programId)) {
            try {
                state.chain = await evidence.readChain({ record, connection: chain(), client: agreementClient, web3 });
            } catch (error) {
                state.chainError = true;
                state.chainErrorMessage = error.message;
            }
        }

        const directory = await json(`${apiBase}/lenses/members`).then(body => body.members || []).catch(() => null);
        const lensKeys = Model.build({ ...state }).lens.keys;
        for (const key of record.content.sponsor ? lensKeys : []) {
            const entry = directory?.find(member => member.key === key);
            if (!directory) { state.services[key] = 'error'; continue; }
            if (!entry?.serviceUrl) { state.services[key] = 'unlisted'; continue; }
            try {
                const url = `${String(entry.serviceUrl).replace(/\/+$/, '')}/lens/attestations?${new URLSearchParams({ agreementCid, kind: 'decision' })}`;
                const body = await json(url);
                state.services[key] = 'ok';
                state.issued.push(...(body.attestations || []).filter(row => row.authority === key && row.kind === 'decision'
                    && row.payload?.agreementCid === agreementCid && row.payload.sponsor === record.content.sponsor && row.payload.decision === 'satisfied'));
            } catch {
                state.services[key] = 'error';
            }
        }

        const statement = state.chain?.statement;
        if (statement?.fields && state.receipts) {
            const counted = Model.approvalsCountedBy(state.receipts.filter(row => row.verified).map(row => row.receipt), statement.fields.sourceObservedAt);
            state.approvalsRef = approval.decisionEvidenceRef(relay.countedApprovals(relay.fold(subject, counted, () => true)));
        }
        const model = Model.build(state);
        const names = new Map((directory || []).map(member => [member.key, member.name]));
        return toJson({
            agreementCid,
            title: record.content.title || record.title || null,
            kind: model.kind,
            retiredProgram: model.retired,
            checks: model.checks,
            lens: {
                threshold: model.lens.threshold,
                confirmed: model.lens.confirmed,
                members: model.lens.members.map(member => ({
                    key: member.key, name: names.get(member.key) || null, state: member.state,
                    recordedStatement: member.recorded ? { address: member.recorded.address, fields: member.recorded.fields, checkedOnSolana: true } : null,
                    reportedStatements: member.statements.map(row => ({ address: row.address, issuedAt: row.issuedAt, payload: row.payload, checkedOnSolana: false }))
                }))
            },
            approvals: model.approvals.map(row => ({
                owner: row.owner, signer: row.signer, decision: row.decision, decidedAt: row.decidedAt,
                signaturesVerified: row.verified, ownerPerLensMember: row.rightsBy, signingAuthorityPerLensMember: row.authorityBy
            })),
            execution: model.execution,
            statementError: model.statementError,
            sourceErrors: { approvals: state.receiptsErrorMessage || null, chain: state.chainErrorMessage || null },
            howChecked: 'Owner approvals: each wallet signature and each lens member signature verified. Recorded statements: read from Solana and checked against the agreement account (hash, signer in the lens, subject, decision, schema, credential). Reported statements come from a lens member\'s service and are not checked. This proves who signed what and when, not that a statement is true.',
            pageUrl: `${String(env.UGT_APP_ORIGIN || 'https://urbangametheory.xyz').replace(/\/+$/, '')}/lens.html?agreement=${agreementCid}${record.city ? `&city=${encodeURIComponent(record.city)}` : ''}`
        });
    }

    return { agreementEvidence };
}
