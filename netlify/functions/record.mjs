// ─────────────────────────────────────────────────────────────────────────────
// TIMETABLE RECORDER
// Darwin only shows ~2 hours ahead, so there is no way to ask it about next
// Tuesday. This runs on a schedule, records the SCHEDULED times of services
// passing Wye, and builds a per-weekday pattern in Netlify Blobs. After a
// couple of weeks the "Plan ahead" view has a real, observed timetable —
// no extra data feed or registration required, and it self-corrects when the
// timetable changes.
// ─────────────────────────────────────────────────────────────────────────────
import { getStore } from "@netlify/blobs";

export const config = { schedule: "*/15 * * * *" }; // every 15 minutes

const PROXIES = [
  "https://national-rail-api.davwheat.dev",
  "https://huxley2.azurewebsites.net",
];
const OFF_AFK = 7;   // mins: Ashford dep → passes Wye
const OFF_CBW = 13;  // mins: Canterbury West dep → passes Wye

// Keep a sighting for this long without being seen again before dropping it,
// so timetable changes work their way out rather than lingering forever.
const STALE_DAYS = 70;

async function fetchBoard(path) {
  let lastErr;
  for (const base of PROXIES) {
    try {
      const r = await fetch(base + path);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("all proxies failed");
}

const services = b => (b && b.trainServices) || [];
const isHHMM = s => /^\d{1,2}:\d{2}$/.test(s || "");

// Shift an "HH:MM" by n minutes, wrapping at midnight
function shift(hhmm, mins) {
  const [h, m] = hhmm.split(":").map(Number);
  let total = (h * 60 + m + mins) % 1440;
  if (total < 0) total += 1440;
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" +
         String(total % 60).padStart(2, "0");
}

export default async () => {
  const store = getStore("wye-schedule");
  const now = new Date();
  const dow = now.getDay();
  const todayKey = now.toISOString().slice(0, 10);

  let wye, afk, cbw;
  try {
    [wye, afk, cbw] = await Promise.all([
      fetchBoard("/all/WYE/10?timeWindow=120"),
      fetchBoard("/departures/AFK/to/CBW/10?timeWindow=120"),
      fetchBoard("/departures/CBW/to/AFK/10?timeWindow=120"),
    ]);
  } catch (e) {
    return new Response("fetch failed: " + e.message, { status: 200 });
  }

  // Collect SCHEDULED passing times (not estimated — we want the pattern,
  // not today's delays).
  const seen = new Map(); // "HH:MM|dest|stops" -> {time,dest,stops}
  const add = (time, dest, stops) => {
    if (!isHHMM(time)) return;
    const k = time + "|" + dest + "|" + (stops ? 1 : 0);
    if (!seen.has(k)) seen.set(k, { time, dest, stops });
  };

  for (const s of services(wye)) {
    if (s.isCancelled) continue;
    add(s.std || s.sta, s.destination?.[0]?.locationName || "—", true);
  }
  for (const s of services(afk)) {
    if (s.isCancelled) continue;
    add(shift(s.std || "", OFF_AFK), s.destination?.[0]?.locationName || "—", false);
  }
  for (const s of services(cbw)) {
    if (s.isCancelled) continue;
    add(shift(s.std || "", OFF_CBW), s.destination?.[0]?.locationName || "—", false);
  }

  if (!seen.size) return new Response("nothing seen", { status: 200 });

  // Merge into this weekday's pattern
  const blobKey = "pattern-" + dow;
  let rec;
  try {
    rec = await store.get(blobKey, { type: "json" });
  } catch { rec = null; }
  if (!rec || typeof rec !== "object") rec = { entries: {}, dates: [] };
  rec.entries = rec.entries || {};
  rec.dates = rec.dates || [];

  for (const [k, v] of seen) {
    const prev = rec.entries[k];
    // count distinct DAYS observed, not polls — a train seen by three polls
    // in one morning is still one sighting
    if (prev && prev.lastDate === todayKey) { prev.lastSeen = now.toISOString(); continue; }
    rec.entries[k] = {
      time: v.time, dest: v.dest, stops: v.stops,
      count: (prev?.count || 0) + 1,
      lastDate: todayKey,
      lastSeen: now.toISOString(),
    };
  }

  // Track how many distinct days of this weekday we've sampled
  if (!rec.dates.includes(todayKey)) {
    rec.dates.push(todayKey);
    rec.dates = rec.dates.slice(-20);
  }

  // Drop entries not seen for a long time (timetable changed)
  const cutoff = Date.now() - STALE_DAYS * 864e5;
  for (const k of Object.keys(rec.entries)) {
    const e = rec.entries[k];
    if (e.lastSeen && new Date(e.lastSeen).getTime() < cutoff) delete rec.entries[k];
  }

  rec.updated = now.toISOString();
  await store.setJSON(blobKey, rec);

  return new Response(JSON.stringify({
    dow, recorded: seen.size, total: Object.keys(rec.entries).length,
    daysSampled: rec.dates.length,
  }), { status: 200, headers: { "content-type": "application/json" } });
};
