-- Single maintained display aggregate: the all-time peak TPS (max 1s-resolution rate). Updated
-- commutatively (GREATEST) by the live-stats deriver, so any number of explorer-api replicas
-- converge to the true max and it survives restarts (unlike an in-process running max). Keyed so
-- the table can hold other scalar display metrics later.
CREATE TABLE IF NOT EXISTS metric_meta (
    key   TEXT PRIMARY KEY,
    value DOUBLE PRECISION NOT NULL
);
