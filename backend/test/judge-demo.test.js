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
        expect(demo).toMatchObject({ status: 'ready', marketState: 'awaiting_evidence' });
        expect(demo.steps).toContainEqual({ label: 'Prospective market · awaiting_evidence', url: 'https://explorer/market' });
    });

    it('narrates the attested case and the lens member directory', () => {
        const demo = buildJudgeDemo({
            manifest: { publicProof: { manifest: 'https://api.example/hackathon/proof.json', attestedCase: 'https://api.example/hackathon/cases/attested' } }
        });
        const labels = demo.steps.map(step => step.label);
        expect(labels.indexOf('Attested case (lens member attested ownership, owners signed)'))
            .toBe(labels.indexOf('Executed case (market paid YES)') + 1);
        expect(demo.steps).toContainEqual({ label: 'Attested case (lens member attested ownership, owners signed)', url: 'https://api.example/hackathon/cases/attested' });
        expect(demo.steps).toContainEqual({ label: 'Lens member directory (who may attest)', url: 'https://api.example/lenses/members' });
        const named = buildJudgeDemo({ manifest: { publicProof: { manifest: 'https://api.example/p', lensMembers: 'https://x/lenses' } } });
        expect(named.steps.find(step => step.label.startsWith('Lens member directory')).url).toBe('https://x/lenses');
        expect(buildJudgeDemo({}).steps.find(step => step.label.startsWith('Lens member directory')).url).toBeNull();
    });

    it('fails closed when proof is incomplete', () => {
        expect(buildJudgeDemo({ audit: { status: 'incomplete' } }).status).toBe('incomplete');
    });
});
