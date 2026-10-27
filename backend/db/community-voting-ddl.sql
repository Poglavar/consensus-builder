-- Private ballots and append-only history for the code hashes committed by an immutable agreement.
SET ROLE geo_user;
CREATE TABLE IF NOT EXISTS consensus.community_voting_ballot (
    agreement_cid text NOT NULL REFERENCES consensus.agreement(cid), code_hash text NOT NULL CHECK(code_hash ~ '^[a-f0-9]{64}$'),
    version integer NOT NULL DEFAULT 0, choice text CHECK(choice IN ('support','oppose','abstain')),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(agreement_cid,code_hash)
);
CREATE TABLE IF NOT EXISTS consensus.community_voting_event (
    agreement_cid text NOT NULL, code_hash text NOT NULL, version integer NOT NULL,
    choice text NOT NULL CHECK(choice IN ('support','oppose','abstain')), request_id uuid NOT NULL, occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(agreement_cid,code_hash,version), UNIQUE(agreement_cid,code_hash,request_id),
    FOREIGN KEY(agreement_cid,code_hash) REFERENCES consensus.community_voting_ballot(agreement_cid,code_hash)
);
CREATE TABLE IF NOT EXISTS consensus.community_voting_throttle (
    scope text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0, window_at timestamptz NOT NULL, blocked_until timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE consensus.community_voting_event IS 'Append-only ballots. A code holder can review every change, including after voting closes. No names, contacts or raw codes.';
