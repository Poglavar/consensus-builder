// The judge walkthrough must require public proof while treating an honestly waiting market as live.

import { describe, expect, it } from 'vitest';
import { buildJudgeDemo } from '../agents/judge-demo.js';

describe('judge demo model', () => {
    it('is ready when the public audit passes and the prospective experiment is visible', () => {
        const demo = buildJudgeDemo({
            audit: { status: 'verified', summary: { pass: 9, warn: 0, fail: 0 } },
            manifest: {
                title: 'Hyperstition', thesis: 'A thesis', hackathon: { branch: 'colosseum-worlds-fair' },
                surfaces: { pitch: 'https://site/deck', demo: 'https://site/demo', actors: 'https://site/actors' },
                publicProof: { manifest: 'https://api/proof', agentCapabilities: 'https://api/agents', courtOracle: 'https://api/court' }
            },
            prospective: { state: 'awaiting_evidence', marketUrl: 'https://explorer/market' }
        });
        expect(demo).toMatchObject({ status: 'ready', marketState: 'awaiting_evidence', proofSummary: { pass: 9, warn: 0, fail: 0 } });
        expect(demo.steps).toContainEqual({ label: 'Prospective market · awaiting_evidence', url: 'https://explorer/market' });
    });

    it('narrates the agreement cases the manifest declares, then the lens member directory', () => {
        const demo = buildJudgeDemo({
            manifest: { publicProof: {
                manifest: 'https://api.example/hackathon/proof.json',
                canonicalCase: 'https://api.example/hackathon/cases/bafkreicanonical',
                executedCase: 'https://api.example/hackathon/cases/bafkreiexecuted',
                attestedCase: 'https://api.example/hackathon/cases/attested'
            } }
        });
        const labels = demo.steps.map(step => step.label);
        expect(labels.slice(2, 6)).toEqual([
            'Hackathon proof manifest', 'Cancelled agreement (market paid NO)',
            'Executed agreement (lens attested, market paid YES)', 'Lens member directory (who may attest)'
        ]);
        expect(demo.steps[3].url).toBe('https://api.example/hackathon/cases/bafkreicanonical');
        expect(demo.steps[4].url).toBe('https://api.example/hackathon/cases/bafkreiexecuted');
        // The proposal-era attested case is gone: an attestation is the lens's decision on an agreement now.
        expect(labels.some(label => /attested case/i.test(label))).toBe(false);
        expect(demo.steps.map(step => step.url)).not.toContain('https://api.example/hackathon/cases/attested');
        expect(demo.steps).toContainEqual({ label: 'Lens member directory (who may attest)', url: 'https://api.example/lenses/members' });
        const named = buildJudgeDemo({ manifest: { publicProof: { manifest: 'https://api.example/p', lensMembers: 'https://x/lenses' } } });
        expect(named.steps.find(step => step.label.startsWith('Lens member directory')).url).toBe('https://x/lenses');
        expect(buildJudgeDemo({}).steps.find(step => step.label.startsWith('Lens member directory')).url).toBeNull();
        // A manifest that declares no case leaves its step without a link rather than inventing one.
        expect(named.steps.find(step => step.label === 'Cancelled agreement (market paid NO)').url).toBeNull();
    });

    it('fails closed when proof is incomplete or the prospective market is not visible', () => {
        expect(buildJudgeDemo({ audit: { status: 'incomplete' } }).status).toBe('incomplete');
        const manifest = { hackathon: { branch: 'colosseum-worlds-fair' } };
        expect(buildJudgeDemo({ audit: { status: 'verified' }, manifest, prospective: { state: 'unknown' } }).status).toBe('incomplete');
        expect(buildJudgeDemo({ audit: { status: 'verified' }, manifest, prospective: { state: 'settled' } }).status).toBe('ready');
        expect(buildJudgeDemo({}).proofSummary).toEqual({ pass: 0, warn: 0, fail: 1 });
    });
});
