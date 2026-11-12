# Clinic booking API

An API that lets patients book clinic appointment slots, plus a small web page that uses it. Built to the Koya Cohort 4 Task 1 contract ([spec](https://koyaacademy.com/assessment-api)).

- **Stack:** Node.js 22, Express, PostgreSQL (Neon), deployed on Render
- **Web pages:** `/app/` is a simple landing page for "Koya Clinic" (a fictional demo clinic) with the next open slot, live from the API, and optional photos from `public/images/`. It sends patients to `/app/book.html`, where they see open slots, book one, see the confirmation, and look up a booking
- **All five levels** implemented and covered by `scripts/check.js` (65 checks)

## Endpoints

Every request needs `X-API-Key`. Every error is `{"error": "<message>"}`.

| Method | Path | Level | Notes |
|---|---|---|---|
| POST | `/reset` | 1 | Deletes all bookings, replaces all slots |
| GET | `/slots` | 1 | Earliest `start` first, optional `?provider=` (exact match), `available` per slot |
| POST | `/bookings` | 1–5 | 201 / 400 / 404 / 409 / 422 / 429 |
| GET | `/bookings?email=&limit=&cursor=` | 4 | Oldest first, cursor pagination, case-insensitive email |
| GET | `/bookings/{id}` | 1 | 404 if unknown |
| DELETE | `/bookings/{id}` | 3 | Cancels and frees the slot; 409 if already cancelled |

## How each level works

**Level 1: list, book, look up** (`src/routes.js`)
Slots and bookings are stored in Postgres, so they survive restarts. `/reset` runs in one transaction, so a half-finished reset can never be seen. Slot `start`/`end` are returned exactly as they were sent.

**Level 2: API key and validation** (`src/server.js`, `attemptBooking` in `src/routes.js`)
One middleware checks `X-API-Key` before any API route runs; the comparison is constant-time. Bookings are checked in the order the spec gives: required fields and email format (400), slot exists (404), slot not started (400). Name and email are trimmed and the email is lower-cased before saving.

**Level 3: no double booking, cancelling** (`src/db.js`, `src/routes.js`)
The rule "one confirmed booking per slot" lives in the database as a **partial unique index**:
`CREATE UNIQUE INDEX ... ON bookings (slot_id) WHERE status = 'confirmed'`.
The insert uses `ON CONFLICT ... DO NOTHING`, so when 40 requests hit the same slot at once, Postgres lets exactly one win and the rest get 409. Checking first in code ("is the slot free?" then insert) would have a race, because two requests could both see "free". Cancelling is a single `UPDATE ... WHERE status = 'confirmed'`, which frees the slot and is safe under concurrency too. Because the index only covers confirmed bookings, a cancelled slot can be booked again.

**Level 4: idempotency and pagination** (`createBooking`, `listBookings`)
- Each `Idempotency-Key` is stored with a hash of the request body and the response it produced. A retry with the same body gets the saved status and booking back; a different body gets 422. Body hashing ignores JSON key order.
- Simultaneous retries are handled by claiming the key with `INSERT ... ON CONFLICT DO NOTHING` inside the booking transaction. A second request with the same key waits for the first to commit, then replays its answer, so it never makes a second booking.
- Pagination is cursor-based on a `seq` column (insertion order). The cursor is opaque (base64), and the query asks for `limit + 1` rows to know whether there's a next page. The last page returns `next_cursor: null`. `limit` must be a whole number from 1 to 50.

**Level 5: rate limiting** (`src/rateLimit.js`)
A sliding one-minute window per (normalised) email, holding at most 5 attempts. Failed attempts count. The 6th gets 429 with `Retry-After` in whole seconds, computed from when the oldest attempt in the window expires. Idempotent replays don't count, since they create nothing, and the check runs after the key is claimed, so simultaneous retries of one request count once. The limiter is in memory, which is atomic in Node's single thread and right for one instance; running several instances would need Redis or the database instead. `/reset` also clears the limiter.

The public web page's route (`/app/api/bookings`) needs no key, and a spammer could type a new email every time, so it has two extra **per-device (IP)** limits: at most 10 booking attempts per 10 minutes, and at most 3 successful bookings per hour. A place is reserved before the booking runs and given back if it fails, so a burst of simultaneous requests can't slip past. These limits deliberately apply only to the page route, not to the spec's `POST /bookings`, whose level-5 rule is per email.

**The web page** (`public/`)
The page calls `/app/api/*`, which runs the same handlers on the server. That way the API key is never sent to the browser. Only list slots, book, and look up a booking are exposed there; `/reset` and cancelling still need the key. Each booking attempt sends an `Idempotency-Key`, so a double-click or network retry can't double-book.

## Run locally

```bash
npm install
export DATABASE_URL="postgresql://user:pass@localhost:5432/clinic"
export API_KEY="choose-a-key"
npm start                      # http://localhost:3000/app/
API_KEY=choose-a-key node scripts/seed.js     # load demo slots
API_KEY=choose-a-key node scripts/check.js    # run all contract checks (resets data!)
```

The tables are created automatically on startup.

## Deploy (free: Neon + Render)

1. **Database:** create a project at [neon.tech](https://neon.tech) (region: Frankfurt) and copy the connection string.
2. **Web service:** on [render.com](https://render.com), choose New → Web Service, connect this repo, and set
   - Build command `npm install`, Start command `npm start`, Instance type **Free**
   - Environment variables `DATABASE_URL` (from Neon) and `API_KEY` (your key)
3. Open `https://<service>.onrender.com/app/`.

`render.yaml` describes the same setup if you prefer Render Blueprints.
