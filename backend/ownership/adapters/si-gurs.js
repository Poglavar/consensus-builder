// Ownership adapter for Ljubljana parcels (SI-<eid_parcela>): current GURS ownership rights in
// parcel_lj_owner. GURS publishes holders as anonymous person ids, so names read "Owner <id>".
import { HttpError } from '../../utils/helpers.js';
import { isoOrNull } from '../contract.js';

const PARCEL_ID = /^SI-([0-9]{1,30})$/;

export const siGursAdapter = {
    name: 'si-gurs',
    async lookup({ parcelId, pool }) {
        const match = PARCEL_ID.exec(parcelId);
        if (!match) throw new HttpError(400, 'Expected a parcel id SI-<eid_parcela>.');
        const { rows } = await pool.query(`
            SELECT p.date_added AS parcel_added, o.oseba_id, o.share_num, o.share_den, o.meta, o.datum_od, o.date_added
            FROM parcel_lj p
            LEFT JOIN parcel_lj_owner o ON o.parcel_eid = p.eid_parcela AND o.current = true
            WHERE p.eid_parcela = $1 AND p.current = true
            ORDER BY o.oseba_id
        `, [match[1]]);
        if (!rows.length) return null;
        const rights = rows.filter(row => row.oseba_id !== null && row.oseba_id !== undefined);
        const latest = values => values.map(isoOrNull).filter(Boolean).sort().at(-1) ?? null;
        return {
            parcelId,
            owners: rights.map(row => ({
                name: row.meta?.ime || row.meta?.naziv || `Owner ${row.oseba_id}`,
                shareText: `${row.share_num}/${row.share_den}`,
                sharePercent: (Number(row.share_num) / Number(row.share_den)) * 100
            })),
            // The register's own time for this state: when its newest current right took effect.
            observedAt: latest(rights.map(row => row.datum_od)),
            retrievedAt: latest(rights.length ? rights.map(row => row.date_added) : [rows[0].parcel_added])
        };
    }
};
