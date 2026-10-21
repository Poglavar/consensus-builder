// Verify persisted design goals are explicit canonical values at the editor and create-preview boundaries.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const ProposalDesignGoals = require('../../frontend/js/proposals/design-goals.js');
// The screenshot rule moved to the create dialog's preview helpers with the upload modal's removal (M2).
const previewSource = readFileSync(new URL('../../frontend/js/proposals/create-preview.js', import.meta.url), 'utf8');
const createSource = readFileSync(new URL('../../frontend/js/proposals/dialog-create.js', import.meta.url), 'utf8');

function loadPreviewSkipFunction() {
    const ast = parse(previewSource, { sourceType: 'script' });
    const declaration = ast.program.body.find(node => node.type === 'FunctionDeclaration'
        && node.id.name === 'shouldSkipProposalScreenshot');
    expect(declaration, 'shouldSkipProposalScreenshot declaration exists').toBeTruthy();
    const context = vm.createContext({
        ProposalDesignGoals,
        PROPOSAL_SCREENSHOT_SKIP_GOALS: new Set(['urban-rule', 'ownership-transfer'])
    });
    vm.runInContext(`${previewSource.slice(declaration.start, declaration.end)}\nthis.shouldSkip = shouldSkipProposalScreenshot;`, context);
    return context.shouldSkip;
}

describe('goal-driven UI reads the canonical goal field only', () => {
    it('projects only an exact registered record.goal', () => {
        expect(ProposalDesignGoals.keyOf({ proposalType: 'urban-rule', type: 'urban-rule' })).toBeNull();
        expect(ProposalDesignGoals.keyOf({ goal: 'urban-rule', proposalType: 'park', type: 'park' })).toBe('urban-rule');
        expect(ProposalDesignGoals.keyOf({ goal: 'Transit Station' })).toBeNull();
        expect(ProposalDesignGoals.keyOf({ goal: 'station' })).toBe('station');
    });

    it('skips screenshots only when the canonical goal is in the skip set', () => {
        const shouldSkip = loadPreviewSkipFunction();
        expect(shouldSkip({ type: 'urban-rule' })).toBe(false);
        expect(shouldSkip({ goal: 'urban-rule', type: 'park' })).toBe(true);
        expect(shouldSkip({ goal: 'park' })).toBe(false);
        expect(shouldSkip(null)).toBe(true);
    });

    it('uses the shared projection for similar-proposal goal labels', () => {
        const ast = parse(createSource, { sourceType: 'script' });
        const dialog = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'showProposalDialog');
        expect(dialog, 'showProposalDialog declaration exists').toBeTruthy();
        const source = createSource.slice(dialog.start, dialog.end);
        expect(source).toContain('ProposalDesignGoals.keyOf(p) || \'other\'');
        expect(source).not.toMatch(/p\.(?:proposalType|type)/);
    });
});
