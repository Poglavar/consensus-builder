-- Points LMSR ledger. This is a separate play-money accounting system, never a chain balance.
CREATE TABLE IF NOT EXISTS consensus.points_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash char(64) NOT NULL UNIQUE,
  agent_id varchar(120) NOT NULL, simulation_run varchar(40) NOT NULL DEFAULT '',
  alias varchar(40) NOT NULL, wallet varchar(64), balance numeric(20,0) NOT NULL DEFAULT 1000000000
    CHECK(balance >= 0 AND balance <= 18446744073709551615),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(wallet, simulation_run)
);
CREATE TABLE IF NOT EXISTS consensus.points_market (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agreement_account varchar(64) NOT NULL,
  simulation_run varchar(40) NOT NULL DEFAULT '', agreement_cid varchar(120) NOT NULL,
  city varchar(80) NOT NULL, closes_at bigint NOT NULL, grace_seconds integer NOT NULL DEFAULT 0 CHECK(grace_seconds = 0),
  b numeric(20,0) NOT NULL CHECK(b > 0 AND b <= 10000000000000000),
  seed numeric(20,0) NOT NULL CHECK(seed > 0 AND seed <= 18446744073709551615),
  q_yes numeric(20,0) NOT NULL DEFAULT 0 CHECK(q_yes >= 0 AND q_yes <= 18446744073709551615),
  q_no numeric(20,0) NOT NULL DEFAULT 0 CHECK(q_no >= 0 AND q_no <= 18446744073709551615),
  vault numeric(20,0) NOT NULL DEFAULT 69314720 CHECK(vault >= 0 AND vault <= 18446744073709551615),
  resolved boolean NOT NULL DEFAULT false, outcome varchar(8) CHECK(outcome IN ('yes','no','void')),
  paid_out numeric(20,0) NOT NULL DEFAULT 0 CHECK(paid_out >= 0 AND paid_out <= 18446744073709551615),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agreement_account, simulation_run)
);
CREATE TABLE IF NOT EXISTS consensus.points_position (
  account_id uuid NOT NULL REFERENCES consensus.points_account(id), market_id uuid NOT NULL REFERENCES consensus.points_market(id),
  yes_shares numeric(20,0) NOT NULL DEFAULT 0 CHECK(yes_shares >= 0 AND yes_shares <= 18446744073709551615),
  no_shares numeric(20,0) NOT NULL DEFAULT 0 CHECK(no_shares >= 0 AND no_shares <= 18446744073709551615),
  yes_claimed boolean NOT NULL DEFAULT false, no_claimed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id, market_id)
);
CREATE TABLE IF NOT EXISTS consensus.points_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES consensus.points_account(id),
  market_id uuid NOT NULL REFERENCES consensus.points_market(id), request_id uuid NOT NULL,
  kind varchar(12) NOT NULL CHECK(kind IN ('buy','sell','resolve','claim')),
  side varchar(8) CHECK(side IN ('yes','no','void')), shares numeric(20,0) NOT NULL DEFAULT 0 CHECK(shares >= 0),
  amount numeric(20,0) NOT NULL DEFAULT 0, request jsonb NOT NULL, receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, request_id)
);
CREATE TABLE IF NOT EXISTS consensus.points_wallet_challenge (
 account_id uuid NOT NULL REFERENCES consensus.points_account(id), wallet varchar(64) NOT NULL,
 nonce varchar(64) NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id, nonce)
);
CREATE INDEX IF NOT EXISTS points_account_leaderboard ON consensus.points_account(simulation_run, balance DESC);
