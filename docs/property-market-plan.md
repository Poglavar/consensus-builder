<!-- Open plan for buying and selling one plot or one flat end to end (branch property-market). Remove when done; the contract goes to property-offers.md and vocabulary.md. -->
# Property market: one plot, one flat (open plan)

Decisions behind it (user, 2026-11-27): plots as their sources give them, one asset per offer,
SOL or devnet USDC, no lens rule that approves anyone (an unconfirmed offer waits and expires),
double sale impossible within one lens and never enforced by the program, the first holder of a
flat stated by the developer's lens (new builds) or a lens member confirming a self-declaration
(existing buildings), the buyer choosing the lens it trusts, keys and ownership shown the
Tokenizario way, one flat id everywhere, satellite storeys allowed for estimated flats. Bundles and
the open thinking on them: [property-offers.md](property-offers.md#open-double-sale-and-multi-parcel-offers).

## Steps

| # | Step | Status |
|---|---|---|
| 1 | `property_offer` v2: one asset, SOL/USDC, buyer's and seller's lens sets, waiting state, PropertyOfferConfirmation-v1 | done (3cf6774aa), not deployed |
| 2 | Offer record v2 and one flat id (`building · storey · flat`) | |
| 3 | Browser codec and bridge for v2 (USDC token accounts included) | |
| 4 | Lens member statements from a wallet: Holding-v1 (first holder), sale confirmation at the per-holding address, withdraw | |
| 5 | Reader: holder according to my lens (chain walk), key labels (portrait, self-described profile name) | |
| 6 | Server index (location, kind, status, lens members), self-declaration requests, MCP parity; retire acceptance sessions, transfer store and the lens service's offer routes | |
| 7 | UI: offer dialog, offer panel, Lens requests screen, market list, badges | |
| 8 | X-ray flats for existing buildings (plan as buildings come into range; satellite storeys) | |
| 9 | Parcel anchors seeded by hash | |
| 10 | Devnet deploy (needs the user's go), schema registration, browser walkthrough in Alatau and Almaty | |

## Holder according to a lens member (step 5)

Chain only, deterministic addresses, no listing calls: the member's Holding-v1 statement for the
asset (nonce = asset hash) names the first holder; the member's sale confirmation for (asset,
holding) is at nonce sha256("sale", asset, holding) and names an offer; if that offer settled, its
buyer holds the asset through the offer's address, and the walk repeats. A confirmation for an
offer that expired or was cancelled leaves the holder unchanged until the member withdraws it.
