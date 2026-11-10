// Loads demo slots (next 5 weekdays, two doctors, 30-minute slots) so the web page has something to show.
// Usage:  BASE_URL=https://your-app.onrender.com API_KEY=your-key node scripts/seed.js
// WARNING: this calls POST /reset, which deletes all bookings.

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error("Set API_KEY (and BASE_URL for a deployed server).");
  process.exit(1);
}

const providers = ["Dr Ade Okafor", "Dr Bola Hassan"];
const times = ["08:00", "08:30", "09:00", "09:30", "11:00", "11:30", "14:00", "14:30"]; // UTC (09:00-15:30 in Lagos)
const slots = [];

const day = new Date();
day.setUTCHours(0, 0, 0, 0);
let weekdays = 0;
while (weekdays < 5) {
  day.setUTCDate(day.getUTCDate() + 1);
  if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
  weekdays++;
  const date = day.toISOString().slice(0, 10);
  for (const provider of providers) {
    for (const time of times) {
      const start = new Date(`${date}T${time}:00Z`);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
      slots.push({ id: `${date}-${provider.split(" ")[1].toLowerCase()}-${time.replace(":", "")}`, provider, start: iso(start), end: iso(end) });
    }
  }
}

fetch(`${BASE_URL}/reset`, {
  method: "POST",
  headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ slots }),
})
  .then(async (res) => console.log(res.status, await res.text()))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
