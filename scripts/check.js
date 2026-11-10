// Contract checks for every level of the spec.
// Usage:  BASE_URL=https://your-app.onrender.com API_KEY=your-key node scripts/check.js
// WARNING: this calls POST /reset, which deletes all bookings. Don't run it after you've submitted.

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error("Set API_KEY (and BASE_URL for a deployed server).");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const run = Math.random().toString(36).slice(2, 8); // unique emails per run
const email = (tag) => `${tag}.${run}@example.com`;

async function call(method, path, { body, key = API_KEY, headers = {}, raw } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { ...(key ? { "X-API-Key": key } : {}), "Content-Type": "application/json", ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}

function check(name, condition, detail = "") {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `  -> ${detail}` : ""}`); }
}

const isError = (r) => r.json && typeof r.json.error === "string";
const future = (h) => new Date(Date.now() + h * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z");
const past = (h) => new Date(Date.now() - h * 3600e3).toISOString().replace(/\.\d{3}Z$/, "Z");

async function resetWith(slots) {
  return call("POST", "/reset", { body: { slots } });
}

function makeSlots(n, provider = "Dr Ade", startHour = 24) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${provider.replace(/\W/g, "").toLowerCase()}-${i + 1}`,
    provider,
    start: future(startHour + i),
    end: future(startHour + i + 0.5),
  }));
}

async function level1() {
  console.log("\nLevel 1 · list, book, look up");
  const slots = [
    { id: "s2", provider: "Dr Bello", start: future(48), end: future(48.5) },
    { id: "s1", provider: "Dr Ade", start: future(24), end: future(24.5) },
    { id: "old", provider: "Dr Ade", start: past(24), end: past(23.5) },
  ];
  const r = await resetWith(slots);
  check("POST /reset returns 200", r.status === 200, r.status);

  const list = await call("GET", "/slots");
  check("GET /slots returns 200 with a slots array", list.status === 200 && Array.isArray(list.json?.slots));
  check("includes past slots", list.json.slots.length === 3);
  check("earliest start first", list.json.slots.map((s) => s.id).join() === "old,s1,s2", list.json.slots.map((s) => s.id).join());
  const s1 = list.json.slots.find((s) => s.id === "s1");
  check("slot fields are id, provider, start, end, available", s1 && s1.provider === "Dr Ade" && s1.start === slots[1].start && s1.end === slots[1].end && s1.available === true, JSON.stringify(s1));

  const filtered = await call("GET", "/slots?provider=" + encodeURIComponent("Dr Bello"));
  check("?provider= filters by exact match", filtered.json.slots.length === 1 && filtered.json.slots[0].id === "s2");
  const partial = await call("GET", "/slots?provider=Dr");
  check("?provider= is not a partial match", partial.json.slots.length === 0);

  const b = await call("POST", "/bookings", { body: { slot_id: "s1", name: "Ada Obi", email: email("ada") } });
  check("POST /bookings returns 201", b.status === 201, `${b.status} ${JSON.stringify(b.json)}`);
  check("booking has id, slot_id, name, email, status, created_at", b.json && b.json.id && b.json.slot_id === "s1" && b.json.name === "Ada Obi" && b.json.email === email("ada") && !Number.isNaN(Date.parse(b.json.created_at)));
  check("status is confirmed", b.json?.status === "confirmed");

  const got = await call("GET", `/bookings/${b.json.id}`);
  check("GET /bookings/{id} returns the booking", got.status === 200 && got.json.id === b.json.id && got.json.status === "confirmed");
  const missing = await call("GET", "/bookings/does-not-exist");
  check("GET /bookings/{id} unknown id -> 404 {error}", missing.status === 404 && isError(missing));

  const after = await call("GET", "/slots");
  check("booked slot shows available: false", after.json.slots.find((s) => s.id === "s1").available === false);
}

