<!-- Open plan: short, sayable links for published designs, plans and agreements, with the options weighed. Nothing here is built yet. -->
# Short links

Published designs, plans and agreements are named by their CID (CIDv1 base32, 59 characters,
`bafkrei…`): `/designs/<cid>`, `/plans/<cid>`, `/agreements/<cid>`, and `?design=<cid>` (or
`?plan=`, `?agreement=`) in the address bar. The CID is the record's identity in records,
signatures, IPFS and on chain, and that does not change. This plan adds shorter names that only
look a record up. Status: proposed, not built.

## Goal

People should be able to say, type and discuss a record: "plan 342, design 3". The link should
stay short where it is seen (chat, email, slides, posters, QR codes) and should keep the brand
visible.

On X the length of a link does not matter: X counts every link as 23 characters and shows the
preview card rather than the address. The full CID link already looks the same in a post.

## Options

### 1. A number per record (recommended)

When the server indexes a published record, it assigns the next number of that kind: design 1207,
plan 342, agreement 58. Each kind has its own counter, so the numbers stay small and `plans/342`
does not suggest anything about `designs/342`. Numbers are global, not per city, because a
design's city is derived and can be re-derived.

A design inside a plan or agreement is named by its position in the plan: `/p/342/3`. A plan
cannot change, so position 3 always names the same design. An agreement references exactly one
plan, so `/a/58/3` is member 3 of that plan.

```
/plans/342      /plans/342/designs/3      /p/342      /p/342/3
/agreements/58  /agreements/58/designs/3  /a/58       /a/58/3
/designs/1207                             /d/1207
```

Pros:

- Short, readable and sayable: "plan 342, design 3".
- The brand stays in the visible link.
- A number cannot be confused with a CID (digits only, against `baf…`), so every route can accept
  either.

Cons:

- **The index stops being rebuildable from IPFS.** A number assigned at indexing cannot be
  re-derived from the pinned bytes. The numbers must be backed up with the database. A reindex must
  carry them across, and the vocabulary entry for the index must say so. This is the one
  structural cost.
- **A number only means something on the server that assigned it.** A CID resolves through any
  gateway, but `/p/342` needs our index. Local and prod number differently, so a local link is a
  different record on prod; local links must keep their `backend` parameter.
- **Numbers must never leak into records.** Records, comments and discussion stay keyed on CIDs;
  record validators refuse a digit string where a CID belongs.
- **One design gets several names:** its CID, its own number, and its position in each plan that
  holds it. Positions are shown only inside that plan's panel.
- **Positions follow the plan's CID order** (`designCids` is sorted by CID), not authoring order,
  so #1, #2, #3 carry no meaning. The plan panel must show the numbers in that order.
- **Sequential numbers are enumerable and show how many records exist.** Everything is already
  listed by `GET /plans` and the others, so only the count is new.

### 2. A CID prefix (git-style)

The first 10 to 12 characters of the CID's digest, not of the string: the first 7 characters of
every CID are the header (`bafkrei` or `bafybei`), and the 8th carries only 3 random bits. Stored
as a derived, indexed column.

Collision odds across n records (birthday bound; 5 bits per base32 character):

| characters | bits | 10k records | 100k | 1M |
|---|---|---|---|---|
| 8 | 40 | 1 in 22,000 | 1 in 220 | ~45% |
| 10 | 50 | 1 in 22M | 1 in 225,000 | 1 in 2,250 |
| 12 | 60 | 1 in 23B | 1 in 230M | 1 in 2.3M |

A collision makes a lookup ambiguous (the server finds two rows and refuses, as git does); it
never gives a wrong answer. The real failure is an old link becoming ambiguous when a colliding
record arrives later.

Pros:

- No stored state; the index stays rebuildable from IPFS.
- The same id on local and prod.

Cons:

- Not sayable or memorable: `/p/qm4xv7k2ae`.
- Longer than a number for the foreseeable record counts.

### 3. A short domain

A cheap short domain (`ugt.xx`) with one Cloudflare redirect rule, `ugt.xx/*` to
`urbangametheory.xyz/p/*`. No shortener database.

Pros:

- The shortest printed form, for posters and QR codes.
- Can be added at any time without changing the app.

Cons:

- Nothing gained on X, where links count as 23 characters anyway.
- Hides the brand behind a redirect, which reads as less trustworthy in chat.
- One more domain to renew and keep in Cloudflare.

## Recommendation

Build option 1 with both the long and the short paths. The Share box and the address bar emit the
short form, and the CID forms keep working. Skip prefixes: a second short form that is worse for
people is not worth the extra code. Hold the short domain until there is a print or QR need.

## Work

About a day:

- **Database:** an identity column on `consensus.design`, `consensus.plan` and
  `consensus.agreement`, numbered in `created_at` order for existing rows and never reused. Adding
  a defaulted column is backward compatible, but prod DDL goes before the code deploy.
- **API and MCP:** `GET /designs/:ref`, `/plans/:ref` and `/agreements/:ref` accept digits or a
  CID and always return the CID. MCP tools accept the same refs, which covers MCP parity.
- **Frontend:** the record routes (`app-routes.js`) and the parsers in `named-plans.js`,
  `agreement-sync.js` and `sharing-routes.js` learn `/p/`, `/d/`, `/a/` and digit refs.
  `SelectionAddress` writes the number once it is known. The plan panel shows member numbers.
- **nginx:** routes `/p/`, `/d/` and `/a/` to the app. It does not resolve numbers, because that
  needs the database.
- **og-proposals Worker:** routes `/p/*`, `/d/*` and `/a/*`, resolving the number through the API,
  so short links unfurl with the record's card.
- **Tests:** mock API numbering for the e2e specs, plus a record-validator test that refuses digit
  strings.

## Related

- [Location first](location-first.md): the selection in the address bar.
- [Plan, design and agreement](plan-design-agreement.md): the records and their CIDs.
- `workers/og-proposals/README.md`: per-link preview cards.
- `frontend/js/ui/share-dialog.js`: the Share box, which would emit the short form.
