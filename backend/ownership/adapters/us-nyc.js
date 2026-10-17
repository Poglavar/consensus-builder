// Ownership adapter for New York parcels (US-NY-<swis_sbl_id>): assessment-roll owners from
// parcel_nyc_unit, with condo unit owners resolved live from NYC DOF (nyc-condo-owners.js).
import { HttpError } from '../../utils/helpers.js';
import { isoOrNull } from '../contract.js';
import { fetchNycOwners, isPlaceholderOwner, isCondoBillingLot } from '../../routes/nyc-condo-owners.js';

const PARCEL_ID = /^US-NY-([A-Za-z0-9][A-Za-z0-9-]*)$/;

function uniqueNames(names) {
    const seen = new Set();
    return names.map(name => (name || '').toString().trim()).filter(name => {
        const key = name.replace(/\s+/g, ' ').toUpperCase();
        if (!name || isPlaceholderOwner(name) || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export const usNycAdapter = {
    name: 'us-nyc',
    async lookup({ parcelId, pool, fetchImpl }) {
        const match = PARCEL_ID.exec(parcelId);
        if (!match) throw new HttpError(400, 'Expected a parcel id US-NY-<swis_sbl_id>.');
        const { rows } = await pool.query(`
            SELECT u.swis_sbl_id, MIN(u.sbl) AS sbl, MAX(u.roll_yr) AS roll_yr, MAX(u.date_updated) AS date_updated,
                   array_remove(array_agg(DISTINCT u.primary_owner), NULL) AS primary_owner
            FROM parcel_nyc_unit u
            WHERE u.swis_sbl_id = $1 OR u.swis_print_key_id = $1
            GROUP BY u.swis_sbl_id
            LIMIT 1
        `, [match[1]]);
        if (!rows.length) return null;
        const row = rows[0];
        let owners = uniqueNames(row.primary_owner || []);
        let observedAt = Number.isSafeInteger(row.roll_yr) && row.roll_yr > 0 ? String(row.roll_yr) : null;
        let retrievedAt = isoOrNull(row.date_updated);
        // The state roll stamps condos "UNAVAILABLE OWNER", and a condo billing lot names only the
        // association: resolve the unit owners from DOF for those. A DOF failure is the request's
        // failure; the placeholder is never shown as if it were the answer.
        if (row.sbl && (!owners.length || isCondoBillingLot(row.sbl))) {
            const resolved = await fetchNycOwners(row.sbl, fetchImpl ? { fetchImpl } : {});
            if (resolved.owners.length) {
                owners = resolved.owners;
                observedAt = resolved.year ? String(resolved.year) : null;
                retrievedAt = isoOrNull(resolved.fetchedAt);
            }
        }
        // Neither source states shares, so none are invented.
        return { parcelId, owners: owners.map(name => ({ name, shareText: null, sharePercent: null })), observedAt, retrievedAt };
    }
};
