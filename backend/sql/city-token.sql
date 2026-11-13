-- City meme token ledger (docs/citymemetoken.md): off-chain awards for correct agreement bets.
-- A balance is the sum of a recipient's awards. Amounts are atomic (6 decimals).
CREATE TABLE IF NOT EXISTS consensus.city_token_market (
  book varchar(16) NOT NULL CHECK(book IN ('points','devnet-usdc')),
  market varchar(64) NOT NULL,              -- points_market.id, or the chain LMSR market address
  simulation_run varchar(40) NOT NULL DEFAULT '',
  agreement_account varchar(64) NOT NULL, city varchar(80) NOT NULL,
  outcome varchar(8) NOT NULL CHECK(outcome IN ('yes','no','void')),
  recipients integer NOT NULL, total_edge numeric(30,0) NOT NULL,
  fills integer NOT NULL,                   -- trades the edges were computed from
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(book, market)
);
CREATE TABLE IF NOT EXISTS consensus.city_token_award (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book varchar(16) NOT NULL, market varchar(64) NOT NULL,
  simulation_run varchar(40) NOT NULL DEFAULT '',
  recipient varchar(64) NOT NULL,           -- points: points_account.id; devnet-usdc: the wallet
  wallet varchar(64),                       -- the recipient's wallet when known (points: linked wallet)
  token varchar(80) NOT NULL,               -- a city slug or 'ugt'
  edge numeric(30,0) NOT NULL CHECK(edge > 0), amount numeric(30,0) NOT NULL CHECK(amount > 0),
  agreement_account varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(book, market, recipient, token),
  FOREIGN KEY(book, market) REFERENCES consensus.city_token_market(book, market)
);
CREATE INDEX IF NOT EXISTS city_token_award_recipient ON consensus.city_token_award(recipient, simulation_run);
CREATE INDEX IF NOT EXISTS city_token_award_wallet ON consensus.city_token_award(wallet) WHERE wallet IS NOT NULL;
CREATE INDEX IF NOT EXISTS city_token_award_token ON consensus.city_token_award(token, simulation_run);
-- City-token boosts of an agreement: spent from a points account's balance, held while the agreement
-- is active, paid out when it executes (30% sponsor, 70% parcel owners by the committed rights
-- snapshot) and refunded when it is cancelled or expires.
CREATE TABLE IF NOT EXISTS consensus.city_token_boost (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booster varchar(64) NOT NULL,             -- points_account.id that spent it
  request_id uuid NOT NULL,
  simulation_run varchar(40) NOT NULL DEFAULT '',
  agreement_account varchar(64) NOT NULL, agreement_cid varchar(120) NOT NULL, city varchar(80) NOT NULL,
  token varchar(80) NOT NULL, amount numeric(30,0) NOT NULL CHECK(amount > 0),
  status varchar(12) NOT NULL DEFAULT 'active' CHECK(status IN ('active','paid','refunded')),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(booster, request_id)
);
CREATE INDEX IF NOT EXISTS city_token_boost_agreement ON consensus.city_token_boost(agreement_account, status);
CREATE TABLE IF NOT EXISTS consensus.city_token_boost_payout (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boost_id uuid NOT NULL REFERENCES consensus.city_token_boost(id),
  simulation_run varchar(40) NOT NULL DEFAULT '',
  recipient varchar(120) NOT NULL,          -- the sponsor's wallet, or a rights holder's ownerId
  role varchar(8) NOT NULL CHECK(role IN ('sponsor','owner')),
  token varchar(80) NOT NULL, amount numeric(30,0) NOT NULL CHECK(amount > 0),
  agreement_account varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(boost_id, recipient)
);
CREATE INDEX IF NOT EXISTS city_token_boost_payout_recipient ON consensus.city_token_boost_payout(recipient, simulation_run);
