// One-off backfill of ens_plan.supersedes for the UPU Borovje plan versions (v2 supersedes v1 and v3
// supersedes v2, for both plans), from the chain the importer names them with
// (rekonstrukcije/upu-borovje/name-plans.mjs). GET /markets folds a superseded version under the
// current one; a database whose versions lack the link lists them as identical rows instead.
//
// Idempotent: a link already recorded is left alone, and a different one is reported, never
// overwritten (named plans are immutable, plans.md; only a missing link is filled). The column itself
// is defined in backend/ens/ens-plan-ddl.sql, applied on every backend deploy.
//
//   node scripts/backfill-plan-supersedes.mjs --dry-run
//   node scripts/backfill-plan-supersedes.mjs --apply
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '../db/connection.cjs';
import { PLANS } from '../../rekonstrukcije/upu-borovje/name-plans.mjs';

const USAGE = `Usage: node scripts/backfill-plan-supersedes.mjs (--dry-run | --apply)
Records ens_plan.supersedes for the Borovje plan versions where it is missing.
  --dry-run   report what would be written (read-only transaction)
  --apply     write the missing links in one transaction, then read them back
Connection: DATABASE_URL (backend/.env, or exported to point at another database).`;
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);

// The links a list of plan definitions records: [{ slug, supersedes }] for every version that names
// its predecessor.
export function supersessionLinks(plans) {
    return (Array.isArray(plans) ? plans : [])
        .filter(plan => plan && plan.slug && plan.supersedes)
        .map(plan => ({ slug: plan.slug, supersedes: plan.supersedes }));
}

// What each link needs, given the database rows ({ slug, supersedes }) of the slugs involved:
//   set       the version and its predecessor exist and no link is recorded: write it
//   ok        the link is already recorded
//   conflict  another predecessor is recorded: reported, never overwritten
//   missing   the version or its predecessor is not in this database: nothing to link
export function planBackfill(links, rows) {
    const bySlug = new Map((Array.isArray(rows) ? rows : []).map(row => [row.slug, row]));
    return links.map(link => {
        const row = bySlug.get(link.slug);
        if (!row) return { ...link, action: 'missing', reason: `no plan ${link.slug}` };
        if (!bySlug.has(link.supersedes)) return { ...link, action: 'missing', reason: `no plan ${link.supersedes}` };
        if (row.supersedes === link.supersedes) return { ...link, action: 'ok' };
        if (row.supersedes) return { ...link, action: 'conflict', recorded: row.supersedes };
        return { ...link, action: 'set' };
    });
}

export function parseArgs(argv) {
    const args = { apply: false, dryRun: false, help: false };
    for (const arg of argv) {
        if (arg === '--apply') args.apply = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`unknown argument ${arg}\n${USAGE}`);
    }
    if (args.apply && args.dryRun) throw new Error(`--apply and --dry-run exclude each other\n${USAGE}`);
    // Without a mode there is nothing to do but explain.
    if (!args.apply && !args.dryRun) args.help = true;
    return args;
}

const SELECT_SQL = 'SELECT slug, supersedes FROM ens_plan WHERE slug = ANY($1::text[])';

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(USAGE); return; }
    dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
    const links = supersessionLinks(PLANS);
    const slugs = Array.from(new Set(links.flatMap(link => [link.slug, link.supersedes])));
    const client = createClient();
    await client.connect();
    try {
        await client.query(args.apply ? 'BEGIN' : 'BEGIN READ ONLY');
        const { rows } = await client.query(`${SELECT_SQL}${args.apply ? ' FOR UPDATE' : ''}`, [slugs]);
        log(`${links.length} links over ${slugs.length} plans; ${rows.length} of them in ${client.host}:${client.port}/${client.database}`);
        const steps = planBackfill(links, rows);
        for (const [index, step] of steps.entries()) {
            const detail = step.action === 'conflict' ? ` (recorded: ${step.recorded})` : step.reason ? ` (${step.reason})` : '';
            log(`${index + 1}/${steps.length} ${step.slug} supersedes ${step.supersedes}: ${step.action}${detail}`);
            if (!args.apply || step.action !== 'set') continue;
            const result = await client.query('UPDATE ens_plan SET supersedes = $2, updated_at = now() WHERE slug = $1 AND supersedes IS NULL',
                [step.slug, step.supersedes]);
            if (result.rowCount !== 1) throw new Error(`${step.slug}: expected to update 1 row, updated ${result.rowCount}`);
        }
        await client.query(args.apply ? 'COMMIT' : 'ROLLBACK');
        const count = action => steps.filter(step => step.action === action).length;
        if (args.apply) {
            // The committed rows, not the plan, decide whether it worked.
            const { rows: after } = await client.query(SELECT_SQL, [slugs]);
            const left = planBackfill(links, after).filter(step => step.action === 'set');
            if (left.length) throw new Error(`still unlinked after commit: ${left.map(step => step.slug).join(', ')}`);
        }
        log(`${args.apply ? 'wrote' : 'would write'} ${count('set')}; already recorded ${count('ok')}; conflicts ${count('conflict')}; `
            + `missing ${count('missing')}${args.apply ? '' : ' (dry run: nothing written)'}`);
        if (count('conflict')) process.exitCode = 2;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(`[${new Date().toISOString()}] ${error.message}`); process.exit(1); });
}
