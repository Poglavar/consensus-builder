// Ownership adapter for Croatian cadastral parcels (HR-<maticni_broj_ko>-<broj_cestice>): the latest
// OSS parcel-info snapshot in parcel_info, as fetched by the land-registry worker.
import { HttpError } from '../../utils/helpers.js';
import { isoOrNull, sharePercentFromText } from '../contract.js';

const PARCEL_ID = /^HR-([0-9]+)-(.+)$/;

export const hrOssAdapter = {
    name: 'hr-oss',
    async lookup({ parcelId, pool }) {
        const match = PARCEL_ID.exec(parcelId);
        if (!match) throw new HttpError(400, 'Expected a parcel id HR-<maticni_broj_ko>-<broj_cestice>.');
        const { rows } = await pool.query(`
            SELECT details, date_added
            FROM parcel_info
            WHERE maticni_broj_ko = $1 AND broj_cestice = $2 AND details IS NOT NULL
            ORDER BY version DESC
            LIMIT 1
        `, [Number(match[1]), match[2]]);
        if (!rows.length) return null;
        const details = typeof rows[0].details === 'string' ? JSON.parse(rows[0].details) : rows[0].details;
        if (!Array.isArray(details?.upisaneOsobe)) {
            throw new Error(`parcel_info details for ${parcelId} carry no upisaneOsobe list`);
        }
        return {
            parcelId,
            owners: details.upisaneOsobe.filter(person => person?.naziv?.trim()).map(person => ({
                name: person.naziv,
                shareText: person.udio ?? null,
                sharePercent: sharePercentFromText(person.udio)
            })),
            // The OSS parcel-info payload states no as-of time of its own.
            observedAt: null,
            retrievedAt: isoOrNull(rows[0].date_added)
        };
    }
};
