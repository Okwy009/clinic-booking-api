// Request handlers for every endpoint in the spec.
// Each handler is a plain async (req, res) function so the web page's proxy can reuse them.

const crypto = require("crypto");
const { pool, withTransaction } = require("./db");
const { recordAttempt, resetRateLimits } = require("./rateLimit");

// ---------- helpers ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toSlot(row) {
  return {
    id: row.id,
    provider: row.provider,
    start: row.start_raw,
    end: row.end_raw,
    available: !row.booked,
  };
}

// Same JSON regardless of key order, so {"a":1,"b":2} and {"b":2,"a":1} count as the same body.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashBody(body) {
  return crypto.createHash("sha256").update(stableStringify(body)).digest("hex");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------- POST /reset (level 1) ----------

async function reset(req, res) {
  const body = req.body;
  if (!isPlainObject(body) || !Array.isArray(body.slots)) {
    return sendError(res, 400, "body must be an object with a slots array");
  }

  const slots = [];
  const seen = new Set();
  for (const s of body.slots) {
    if (!isPlainObject(s)) return sendError(res, 400, "each slot must be an object");
    const id = typeof s.id === "number" ? String(s.id) : s.id;
    const { provider, start, end } = s;
    if (typeof id !== "string" || id.trim() === "") return sendError(res, 400, "each slot needs an id");
    if (typeof provider !== "string" || provider.trim() === "") return sendError(res, 400, `slot ${id} needs a provider`);
    if (typeof start !== "string" || Number.isNaN(Date.parse(start))) return sendError(res, 400, `slot ${id} needs a valid start`);
    if (typeof end !== "string" || Number.isNaN(Date.parse(end))) return sendError(res, 400, `slot ${id} needs a valid end`);
    if (seen.has(id)) return sendError(res, 400, `duplicate slot id ${id}`);
    seen.add(id);
    slots.push({ id, provider, start, end });
  }

  await withTransaction(async (db) => {
    // Wipe everything, then load the new slots, all in one transaction.
    await db.query("TRUNCATE bookings, slots, idempotency_keys");
    if (slots.length > 0) {
      await db.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $3::timestamptz[], $4::timestamptz[])`,
        [slots.map((s) => s.id), slots.map((s) => s.provider), slots.map((s) => s.start), slots.map((s) => s.end)]
      );
    }
  });
  resetRateLimits();

  return res.status(200).json({ status: "ok", slots: slots.length });
}

// ---------- GET /slots (level 1) ----------

async function listSlots(req, res) {
  const params = [];
  let where = "";
  if (typeof req.query.provider === "string") {
    params.push(req.query.provider);
    where = "WHERE s.provider = $1"; // exact match, as the spec says
  }

  const { rows } = await pool.query(
    `SELECT s.*,
            EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS booked
       FROM slots s ${where}
      ORDER BY s.start_at, s.id`,
    params
  );
  return res.status(200).json({ slots: rows.map(toSlot) });
}

// ---------- POST /bookings (levels 1-5) ----------

// Validates the request and tries to book. Returns { status, body } instead of sending,
// so the same result can be stored for idempotent retries (level 4).
async function attemptBooking(db, body) {
  // Level 2: required fields and email format.
  const { slot_id, name, email } = body;
  if (typeof slot_id !== "string" || slot_id.trim() === "") return { status: 400, body: { error: "slot_id is required" } };
  if (typeof name !== "string" || name.trim() === "") return { status: 400, body: { error: "name is required" } };
  if (typeof email !== "string" || email.trim() === "") return { status: 400, body: { error: "email is required" } };

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  if (cleanName.length > 200) return { status: 400, body: { error: "name is too long" } };
  if (cleanEmail.length > 254 || !EMAIL_RE.test(cleanEmail)) return { status: 400, body: { error: "email is not valid" } };

  // Level 2: the slot must exist and must not have started yet.
  const slot = (await db.query("SELECT id, start_at FROM slots WHERE id = $1", [slot_id])).rows[0];
  if (!slot) return { status: 404, body: { error: "slot not found" } };
  if (new Date(slot.start_at).getTime() <= Date.now()) return { status: 400, body: { error: "slot has already started" } };

  // Level 3: the partial unique index allows only one confirmed booking per slot.
  // ON CONFLICT DO NOTHING means a losing request simply gets no row back,
  // instead of an error, even when requests arrive at the same moment.
  const inserted = await db.query(
    `INSERT INTO bookings (id, slot_id, name, email, status, created_at)
     VALUES ($1, $2, $3, $4, 'confirmed', clock_timestamp())
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), slot_id, cleanName, cleanEmail]
  );
  if (inserted.rowCount === 0) return { status: 409, body: { error: "slot is already booked" } };

  return { status: 201, body: toBooking(inserted.rows[0]) };
}

