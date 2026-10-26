// Search published plans and designs using index metadata, without loading their geometry.
export function setupSearchRoute(app, { pool }) {
    app.get('/search', async (req, res) => {
        const { q, limit: rawLimit } = req.query;
        const query = typeof q === 'string' ? q.trim() : '';
        const limit = rawLimit === undefined ? 20 : Number(rawLimit);
        if (query.length < 2 || query.length > 200 || (rawLimit !== undefined &&
            (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit))) || !Number.isInteger(limit) || limit > 50) {
            return res.status(400).json({ error: 'Use a search string of 2–200 characters and a limit from 1 to 50.', code: 'bad-request' });
        }
        const pattern = `%${query.replace(/[\\%_]/g, character => `\\${character}`)}%`;
        try {
            const [plans, designs] = await Promise.all([
                pool.query(`SELECT cid, content->>'title' AS title, content->'view'->>'city' AS city,
                        jsonb_array_length(content->'designCids') AS design_count
                    FROM consensus.plan
                    WHERE content->>'title' ILIKE $2 OR cid = $1
                    ORDER BY CASE WHEN lower(content->>'title') = lower($1) THEN 0
                        WHEN strpos(lower(content->>'title'), lower($1)) = 1 THEN 1 ELSE 2 END,
                        created_at DESC, cid LIMIT $3`, [query, pattern, limit]),
                pool.query(`SELECT cid, title, author, city, goal FROM consensus.design
                    WHERE title ILIKE $2 OR author ILIKE $2 OR cid = $1
                    ORDER BY CASE WHEN lower(title) = lower($1) THEN 0
                        WHEN strpos(lower(title), lower($1)) = 1 THEN 1 ELSE 2 END,
                        created_at DESC, cid LIMIT $3`, [query, pattern, limit])
            ]);
            res.json({ plans: plans.rows.map(row => ({ cid: row.cid, title: row.title, city: row.city,
                designCount: Number(row.design_count) })), designs: designs.rows });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] [search] Index lookup failed:`, error.message);
            res.status(503).json({ error: 'Plans and designs could not be searched. Please retry.', code: 'search-unavailable' });
        }
    });
}
