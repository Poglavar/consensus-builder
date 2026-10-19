import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const managerSource = readFileSync(new URL('../../frontend/js/proposal-manager.js', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('../../frontend/js/proposal-editor-shell.js', import.meta.url), 'utf8');
const storageSource = readFileSync(new URL('../../frontend/js/proposals/data.js', import.meta.url), 'utf8');

function section(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(start, `missing ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `missing ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('corridor authoring lifecycle', () => {
    it('commits topology, record creation, and fabric derivation under one rollback boundary', () => {
        const create = section(
            managerSource,
            'async createCorridorProposalAtomically(',
            '\n    async _createCorridorProposalTransactionBody('
        );
        const body = section(
            managerSource,
            'async _createCorridorProposalTransactionBody(',
            '\n    reapplyAppliedProposals('
        );
        expect(create).toContain('_runProposalMutationBoundary(');
        expect(create).toMatch(/result = await _runProposalMutationBoundary\([\s\S]*this\._createCorridorProposalTransactionBody/);
        expect(body).toContain('planCorridorAuthoring(');
        expect(body).toContain('authoring.writeDefinition(target, change.definition)');
        expect(body).toContain("addProposal(plan.proposal, { emitEvent: false })");
        expect(body).toContain('await this.rematerializeCorridorScope(');
        expect(body.indexOf('planCorridorAuthoring(')).toBeLessThan(body.indexOf('addProposal('));
        expect(body.indexOf('addProposal(')).toBeLessThan(body.indexOf('rematerializeCorridorScope('));
    });

    it('does not consume the drawing draft until the atomic commit succeeds', () => {
        const create = section(
            editorSource,
            'if (atomicCorridorAuthoring) {',
            '\n        } else {'
        );
        expect(create).toContain('createCorridorProposalAtomically');
        expect(create).toContain('if (!created?.ok || !created.proposalId)');
        expect(create.indexOf('createCorridorProposalAtomically'))
            .toBeLessThan(create.indexOf('store.consumeAfterPublish'));
    });

    it('publishes proposalCreated only after commit, never from a provisional insert', () => {
        const create = section(
            managerSource,
            'async createCorridorProposalAtomically(',
            '\n    async _createCorridorProposalTransactionBody('
        );
        const body = section(
            managerSource,
            'async _createCorridorProposalTransactionBody(',
            '\n    reapplyAppliedProposals('
        );
        expect(storageSource).toContain('options.emitEvent !== false');
        expect(body).toContain("addProposal(plan.proposal, { emitEvent: false })");
        expect(create.indexOf("new CustomEvent('proposalCreated'"))
            .toBeGreaterThan(create.indexOf('result = await _runProposalMutationBoundary'));
    });

    it('never mutates topology during ordinary plan application', () => {
        const batch = section(
            managerSource,
            'async materializeCorridorBatch(',
            '\n    async _rebuildPass('
        );
        expect(batch).not.toContain('CorridorNetworkNodes');
        expect(batch).not.toContain('network-noding');
        expect(batch).toContain('rematerializeCorridorScope');
    });
});
