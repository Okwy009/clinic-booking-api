// The web page. It talks to /app/api/*, which runs the real API handlers on the server,
// so the API key stays on the server and is never sent to the browser.

const API = "api";
const $ = (id) => document.getElementById(id);

let allSlots = [];
let chosenSlot = null;
let idempotencyKey = null; // one key per booking attempt, reused if the same attempt is retried

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.retryAfter = res.headers.get("Retry-After");
    throw err;
  }
  return data;
}

const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fmtFull = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

const minutes = (s) => Math.round((new Date(s.end) - new Date(s.start)) / 60000);

// ---------- step 1: slots ----------

async function loadSlots() {
  $("slots-status").textContent = "Loading slots…";
  try {
    const { slots } = await api("/slots");
    allSlots = slots;
    fillProviderFilter();
    renderSlots();
  } catch (err) {
    $("slots-status").textContent = `Appointments couldn't be loaded (${err.message}). Refresh the page to try again.`;
  }
}

// The welcome page links here as book.html?doctor=<name> to open with that doctor selected.
const requestedDoctor = new URLSearchParams(location.search).get("doctor");
let usedRequestedDoctor = false;

function fillProviderFilter() {
  const select = $("provider-filter");
  let current = select.value;
  if (!usedRequestedDoctor && requestedDoctor) {
    current = requestedDoctor;
    usedRequestedDoctor = true;
  }
  const providers = [...new Set(allSlots.map((s) => s.provider))].sort();
  select.replaceChildren(el("option", { value: "" }, "All doctors"), ...providers.map((p) => el("option", { value: p }, p)));
  select.value = providers.includes(current) ? current : "";
}

function renderSlots() {
  const provider = $("provider-filter").value;
  const now = Date.now();
  const upcoming = allSlots.filter((s) => new Date(s.start).getTime() > now && (!provider || s.provider === provider));
  const open = upcoming.filter((s) => s.available).length;

  $("slots-status").textContent = upcoming.length
    ? `${open} of ${upcoming.length} times are free. Taken times are crossed out.`
    : "There are no upcoming appointments yet. New times are added regularly.";

  const byDay = new Map();
  for (const s of upcoming) {
    const day = fmtDay.format(new Date(s.start));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }

  const container = $("slots");
  container.replaceChildren();
  for (const [day, slots] of byDay) {
    container.append(el("h3", { class: "day" }, day));
    container.append(
      el(
        "div",
        { class: "grid" },
        ...slots.map((s) =>
          el(
            "button",
            {
              class: "slot",
              type: "button",
              disabled: !s.available,
              "aria-label": `${fmtTime.format(new Date(s.start))} with ${s.provider}, ${s.available ? "free" : "taken"}`,
              onclick: () => chooseSlot(s),
            },
            el("span", { class: "time" }, fmtTime.format(new Date(s.start))),
            el("span", { class: "who" }, s.provider),
            el("span", { class: "tag" }, s.available ? `${minutes(s)} minutes` : "Taken")
          )
        )
      )
    );
  }
}

// ---------- step 2: details ----------

function chooseSlot(slot) {
  chosenSlot = slot;
  idempotencyKey = crypto.randomUUID();
  $("chosen-slot").textContent = `${fmtFull.format(new Date(slot.start))} with ${slot.provider}`;
  $("form-error").hidden = true;
  show("form");
  $("name").focus();
}

async function submitBooking(event) {
  event.preventDefault();
  const button = $("submit-btn");
  const errorBox = $("form-error");
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = "Booking…";

  try {
    const booking = await api("/bookings", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ slot_id: chosenSlot.id, name: $("name").value, email: $("email").value }),
    });
    showConfirmation(booking);
  } catch (err) {
    let message = err.message;
    if (err.status === 409) message = "Someone else has just booked this time. Choose another time.";
    if (err.status === 429) message = `Too many booking attempts with this email. Try again in ${err.retryAfter || "a few"} seconds.`;
    if (err.status === 400 && /^email/.test(err.message)) message = "Enter a valid email address, like name@example.com.";
    else if (err.status === 400 && /^name/.test(err.message)) message = "Enter your full name.";
    errorBox.textContent = message;
    errorBox.hidden = false;
    // A different request (edited details, or after an error) needs a fresh key.
    idempotencyKey = crypto.randomUUID();
    if (err.status === 409) loadSlots();
  } finally {
    button.disabled = false;
    button.textContent = "Confirm booking";
  }
}

// ---------- step 3: confirmation ----------

function bookingDetails(booking) {
  const slot = allSlots.find((s) => s.id === booking.slot_id);
  const status = booking.status === "confirmed" ? "Confirmed" : "Cancelled";
  const rows = [
    ["Status", el("span", { class: `badge ${booking.status}` }, status)],
    ["When", slot ? fmtFull.format(new Date(slot.start)) : booking.slot_id],
    ["Doctor", slot ? slot.provider : "Not listed"],
    ["Name", booking.name],
    ["Email", booking.email],
  ];
  // The booking ID comes first and largest: it's what the patient needs to keep.
  const box = document.createDocumentFragment();
  box.append(
    el("p", { class: "ref-label" }, "Your booking ID"),
    el("p", { class: "ref" }, booking.id),
    el("dl", {}, ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]))
  );
  return box;
}

function showConfirmation(booking) {
  $("ticket").replaceChildren(bookingDetails(booking));
  $("booking-form").reset();
  show("confirm");
  loadSlots();
}

// ---------- look up a booking ----------

async function lookUp(event) {
  event.preventDefault();
  const out = $("lookup-result");
  const id = $("lookup-id").value.trim();
  out.textContent = "Looking up…";
  try {
    if (!allSlots.length) await loadSlots();
    const booking = await api(`/bookings/${encodeURIComponent(id)}`);
    out.replaceChildren(el("div", { class: "ticket" }, bookingDetails(booking)));
  } catch (err) {
    out.replaceChildren(el("p", { class: "error" }, err.status === 404 ? "There's no booking with that ID. Check it against your confirmation." : err.message));
  }
}

// ---------- wiring ----------

function show(step) {
  $("slots-section").hidden = step !== "slots";
  $("form-section").hidden = step !== "form";
  $("confirm-section").hidden = step !== "confirm";
}

$("provider-filter").addEventListener("change", renderSlots);
$("booking-form").addEventListener("submit", submitBooking);
$("change-slot").addEventListener("click", () => show("slots"));
$("book-another").addEventListener("click", () => show("slots"));
$("lookup-form").addEventListener("submit", lookUp);

loadSlots();
