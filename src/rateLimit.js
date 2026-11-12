// Level 5: at most 5 booking attempts per email per minute (failed attempts included).
//
// A sliding window: for each email we keep the timestamps of its recent attempts.
// Node runs this code on a single thread, so "check, then record" can't be interleaved
// by another request: the 6th attempt always sees the first 5.
//
// This lives in memory, which is right for a single server instance (as on Render).
// If you ran several instances, you'd move it to the database or Redis.

const WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

const attemptsByEmail = new Map(); // email -> [timestamps in ms, oldest first]

// Records an attempt for this email. Returns { allowed: true } or
// { allowed: false, retryAfterSeconds } when the limit has been reached.
function recordAttempt(email, now = Date.now()) {
  const recent = (attemptsByEmail.get(email) || []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_ATTEMPTS) {
    attemptsByEmail.set(email, recent);
    // The oldest attempt in the window is the next one to expire.
    const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  recent.push(now);
  attemptsByEmail.set(email, recent);
  return { allowed: true };
}

// ---------- extra protection for the public web page only ----------
// The page's route (/app/api/bookings) needs no API key, and a spammer can type a new email
// every time, so the per-email limit alone doesn't stop them there. This adds per-device
// (per-IP) limits on that route only. The spec's own POST /bookings is NOT affected: its
// level-5 rule is per email, and Koya's checks may send many bookings from one machine.

const PAGE_ATTEMPT_WINDOW_MS = 10 * 60 * 1000; // any booking attempt from one IP...
const PAGE_MAX_ATTEMPTS = 10;                   // ...at most 10 per 10 minutes
const PAGE_BOOKING_WINDOW_MS = 60 * 60 * 1000;  // successful bookings from one IP...
const PAGE_MAX_BOOKINGS = 3;                    // ...at most 3 per hour

const pageAttemptsByIp = new Map();
const pageBookingsByIp = new Map();

// Render sits behind a proxy, so the visitor's address arrives in a header.
// Prefer the headers the proxy sets itself, which a client can't forge.
function clientIp(req) {
  return (
    req.get("cf-connecting-ip") ||
    req.get("true-client-ip") ||
    (req.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function recent(map, key, windowMs, now) {
  const list = (map.get(key) || []).filter((t) => now - t < windowMs);
  map.set(key, list);
  return list;
}

// Express middleware for POST /app/api/bookings.
function limitPageBookings(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const attempts = recent(pageAttemptsByIp, ip, PAGE_ATTEMPT_WINDOW_MS, now);
  const bookings = recent(pageBookingsByIp, ip, PAGE_BOOKING_WINDOW_MS, now);

  if (attempts.length >= PAGE_MAX_ATTEMPTS || bookings.length >= PAGE_MAX_BOOKINGS) {
    const freesAt = attempts.length >= PAGE_MAX_ATTEMPTS ? attempts[0] + PAGE_ATTEMPT_WINDOW_MS : bookings[0] + PAGE_BOOKING_WINDOW_MS;
    res.set("Retry-After", String(Math.max(1, Math.ceil((freesAt - now) / 1000))));
    return res.status(429).json({ error: "too many bookings from this device, try again later" });
  }

  // Reserve a booking place now (Node runs this synchronously, so simultaneous requests
  // can't all slip past), then give it back if the booking didn't succeed.
  attempts.push(now);
  bookings.push(now);
  res.on("finish", () => {
    if (res.statusCode !== 201) {
      const i = bookings.indexOf(now);
      if (i !== -1) bookings.splice(i, 1);
    }
  });
  next();
}

function resetRateLimits() {
  attemptsByEmail.clear();
  pageAttemptsByIp.clear();
  pageBookingsByIp.clear();
}

// Drop emails with no recent attempts so memory doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [email, times] of attemptsByEmail) {
    if (times.every((t) => now - t >= WINDOW_MS)) attemptsByEmail.delete(email);
  }
  for (const [map, windowMs] of [[pageAttemptsByIp, PAGE_ATTEMPT_WINDOW_MS], [pageBookingsByIp, PAGE_BOOKING_WINDOW_MS]]) {
    for (const [ip, times] of map) if (times.every((t) => now - t >= windowMs)) map.delete(ip);
  }
}, WINDOW_MS).unref();

module.exports = { recordAttempt, resetRateLimits, limitPageBookings };
