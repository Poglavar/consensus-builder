# San Francisco devnet demo preparation — 26 October 2026

This record describes preparation and a failed publication attempt. It is not evidence of published
agreements, minted agreement accounts, markets, or real landowner consent. See the current
[pair record](sf-agreement-bets.json) and [review](sf-agreement-bets.md).

## Prepared records

Both published design records preserve the imported building geometry and all 116 original parcel references.
The existing source content hashes and 2027 deadlines are unchanged. Current binding adds coverage
for 118 Courtyard parcels and 117 FivePoint parcels. The FivePoint design keeps the imported 99
modeled volumes; the newer 110-volume importer output did not replace them. Building geometry is
unchanged. Each design site was unioned with its imported footprints to contain their full extent.

| Intent | Published design CID | Prepared plan CID | Prepared agreement CID | Bound inputs / output pieces | Modeled open ground |
| --- | --- | --- | --- | --- | ---: |
| Courtyard | `bafybeiaiubi5q7wwjyyiavt223lxtr72vezmtwpmfvpy3jgrsaerpslnyq` | `bafkreic6kpty3f5iyfr4mnittekslxnrcwylsspas2x77c2yy6entz4cne` | `bafkreiarw7qlptbgq2eiccwcmcg5yiuazh5i3zcx7lmt4ly32j4f6q6aj4` | 118 / 122 | 76,206.601095 m² |
| FivePoint | `bafkreihwnn54kntvooptfzcta4li5urn2cnvjkb5lwldr6yvofkknmrloi` | `bafkreih6kmeom5v4m4jxpx4qbxrvnc3gmm7h2llqacmasrbcsknyyb2ciy` | `bafkreidtnissamp6q7hql35z4izn5k546puin3q7ou7gm7izvi4xswywx4` | 117 / 121 | 76,206.629452 m² |

Prepared agreement and plan CIDs identify local bytes only. The rights snapshot assigns the input
parcels to one simulated demonstration wallet. It records no real owner consent. Open ground is the
modeled site outside its bound cadastral parcels; it carries no legal ownership
claim.

## Publication attempt and status

The upload to Pinata failed with HTTP 403, code `pinning-quota-exhausted`. Neither agreement nor its
plan was published or indexed, neither agreement was minted, and neither market was created. The
pair JSON therefore keeps `agreementCid`, `agreementAccount`, and `marketAccount` null and labels
the state `prepared-labelled-devnet-demos-pinning-blocked`.

At the 26 October observation, the demonstration wallet had 58.723938 devnet USDC, while the two
canonical market seeds totalled 138.629440 USDC: a 79.905502 USDC shortfall. This is a dated
observation, not a guarantee of the wallet's current balance. Publication, indexing, minting and
funding remain outstanding before these can be described as executable devnet agreement bets with
simulated rights.
