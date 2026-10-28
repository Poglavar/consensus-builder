// Current agreement readers share one plan-membership gate. Retired inline-membership records
// never become trade or payout subjects merely because they retain an indexed chain pointer.
export const currentPlanAgreementSelect = ({ predicate, orderBy, limit }) => `
    SELECT a.cid, a.city, a.title, a.author, a.input_parcel_ids, a.parcel_source_id, a.deadline,
        a.content->>'sponsor' AS sponsor,
        ARRAY(SELECT d.content->>'title' FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(p.content->'designCids') = 'array' THEN p.content->'designCids' ELSE '[]'::jsonb END
        ) AS linked(cid) JOIN consensus.design d ON d.cid = linked.cid) AS design_titles,
        a.onchain, a.screenshot_url, a.screenshot_before_url, a.screenshot_pair_url, a.created_at
    FROM consensus.agreement a
    JOIN consensus.plan p ON p.cid = a.content->>'planCid'
        AND p.content->>'schema' = 'plan/v1'
        AND CASE WHEN jsonb_typeof(p.content->'designCids') = 'array' THEN
            jsonb_array_length(p.content->'designCids') > 0
            AND (SELECT bool_and(jsonb_typeof(item.value) = 'string' AND item.value #>> '{}' <> '')
                FROM jsonb_array_elements(p.content->'designCids') AS item(value))
            AND (SELECT count(DISTINCT value) = count(*)
                FROM jsonb_array_elements_text(p.content->'designCids') AS item(value))
            AND cardinality(a.design_cids) = jsonb_array_length(p.content->'designCids')
            AND a.design_cids @> ARRAY(SELECT jsonb_array_elements_text(p.content->'designCids'))
            AND ARRAY(SELECT jsonb_array_elements_text(p.content->'designCids')) @> a.design_cids
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.content->'designCids') AS linked(cid)
                WHERE NOT EXISTS (SELECT 1 FROM consensus.design d WHERE d.cid = linked.cid))
        ELSE false END
    WHERE ${predicate}
        AND a.content->>'planCid' IS NOT NULL
        AND NOT (a.content ? 'designs')
        AND NOT (a.content ? 'designCids')
    ORDER BY ${orderBy}
    LIMIT ${limit}`;

export const CURRENT_AGREEMENTS_BY_ACCOUNT_SQL = currentPlanAgreementSelect({
    predicate: "a.onchain->>'account' = $1", orderBy: 'a.created_at DESC', limit: '20'
});
