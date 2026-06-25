// Parcel ownership CACHE (non-canonical). Canonical ownership is on-chain (pulled on request);
// this is a best-effort display/game cache so a transfer made in one browser can be seen
// elsewhere. Not a source of truth. Table is ensured on setup so no manual migration is needed.

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS parcel_ownership (
    parcel_id   VARCHAR(255) PRIMARY KEY,
    owner       VARCHAR(255) NOT NULL,
    city        VARCHAR(100),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

export function setupParcelOwnershipRoute(app, pool) {
    if (!pool) {
        console.warn('[parcel-ownership] no DB pool; ownership persistence disabled');
        return;
    }
    pool.query(CREATE_TABLE).catch(err => console.error('[parcel-ownership] ensure table failed:', err.message));

    // Upsert the owner of a parcel.
    app.post('/parcel-ownership', async (req, res) => {
        try {
            const { parcelId, owner, city } = req.body || {};
            if (!parcelId || !owner) {
                return res.status(400).json({ error: 'parcelId and owner are required.' });
            }
            const pid = String(parcelId).slice(0, 255);
            const own = String(owner).slice(0, 255);
            const cty = city ? String(city).slice(0, 100) : null;
            await pool.query(
                `INSERT INTO parcel_ownership (parcel_id, owner, city, updated_at)
                 VALUES ($1, $2, $3, now())
                 ON CONFLICT (parcel_id) DO UPDATE
                   SET owner = EXCLUDED.owner, city = EXCLUDED.city, updated_at = now()`,
                [pid, own, cty]
            );
            res.json({ ok: true });
        } catch (err) {
            console.error('[parcel-ownership] upsert failed:', err);
            res.status(500).json({ error: 'Failed to persist ownership.' });
        }
    });

    // List owners as { parcel_id: owner }, optionally scoped to a city.
    app.get('/parcel-ownership', async (req, res) => {
        try {
            const city = req.query.city ? String(req.query.city).slice(0, 100) : null;
            const sql = city
                ? 'SELECT parcel_id, owner FROM parcel_ownership WHERE city = $1'
                : 'SELECT parcel_id, owner FROM parcel_ownership';
            const result = await pool.query(sql, city ? [city] : []);
            const owners = {};
            result.rows.forEach(r => { owners[r.parcel_id] = r.owner; });
            res.json({ owners });
        } catch (err) {
            console.error('[parcel-ownership] list failed:', err);
            res.status(500).json({ error: 'Failed to load ownership.' });
        }
    });
}
