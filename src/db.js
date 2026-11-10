// Database connection and schema.
// All state that must survive between requests (slots, bookings, idempotency keys) lives in Postgres.

const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Hosted Postgres (Neon, Render, Supabase) requires SSL; a local database usually doesn't.
const isLocal = /localhost|127\.0\.0\.1|host=\/tmp/.test(connectionString);
const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS slots (
    id        TEXT PRIMARY KEY,
    provider  TEXT NOT NULL,
    start_raw TEXT NOT NULL,          -- returned exactly as it was sent to /reset
    end_raw   TEXT NOT NULL,
    start_at  TIMESTAMPTZ NOT NULL,   -- parsed, used for sorting and the "already started" check
    end_at    TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    seq        BIGSERIAL UNIQUE,      -- insertion order; powers stable cursor pagination
    id         TEXT PRIMARY KEY,
    slot_id    TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,         -- stored trimmed and lower-cased
    status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Level 3: at most ONE confirmed booking per slot, enforced by the database itself.
  -- Even if many requests arrive at the same instant, Postgres lets only one insert win.
  CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
    ON bookings (slot_id) WHERE status = 'confirmed';

  CREATE INDEX IF NOT EXISTS bookings_by_email ON bookings (email, seq);

  -- Level 4: remembers the response for each Idempotency-Key so retries get the same answer.
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key          TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    status_code  INTEGER,
    response     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

async function migrate() {
  await pool.query(SCHEMA);
}

// Runs fn(client) inside one transaction; rolls back if anything throws.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, withTransaction };
