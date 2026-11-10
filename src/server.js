// Entry point: wires up JSON parsing, the API key check, the API routes and the web page.

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { migrate } = require("./db");
const routes = require("./routes");

const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error("API_KEY is not set");

const app = express();
app.disable("x-powered-by");

// Express 4 doesn't catch errors thrown by async handlers, so wrap each one.
const wrap = (handler) => (req, res, next) => handler(req, res).catch(next);

// ---------- web page (not part of the API contract) ----------
// The page lives at /app. It calls /app/api/*, which runs the same handlers on the server,
// so the API key never has to be shipped to the browser. Only what the page needs is exposed:
// list slots, book one, and look up a booking. /reset and cancelling stay key-protected.
app.use("/app", express.static(path.join(__dirname, "..", "public")));
const pageApi = express.Router();
pageApi.use(express.json());
pageApi.get("/slots", wrap(routes.listSlots));
pageApi.post("/bookings", wrap(routes.createBooking));
pageApi.get("/bookings/:id", wrap(routes.getBooking));
app.use("/app/api", pageApi);
app.get("/", (req, res, next) => (req.get("X-API-Key") ? next() : res.redirect("/app/")));

// ---------- level 2: every API request needs the right X-API-Key ----------
function keysMatch(given, expected) {
  // Compare fixed-length hashes so the check takes the same time whatever was sent.
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

app.use((req, res, next) => {
  const given = req.get("X-API-Key");
  if (!given || !keysMatch(given, API_KEY)) {
    return res.status(401).json({ error: "missing or invalid API key" });
  }
  next();
});

// Parse any request body as JSON, whatever Content-Type the client sent.
app.use(express.json({ type: () => true, limit: "1mb" }));

// ---------- API routes (exactly as in the spec) ----------
app.post("/reset", wrap(routes.reset));
app.get("/slots", wrap(routes.listSlots));
app.post("/bookings", wrap(routes.createBooking));
app.get("/bookings", wrap(routes.listBookings));
app.get("/bookings/:id", wrap(routes.getBooking));
app.delete("/bookings/:id", wrap(routes.cancelBooking));

app.use((req, res) => res.status(404).json({ error: "not found" }));

// Every error is JSON in the {"error": "..."} shape.
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "request body must be valid JSON" });
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

const PORT = Number(process.env.PORT) || 3000;
migrate()
  .then(() => app.listen(PORT, () => console.log(`Clinic booking API listening on port ${PORT}`)))
  .catch((err) => {
    console.error("Could not set up the database:", err);
    process.exit(1);
  });
