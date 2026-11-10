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

function resetRateLimits() {
  attemptsByEmail.clear();
}

// Drop emails with no recent attempts so memory doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [email, times] of attemptsByEmail) {
    if (times.every((t) => now - t >= WINDOW_MS)) attemptsByEmail.delete(email);
  }
}, WINDOW_MS).unref();

module.exports = { recordAttempt, resetRateLimits };
