import { describe, expect, it } from 'vitest';
import { scoreTurn } from '../chat/eval-score.js';

describe('chat eval scoring', () => {
    it('scores tool use, outcome, plan changes, and dotted argument assertions', () => {
        expect(scoreTurn({ tools: ['ugt_draft_space'], outcome: 'reply', planChanged: true, args: { ugt_draft_space: { 'input.treeCount': 12 } } }, { outcome: { type: 'reply' }, planChanged: true }, [{ tool: 'ugt_draft_space', args: { input: { treeCount: 12 } } }])).toMatchObject({ passed: true });
    });
    it('reports missing, forbidden, and mismatched expectations', () => {
        expect(scoreTurn({ tools: ['ugt_find_place'] }, {}, [])).toMatchObject({ passed: false, reason: 'missing-tool' });
        expect(scoreTurn({ forbidTools: ['ugt_publish_design'] }, {}, [{ tool: 'ugt_publish_design' }])).toMatchObject({ passed: false, reason: 'forbidden-tool-used' });
        expect(scoreTurn({ outcome: 'question' }, { outcome: { type: 'reply' } }, [])).toMatchObject({ passed: false, reason: 'outcome-mismatch' });
    });
});
