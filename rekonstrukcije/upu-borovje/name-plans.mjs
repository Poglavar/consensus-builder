#!/usr/bin/env node
// Name the two Borovje plans (plans.md) on a backend: the official reconstruction and the "urbani
// blokovi" alternative. Both share the official parcel layouts, streets and parks; they differ in
// their eleven buildings. Members are resolved by stable proposal_id, so the same script names the
// same plans (with the same plan hash) on any backend that holds the records. Named plans never
// change: a name that exists is reported and left alone.
//
//   node name-plans.mjs --backend <api> --origin <app origin>           # dry run: resolve and print
//   node name-plans.mjs --backend <api> --origin <app origin> --apply
import { parseArgs } from 'node:util';
import { request } from '../../backend/scripts/lib/candlestick-common.mjs';

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const KAZETE = Array.from({ length: 11 }, (_, i) => `m1-${i + 1}`);
// Apply order: parcel layouts, the second street piece, buildings, parks, then the main street —
// the order the verified 22/22 link uses (README.md).
const shared = {
    head: ['p-upu-borovje-parcelacija', 'p-upu-borovje-parcelacija-2', 'p-upu-borovje-parcelacija-3', 'upu-borovje-ulice-split-1'],
    tail: ['upu-borovje-r2-0', 'upu-borovje-z1-1', 'upu-borovje-z1-2', 'upu-borovje-z1-3', 'upu-borovje-z1-4', 'upu-borovje-z1-5', 'upu-borovje-ulice']
};
export const PLANS = [
    {
        slug: 'upu-borovje',
        title: 'UPU Borovje – zona jug (prijedlog plana 2026)',
        author: 'Grad Zagreb (rekonstrukcija prijedloga plana)',
        description: 'Rekonstrukcija prijedloga Urbanističkog plana uređenja Borovje – zona jug (javna rasprava 23.6.–22.7.2026): '
            + 'jedanaest samostojećih lamela P+3 do P+8 na građevnim česticama M1-1…M1-11, javni parkovi Z1, rekreacija R2, '
            + 'nova ulična mreža i parcelacija.',
        members: [...shared.head, ...KAZETE.map(k => `upu-borovje-${k}`), ...shared.tail]
    },
    {
        slug: 'borovje-urbani-blokovi',
        title: 'Borovje – urbani blokovi (alternativa)',
        author: 'Urban Game Theory – alternativni prijedlog',
        description: 'Alternativa planu UPU Borovje na istim građevnim česticama: otvoreni gradski blokovi P+4 i P+5 koji drže '
            + 'ulicu, s dvorištima otvorenima prema parku, umjesto samostojećih lamela. Ulice, parcelacija i parkovi isti su kao '
            + 'u službenom planu.',
        members: [...shared.head, ...KAZETE.map(k => `borovje-urbani-blokovi-${k}`), ...shared.tail]
    }
];

const { values } = parseArgs({ options: {
    backend: { type: 'string' }, origin: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' }
} });
if (values.help || !values.backend || !values.origin) {
    console.log('Usage: node name-plans.mjs --backend <api> --origin <app origin> [--apply]');
    process.exit(values.help ? 0 : 1);
}

for (const plan of PLANS) {
    const existing = await request(values.backend, values.origin, 'GET', `/plans/${plan.slug}`);
    if (existing.status === 200) {
        log(`${plan.slug} already named (${existing.json.proposalIds.length} members, hash ${existing.json.planHash}); left alone`);
        continue;
    }
    const ids = [];
    for (const proposalId of plan.members) {
        const found = await request(values.backend, values.origin, 'GET', `/proposals/${encodeURIComponent(proposalId)}`);
        const id = found.json && (found.json.id ?? found.json.proposal?.id);
        if (found.status !== 200 || !id) throw new Error(`${values.backend} has no ${proposalId} (${found.status})`);
        ids.push(String(id));
    }
    log(`${plan.slug}: ${ids.length} members → ${ids.join(',')}`);
    if (!values.apply) continue;
    const created = await request(values.backend, values.origin, 'POST', '/plans', {
        slug: plan.slug, proposalIds: ids, title: plan.title, description: plan.description, author: plan.author,
        place: 'Borovje', city: 'zagreb'
    });
    if (created.status !== 201) throw new Error(`naming ${plan.slug} failed (${created.status}): ${created.text.slice(0, 300)}`);
    log(`named ${plan.slug} · hash ${created.json.planHash} · mintable ${created.json.mintable}`);
}
if (!values.apply) log('DRY RUN: nothing named (add --apply).');
