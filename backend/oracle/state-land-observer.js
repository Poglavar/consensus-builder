// The state land observer: reads each configured city's cadastre views of free state plots and land
// applications (frontend/js/state-land.js), archives every complete read as a snapshot
// (consensus.state_land_snapshot) and records each change of a record's procedure status as a
// `state_land_status` land event. It reports what the cadastre published and when; it does not
// judge whether a decision was lawful. Every collaborator is injectable, so the diff, the removal
// guard and the write order are testable without the network or PostgreSQL.

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const StateLand = require('../../frontend/js/state-land.js');

export const STATE_LAND_EVENT_TYPE = 'state_land_status';
export const OBSERVER_ATTESTER = 'state-land-observer';
export const SUBJECT_TYPES = Object.freeze({ free: 'free-state-plot', applications: 'land-application' });
// A read that lost more than this share of the records the last pass saw is treated as a broken
// read, not as mass removal: the run fails and nothing is written for that view.
export const MAX_REMOVED_SHARE = 0.5;

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const isoOrNull = value => {
    if (typeof value !== 'string') return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

// Cities with a valid `stateLand` block, from the registered city configurations.
export function stateLandCities(cityConfigs) {
    return Object.entries(cityConfigs || {})
        .map(([cityId, city]) => ({ cityId, config: StateLand.normalizeConfig(city?.stateLand) }))
        .filter(entry => entry.config);
}

// The cadastre's record id as an event subject. The id is the EGKN's own, unique within a view.
export const subjectId = recordId => `egkn:${recordId}`;

/** One view's features as snapshot records sorted by id: { id, statusCode, createdAt, updatedAt, geometryHash }. */
export function snapshotRecords(viewName, features) {
    const seen = new Set();
    const records = features.map(feature => {
        const p = feature?.properties || {};
        const id = p.id === null || p.id === undefined ? '' : String(p.id).trim();
        if (!id) throw new Error(`A ${viewName} record has no id (gid ${p.gid}).`);
        if (seen.has(id)) throw new Error(`The ${viewName} view lists record ${id} twice.`);
        seen.add(id);
        return {
            id,
            statusCode: StateLand.statusOf(viewName, p).code,
            createdAt: isoOrNull(p.create_time),
            updatedAt: isoOrNull(p.update_time),
            geometryHash: feature.geometry ? sha256(JSON.stringify(feature.geometry)) : null
        };
    });
    return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const snapshotHash = records => sha256(JSON.stringify(records));

// The outcome a record's status is recorded under: its code, or 'none' when it has none.
export const outcomeOf = record => (record.statusCode === null ? 'none' : String(record.statusCode));

/**
 * The land events one complete read implies against the latest recorded outcome of each subject.
 * @param {{ viewName: 'free'|'applications', config, records, snapshot: { hash, url }, previous: Map<string, string>, fetchedAt: string }} input
 *   previous: subject id → latest recorded outcome ('removed' for a record no longer listed)
 * @returns {{ events: object[], removed: number, changed: number, added: number }}
 */
export function statusEvents({ viewName, config, records, snapshot, previous, fetchedAt }) {
    const subjectType = SUBJECT_TYPES[viewName];
    if (!subjectType) throw new Error(`Unknown state land view: ${viewName}`);
    const listedBefore = [...previous.entries()].filter(([, outcome]) => outcome !== 'removed').map(([id]) => id);
    const present = new Set(records.map(record => subjectId(record.id)));
    const gone = listedBefore.filter(id => !present.has(id));
    if (listedBefore.length && gone.length > MAX_REMOVED_SHARE * listedBefore.length) {
        throw new Error(`The ${viewName} read lacks ${gone.length} of the ${listedBefore.length} records listed before; refusing to record them as removed.`);
    }
    const event = (subject, outcome, observedAt, sourceTime, evidence) => ({
        event_id: `${STATE_LAND_EVENT_TYPE}:${sha256([subjectType, subject, outcome, observedAt].join('|'))}`,
        event_type: STATE_LAND_EVENT_TYPE,
        subject_type: subjectType,
        subject_id: subject,
        outcome,
        source_url: snapshot.url,
        source_hash: snapshot.hash,
        source_observed_at: observedAt,
        attester: OBSERVER_ATTESTER,
        transaction_signature: '',
        evidence: {
            provider: config.provider, districtId: config.districtId, view: viewName,
            snapshotHash: snapshot.hash, fetchedAt, sourceTime, previousOutcome: previous.get(subject) ?? null, ...evidence
        }
    });
    const events = [];
    let added = 0, changed = 0;
    for (const record of records) {
        const subject = subjectId(record.id);
        const outcome = outcomeOf(record);
        const before = previous.get(subject);
        if (before === outcome) continue;
        if (before === undefined || before === 'removed') added += 1; else changed += 1;
        const { stage, label } = StateLand.statusOf(viewName, { [StateLand.VIEWS[viewName].status]: record.statusCode });
        // The event time is the cadastre's own update time of the record; the read time stands in only
        // when the cadastre gives none, and the event says which it is.
        events.push(event(subject, outcome, record.updatedAt ?? fetchedAt, record.updatedAt ? 'update_time' : 'fetched_at', {
            recordId: record.id, statusCode: record.statusCode, stage, statusLabel: label,
            recordCreatedAt: record.createdAt, geometryHash: record.geometryHash
        }));
    }
    // A record that is no longer listed has no source time of its own: the read that missed it dates it.
    for (const subject of gone) events.push(event(subject, 'removed', fetchedAt, 'fetched_at', { recordId: subject.slice('egkn:'.length) }));
    return { events, removed: gone.length, changed, added };
}

/** Reads every page of one view: `fetchJson(url)` returns the parsed WFS answer. */
export async function readStateLandView(config, viewName, fetchJson) {
    const features = [];
    let startIndex = 0;
    for (let page = 0; page < StateLand.MAX_PAGES && startIndex !== null; page += 1) {
        const result = StateLand.readPage(await fetchJson(StateLand.viewUrl(config, viewName, { startIndex })), startIndex);
        features.push(...result.features);
        startIndex = result.next;
    }
    if (startIndex !== null) throw new Error(`The ${viewName} view exceeded ${StateLand.MAX_PAGES} pages.`);
    return features;
}

// The view's URL without paging, as the snapshot's and the events' source.
export function viewSourceUrl(config, viewName) {
    const url = new URL(StateLand.viewUrl(config, viewName));
    url.searchParams.delete('startIndex');
    url.searchParams.delete('count');
    return url.toString();
}

/**
 * One observer pass over every city and view. Per-view failures are collected, never hidden: a pass
 * with any is a failed run.
 * @param {{ cities: Array<{cityId, config}>, fetchJson, store: { latestOutcomes, writeView }, apply?: boolean,
 *   now?: () => number, log?: (message: string) => void }} options
 *   store.latestOutcomes(subjectType, subjectIdPrefix) → Map; store.writeView({ snapshot, events }) writes both at once
 */
export async function observeStateLand({ cities, fetchJson, store, apply = false, now = () => Date.now(), log = () => {} }) {
    const views = [];
    const failed = [];
    for (const { cityId, config } of cities) {
        for (const viewName of Object.keys(SUBJECT_TYPES)) {
            const label = `${cityId} ${viewName}`;
            try {
                const fetchedAt = new Date(now()).toISOString();
                const features = await readStateLandView(config, viewName, fetchJson);
                const records = snapshotRecords(viewName, features);
                const snapshot = { hash: snapshotHash(records), url: viewSourceUrl(config, viewName) };
                const previous = await store.latestOutcomes(SUBJECT_TYPES[viewName], config.districtId);
                const diff = statusEvents({ viewName, config, records, snapshot, previous, fetchedAt });
                if (apply) {
                    await store.writeView({
                        snapshot: { ...snapshot, provider: config.provider, viewName, districtId: config.districtId, records, fetchedAt },
                        events: diff.events
                    });
                }
                log(`${label}: ${records.length} records · snapshot ${snapshot.hash.slice(0, 12)} · ${diff.added} new · ${diff.changed} changed · ${diff.removed} removed${apply ? '' : ' (dry run)'}`);
                views.push({ cityId, viewName, records: records.length, snapshotHash: snapshot.hash, ...diff, events: diff.events.length });
            } catch (error) {
                log(`${label} failed: ${error.message}`);
                failed.push({ cityId, viewName, error: error.message });
            }
        }
    }
    return { views, failed };
}

/** The PostgreSQL store. Events are scoped to a district through their evidence. */
export function createStateLandStore(pool) {
    return {
        async latestOutcomes(subjectType, districtId) {
            const { rows } = await pool.query(`
                SELECT DISTINCT ON (subject_id) subject_id, outcome
                  FROM consensus.land_event
                 WHERE event_type = $1 AND subject_type = $2 AND (evidence->>'districtId')::int = $3
                 ORDER BY subject_id, created_at DESC, source_observed_at DESC`, [STATE_LAND_EVENT_TYPE, subjectType, districtId]);
            return new Map(rows.map(row => [row.subject_id, row.outcome]));
        },
        async writeView({ snapshot, events }) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(`
                    INSERT INTO consensus.state_land_snapshot
                        (snapshot_hash, provider, view_name, district_id, source_url, record_count, records, fetched_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
                    ON CONFLICT (snapshot_hash) DO UPDATE SET updated_at = now()`,
                [snapshot.hash, snapshot.provider, snapshot.viewName, snapshot.districtId, snapshot.url, snapshot.records.length,
                    JSON.stringify(snapshot.records), snapshot.fetchedAt]);
                for (const e of events) {
                    await client.query(`
                        INSERT INTO consensus.land_event
                            (event_id, event_type, subject_type, subject_id, outcome, source_url, source_hash,
                             source_observed_at, attester, transaction_signature, evidence)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
                        ON CONFLICT (event_id) DO NOTHING`,
                    [e.event_id, e.event_type, e.subject_type, e.subject_id, e.outcome, e.source_url, e.source_hash,
                        e.source_observed_at, e.attester, e.transaction_signature, JSON.stringify(e.evidence)]);
                }
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        }
    };
}