async function createBooking(req, res) {
  const body = req.body;
  if (!isPlainObject(body)) return sendError(res, 400, "body must be a JSON object");

  const idemKey = (req.get("Idempotency-Key") || "").trim();
  const requestHash = hashBody(body);

  // Level 4: a retry of a request we've already answered gets the stored answer back.
  // Replays don't count toward the rate limit, because they never create anything.
  if (idemKey) {
    const saved = (await pool.query("SELECT * FROM idempotency_keys WHERE key = $1", [idemKey])).rows[0];
    if (saved) {
      if (saved.request_hash !== requestHash) return sendError(res, 422, "Idempotency-Key was already used with a different body");
      return res.status(saved.status_code).json(saved.response);
    }
  }

  const result = await withTransaction(async (db) => {
    if (idemKey) {
      // Claim the key. If another request with the same key is mid-flight, Postgres makes
      // this insert wait until that one commits; then we get no row and replay its answer.
      const claimed = await db.query(
        "INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key",
        [idemKey, requestHash]
      );
      if (claimed.rowCount === 0) {
        const saved = (await db.query("SELECT * FROM idempotency_keys WHERE key = $1", [idemKey])).rows[0];
        if (saved.request_hash !== requestHash) {
          return { status: 422, body: { error: "Idempotency-Key was already used with a different body" } };
        }
        return { status: saved.status_code, body: saved.response };
      }
    }

    // Level 5: at most 5 attempts per email per minute, failed ones included.
    // Checked after claiming the key, so simultaneous retries of one request count once.
    if (typeof body.email === "string" && body.email.trim() !== "") {
      const limit = recordAttempt(body.email.trim().toLowerCase());
      if (!limit.allowed) {
        // Release the key: a 429 isn't a real answer, so a later retry should be processed.
        if (idemKey) await db.query("DELETE FROM idempotency_keys WHERE key = $1", [idemKey]);
        return { status: 429, retryAfter: limit.retryAfterSeconds, body: { error: "too many booking attempts for this email, try again later" } };
      }
    }

    const outcome = await attemptBooking(db, body);

    if (idemKey) {
      await db.query("UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1", [
        idemKey,
        outcome.status,
        JSON.stringify(outcome.body),
      ]);
    }
    return outcome;
  });

  if (result.retryAfter) res.set("Retry-After", String(result.retryAfter));
  return res.status(result.status).json(result.body);
}

// ---------- GET /bookings (level 4) ----------

function encodeCursor(seq) {
  return Buffer.from(`seq:${seq}`).toString("base64url");
}

function decodeCursor(cursor) {
  const match = /^seq:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return match ? match[1] : null;
}

async function listBookings(req, res) {
  const { email, limit: rawLimit, cursor } = req.query;

  if (typeof email !== "string" || email.trim() === "") return sendError(res, 400, "email is required");

  let limit = 10;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit)) return sendError(res, 400, "limit must be a whole number from 1 to 50");
    limit = Number(rawLimit);
    if (limit < 1 || limit > 50) return sendError(res, 400, "limit must be a whole number from 1 to 50");
  }

  let afterSeq = "0";
  if (cursor !== undefined && cursor !== "") {
    const decoded = typeof cursor === "string" ? decodeCursor(cursor) : null;
    if (!decoded) return sendError(res, 400, "cursor is not valid");
    afterSeq = decoded;
  }

  // Fetch one extra row: if it exists, there is another page.
  const { rows } = await pool.query(
    `SELECT * FROM bookings
      WHERE email = $1 AND seq > $2
      ORDER BY seq
      LIMIT $3`,
    [email.trim().toLowerCase(), afterSeq, limit + 1]
  );

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null;
  return res.status(200).json({ bookings: page.map(toBooking), next_cursor: nextCursor });
}

// ---------- GET /bookings/:id (level 1) ----------

async function getBooking(req, res) {
  const row = (await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id])).rows[0];
  if (!row) return sendError(res, 404, "booking not found");
  return res.status(200).json(toBooking(row));
}

// ---------- DELETE /bookings/:id (level 3) ----------

async function cancelBooking(req, res) {
  // Only a confirmed booking can be cancelled; doing it in one UPDATE keeps it safe under concurrency.
  const updated = await pool.query(
    "UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *",
    [req.params.id]
  );
  if (updated.rowCount === 1) return res.status(200).json(toBooking(updated.rows[0]));

  const exists = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [req.params.id]);
  if (exists.rowCount === 0) return sendError(res, 404, "booking not found");
  return sendError(res, 409, "booking is already cancelled");
}

module.exports = { reset, listSlots, createBooking, listBookings, getBooking, cancelBooking };
