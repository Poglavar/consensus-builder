// Server-side proxy to the CCView Canton explorer API (ccview.io). Keeps the
// API key server-side and returns a compact party summary (Canton Coin balance
// + activity) plus the public explorer URL. Read-only; used by /canton/ccview.

const base = () => (process.env.CCVIEW_API_URL || '').replace(/\/$/, '');
const key = () => process.env.CCVIEW_API_KEY;

// Public explorer page for a party (no key needed; safe to open in a browser).
export const ccviewPartyUrl = (party) => `${base()}/party/${party}/`;

export async function ccviewParty(party) {
  if (!base() || !key()) throw new Error('CCView not configured (CCVIEW_API_URL/CCVIEW_API_KEY)');
  const res = await fetch(`${base()}/api/v4/parties/${encodeURIComponent(party)}`, {
    headers: { 'X-API-Key': key() },
  });
  const explorerUrl = ccviewPartyUrl(party);
  if (res.status === 404) return { party, indexed: false, explorerUrl };
  if (!res.ok) throw new Error(`ccview ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return {
    party,
    indexed: true,
    coinBalance: j.balance?.total_coin_holdings ?? j.amulets?.amulet_balance ?? null,
    transfers: j.total_transfers_count ?? null,
    explorerUrl,
  };
}
