// Landing page: shows the next open appointment, using live data from the API.
// Like the booking page, it calls /app/api/*, so the API key stays on the server.

const fmtNext = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });

async function showNextOpen() {
  const note = document.getElementById("next-open");
  try {
    const res = await fetch("api/slots");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { slots } = await res.json();

    // Slots come sorted by start time, so the first open future slot is the next available one.
    const next = slots.find((s) => s.available && new Date(s.start).getTime() > Date.now());
    note.textContent = next
      ? `Next free appointment: ${fmtNext.format(new Date(next.start))} with ${next.provider}`
      : "Every appointment this week is taken. New times are added regularly.";
  } catch {
    note.textContent = "";
  }
}

// Hide any photo that hasn't been added yet, so the page never shows a broken image.
// In the hero, only the image hides: the indigo pattern behind it stays.
for (const img of document.querySelectorAll("figure img")) {
  const hide = () => {
    if (img.closest(".hero-art")) {
      img.hidden = true;
      img.closest(".hero-art").classList.add("no-photo");
    }
    else img.closest("figure").hidden = true;
  };
  if (img.complete && img.naturalWidth === 0) hide();
  else img.addEventListener("error", hide);
}

showNextOpen();
