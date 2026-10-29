// Shared advertised tool catalogue, checked against actual MCP registration in protocol tests.
export const MCP_LOCAL_TOOLS = Object.freeze([
    'ugt_capabilities', 'ugt_activity', 'ugt_list_agreements', 'ugt_get_agreement', 'ugt_list_attesters',
    'ugt_support_status', 'ugt_oracle_events', 'ugt_inspect_verified_fact', 'ugt_publish_design', 'ugt_propose_agreement',
    'ugt_chain_agreements', 'ugt_chain_agreement', 'ugt_buy_agreement_shares_on_account', 'ugt_sell_agreement_shares', 'ugt_mint_agreement', 'ugt_fund_agreement', 'ugt_bet_on_agreement', 'ugt_buy_agreement_shares',
    'ugt_buy_verified_fact', 'ugt_request_ownership', 'ugt_pledge', 'ugt_donate', 'ugt_refund_donation', 'ugt_void_pledge',
    'ugt_revoke_pledge', 'ugt_release_donations', 'ugt_fulfill_pledge', 'ugt_resolve_market', 'ugt_claim_market',
    'ugt_resolve_external_market', 'ugt_claim_external_market',
    'ugt_voting_status', 'ugt_cast_community_vote', 'ugt_approval_link', 'ugt_find_place', 'ugt_parcel_context', 'ugt_list_designs', 'ugt_get_design', 'ugt_markets', 'ugt_explain',
    'ugt_draft_road', 'ugt_draft_building', 'ugt_draft_track', 'ugt_draft_station', 'ugt_draft_space', 'ugt_draft_parcel_layout', 'ugt_draft_urban_rule',
    'ugt_modify_design', 'ugt_inspect_design', 'ugt_edit_design', 'ugt_compare', 'ugt_draft_agreement', 'ugt_inspect_agreement', 'ugt_edit_agreement',
    'ugt_draft_plan', 'ugt_get_plan', 'ugt_validate_plan', 'ugt_inspect_plan', 'ugt_edit_plan', 'ugt_publish_plan', 'ugt_help', 'ugt_list_sources', 'ugt_export_draft',
    'ugt_import_design', 'ugt_import_model', 'ugt_render_preview', 'ugt_submit_feedback'
]);
// Wallet-only registrations sit between these named boundaries; additions cannot shift the hosted catalogue.
export const MCP_HOSTED_TOOLS = Object.freeze([
    ...MCP_LOCAL_TOOLS.slice(0, MCP_LOCAL_TOOLS.indexOf('ugt_chain_agreements')),
    ...MCP_LOCAL_TOOLS.slice(MCP_LOCAL_TOOLS.indexOf('ugt_voting_status'))
]);
export const MCP_SHARED_PLAN_TOOLS = Object.freeze(['ugt_inspect_shared_plan', 'ugt_edit_shared_plan']);
export const MCP_HOSTED_SHARED_TOOLS = Object.freeze([
    ...MCP_HOSTED_TOOLS.slice(0, MCP_HOSTED_TOOLS.indexOf('ugt_publish_plan')),
    ...MCP_SHARED_PLAN_TOOLS,
    ...MCP_HOSTED_TOOLS.slice(MCP_HOSTED_TOOLS.indexOf('ugt_publish_plan'))
]);