async function level2() {
  console.log("\nLevel 2 · API key and validation");
  await resetWith([
    { id: "s1", provider: "Dr Ade", start: future(24), end: future(24.5) },
    { id: "old", provider: "Dr Ade", start: past(1), end: future(1) },
  ]);

  for (const [path, method] of [["/slots", "GET"], ["/reset", "POST"], ["/bookings", "POST"], ["/bookings?email=a@b.co", "GET"], ["/bookings/x", "GET"], ["/bookings/x", "DELETE"]]) {
    const body = method === "POST" ? {} : undefined;
    const noKey = await call(method, path, { key: null, body });
    const badKey = await call(method, path, { key: "wrong", body });
    check(`${method} ${path}: missing key -> 401, wrong key -> 401`, noKey.status === 401 && badKey.status === 401 && isError(noKey) && isError(badKey), `${noKey.status}/${badKey.status}`);
  }

  const good = { slot_id: "s1", name: "Ada", email: email("v") };
  const cases = [
    ["missing slot_id", { name: "Ada", email: email("v1") }],
    ["missing name", { slot_id: "s1", email: email("v2") }],
    ["missing email", { slot_id: "s1", name: "Ada" }],
    ["empty slot_id", { ...good, slot_id: "", email: email("v3") }],
    ["blank name", { ...good, name: "   ", email: email("v4") }],
    ["empty email", { ...good, email: "" }],
    ["invalid email", { ...good, email: "not-an-email" }],
    ["email with no domain dot", { ...good, email: "ada@example" }],
    ["non-string name", { ...good, name: 42, email: email("v5") }],
  ];
  for (const [name, body] of cases) {
    const r = await call("POST", "/bookings", { body });
    check(`${name} -> 400 {error}`, r.status === 400 && isError(r), `${r.status} ${JSON.stringify(r.json)}`);
  }

  const bad = await call("POST", "/bookings", { raw: "{not json" });
  check("malformed JSON -> 400 {error}", bad.status === 400 && isError(bad));

  const nf = await call("POST", "/bookings", { body: { slot_id: "nope", name: "Ada", email: email("v6") } });
  check("unknown slot -> 404 {error}", nf.status === 404 && isError(nf));

  const started = await call("POST", "/bookings", { body: { slot_id: "old", name: "Ada", email: email("v7") } });
  check("slot already started -> 400 {error}", started.status === 400 && isError(started), started.status);

  const trimmed = await call("POST", "/bookings", { body: { slot_id: "s1", name: "  Ada Obi  ", email: `  ADA.Mixed.${run}@Example.COM ` } });
  check("name and email trimmed, email lower-cased", trimmed.status === 201 && trimmed.json.name === "Ada Obi" && trimmed.json.email === `ada.mixed.${run}@example.com`, JSON.stringify(trimmed.json));
}

async function level3() {
  console.log("\nLevel 3 · no double booking, cancelling");
  await resetWith([{ id: "hot", provider: "Dr Ade", start: future(24), end: future(24.5) }]);

  const N = 40;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => call("POST", "/bookings", { body: { slot_id: "hot", name: `P${i}`, email: email(`race${i}`) } }))
  );
  const wins = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409 && isError(r));
  check(`${N} simultaneous bookings: exactly one 201`, wins.length === 1, `${wins.length} wins`);
  check(`the other ${N - 1} get 409 {error}`, conflicts.length === N - 1, results.map((r) => r.status).join(","));

  const winner = wins[0].json;
  const cancel = await call("DELETE", `/bookings/${winner.id}`);
  check("DELETE returns 200 with status cancelled", cancel.status === 200 && cancel.json.status === "cancelled" && cancel.json.id === winner.id);
  const again = await call("DELETE", `/bookings/${winner.id}`);
  check("cancelling twice -> 409 {error}", again.status === 409 && isError(again));
  const unknown = await call("DELETE", "/bookings/does-not-exist");
  check("cancelling unknown id -> 404 {error}", unknown.status === 404 && isError(unknown));
  const lookup = await call("GET", `/bookings/${winner.id}`);
  check("cancelled booking still readable as cancelled", lookup.json.status === "cancelled");
  const slots = await call("GET", "/slots");
  check("slot is available again", slots.json.slots[0].available === true);
  const rebook = await call("POST", "/bookings", { body: { slot_id: "hot", name: "Next", email: email("next") } });
  check("slot can be booked again after cancelling", rebook.status === 201);

  const cancels = await Promise.all(Array.from({ length: 10 }, () => call("DELETE", `/bookings/${rebook.json.id}`)));
  check("10 simultaneous cancels: one 200, nine 409", cancels.filter((r) => r.status === 200).length === 1 && cancels.filter((r) => r.status === 409).length === 9);
}

async function level4() {
  console.log("\nLevel 4 · idempotency and pagination");
  await resetWith(makeSlots(12));

  const body = { slot_id: "drade-1", name: "Ada", email: email("idem") };
  const key = `key-${run}-1`;
  const first = await call("POST", "/bookings", { body, headers: { "Idempotency-Key": key } });
  const retry = await call("POST", "/bookings", { body, headers: { "Idempotency-Key": key } });
  check("same key + same body -> same status and booking id", first.status === 201 && retry.status === 201 && first.json.id === retry.json.id, `${first.status}/${retry.status}`);
  const reordered = await call("POST", "/bookings", { body: { email: body.email, name: body.name, slot_id: body.slot_id }, headers: { "Idempotency-Key": key } });
  check("same body with keys in another order still counts as the same", reordered.status === 201 && reordered.json.id === first.json.id);
  const different = await call("POST", "/bookings", { body: { ...body, slot_id: "drade-2" }, headers: { "Idempotency-Key": key } });
  check("same key + different body -> 422 {error}", different.status === 422 && isError(different), different.status);
  const mine = await call("GET", `/bookings?email=${encodeURIComponent(body.email)}`);
  check("only one booking was created", mine.json.bookings.length === 1);

  const key2 = `key-${run}-2`;
  const body2 = { slot_id: "drade-3", name: "Bola", email: email("idem2") };
  const burst = await Promise.all(Array.from({ length: 10 }, () => call("POST", "/bookings", { body: body2, headers: { "Idempotency-Key": key2 } })));
  const ids = new Set(burst.map((r) => r.json?.id));
  check("10 simultaneous retries: all 201 with one booking id", burst.every((r) => r.status === 201) && ids.size === 1, burst.map((r) => r.status).join(","));
  const mine2 = await call("GET", `/bookings?email=${encodeURIComponent(body2.email)}`);
  check("and only one booking exists", mine2.json.bookings.length === 1);

  const failKey = `key-${run}-3`;
  const conflictBody = { slot_id: "drade-1", name: "Late", email: email("late") };
  const c1 = await call("POST", "/bookings", { body: conflictBody, headers: { "Idempotency-Key": failKey } });
  const c2 = await call("POST", "/bookings", { body: conflictBody, headers: { "Idempotency-Key": failKey } });
  check("a retried 409 gets the same 409", c1.status === 409 && c2.status === 409);

  // Pagination: 5 bookings for one person (5 stays under the level-5 limit of 5 per minute).
  const who = email("pager");
  const created = [];
  for (let i = 4; i <= 8; i++) {
    const r = await call("POST", "/bookings", { body: { slot_id: `drade-${i}`, name: "Pat", email: i % 2 ? who.toUpperCase() : who } });
    created.push(r.json.id);
  }
  await call("POST", "/bookings", { body: { slot_id: "drade-9", name: "Someone else", email: email("other") } });

  const seen = [];
  let cursor = null;
  let pages = 0;
  let sizes = [];
  do {
    const r = await call("GET", `/bookings?email=${encodeURIComponent(who.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (r.status !== 200) { check("page request ok", false, r.status); break; }
    sizes.push(r.json.bookings.length);
    seen.push(...r.json.bookings.map((b) => b.id));
    cursor = r.json.next_cursor;
    pages++;
  } while (cursor && pages < 10);
  check("limit=2 over 5 bookings -> pages of 2, 2, 1", sizes.join() === "2,2,1", sizes.join());
  check("every booking exactly once, oldest first", seen.join() === created.join());
  check("last page has next_cursor: null", cursor === null);
  check("email match ignores case and excludes other people", seen.length === 5);

  const def = await call("GET", `/bookings?email=${encodeURIComponent(who)}`);
  check("default limit returns all 5 with next_cursor null", def.json.bookings.length === 5 && def.json.next_cursor === null);
  for (const bad of ["0", "51", "abc", "-1", "2.5"]) {
    const r = await call("GET", `/bookings?email=${encodeURIComponent(who)}&limit=${bad}`);
    check(`limit=${bad} -> 400 {error}`, r.status === 400 && isError(r));
  }
  for (const ok of ["1", "50"]) {
    const r = await call("GET", `/bookings?email=${encodeURIComponent(who)}&limit=${ok}`);
    check(`limit=${ok} accepted`, r.status === 200);
  }
}

async function level5() {
  console.log("\nLevel 5 · rate limiting");
  await resetWith(makeSlots(3));
  const spammer = email("spam");

  const attempts = [];
  attempts.push(await call("POST", "/bookings", { body: { slot_id: "drade-1", name: "S", email: spammer } })); // 201
  attempts.push(await call("POST", "/bookings", { body: { slot_id: "drade-1", name: "S", email: spammer } })); // 409
  attempts.push(await call("POST", "/bookings", { body: { slot_id: "nope", name: "S", email: spammer } })); // 404
  attempts.push(await call("POST", "/bookings", { body: { slot_id: "", name: "S", email: spammer } })); // 400
  attempts.push(await call("POST", "/bookings", { body: { slot_id: "drade-2", name: "S", email: spammer.toUpperCase() } })); // 201
  check("first 5 attempts (including failures) are processed", attempts.map((a) => a.status).join() === "201,409,404,400,201", attempts.map((a) => a.status).join());

  const sixth = await call("POST", "/bookings", { body: { slot_id: "drade-3", name: "S", email: spammer } });
  const retryAfter = sixth.headers.get("retry-after");
  check("6th attempt -> 429 {error}", sixth.status === 429 && isError(sixth), sixth.status);
  check("with Retry-After in whole seconds (1-60)", /^\d+$/.test(retryAfter || "") && Number(retryAfter) >= 1 && Number(retryAfter) <= 60, retryAfter);

  const other = await call("POST", "/bookings", { body: { slot_id: "drade-3", name: "O", email: email("innocent") } });
  check("a different email isn't affected", other.status === 201, other.status);

  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => call("POST", "/bookings", { body: { slot_id: "nope", name: "B", email: email("burst") } })));
  check("12 simultaneous attempts: exactly 5 processed, 7 get 429", burst.filter((r) => r.status === 429).length === 7, burst.map((r) => r.status).join(","));
}

(async () => {
  console.log(`Checking ${BASE_URL}`);
  try {
    await level1();
    await level2();
    await level3();
    await level4();
    await level5();
  } catch (err) {
    failed++;
    console.error("\nCheck run crashed:", err);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
