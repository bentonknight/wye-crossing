// ─────────────────────────────────────────────────────────────────────────────
// LIVE POLLER  (scheduled — runs for the whole village, not per visitor)
//
// Polls Darwin once centrally and caches the result, so load is flat no matter
// how many people are watching.
//
// DATA SOURCE
//   Preferred: Rail Data Marketplace LDBWS REST API using our own key
//     (env DARWIN_KEY). Set DARWIN_BASE too if your product path differs —
//     check My Subscriptions → LDBWS - Public → Specification for the exact URL.
//   Fallback: the Huxley2 community proxy, used only if DARWIN_KEY is absent.
//     Fine for one developer; NOT appropriate for a public village service,
//     since it runs on someone else's token.
//
// QUOTA
//   The free RDM tier is around 100k calls/month. Three boards every minute
//   would be ~130k — over. So: every 2 minutes during the day, twice an hour
//   overnight when nothing runs. That lands near ~55k/month with headroom.
//
// TIMEZONE
//   This runs on a UTC server but Darwin publishes UK local times. Times are
//   kept as "HH:MM" strings and the browser builds the Dates in UK local time.
//   Do not "improve" this by parsing dates here — that's how you get a BST bug.
// ─────────────────────────────────────────────────────────────────────────────
import { getStore } from "@netlify/blobs";

export const config = { schedule: "*/2 * * * *" }; // every 2 minutes

const DARWIN_KEY = process.env.DARWIN_KEY || "";
// Confirmed from the Specification tab. If your subscription shows a
// different path, override with a Netlify env var DARWIN_BASE.
const DARWIN_BASE = process.env.DARWIN_BASE ||
  "https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120";

const HUXLEY = [
  "https://national-rail-api.davwheat.dev",
  "https://huxley2.azurewebsites.net",
];

const OFF_AFK = 7;   // mins: Ashford dep → passes Wye
const OFF_CBW = 13;  // mins: Canterbury West dep → passes Wye

const isHHMM = s => /^\d{1,2}:\d{2}$/.test(s || "");

// Current hour/minute in UK local time, whatever the server is set to
function ukNow() {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = t => Number(p.find(x => x.type === t)?.value ?? 0);
  return { hour: get("hour"), minute: get("minute") };
}

function shift(hhmm, mins) {
  if (!isHHMM(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  let total = (h * 60 + m + mins) % 1440;
  if (total < 0) total += 1440;
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" +
         String(total % 60).padStart(2, "0");
}

// ── fetching ─────────────────────────────────────────────────────────────────
// Some subscriptions only expose the plain board, not the "WithDetails"
// variant (which adds calling points). Coach length is on the base Darwin
// schema either way, so it works regardless — calling points are the only
// thing lost on the fallback path.
async function fetchRDM(crs, filterCrs) {
  const qs = new URLSearchParams({ numRows: "10", timeWindow: "120" });
  if (filterCrs) { qs.set("filterCrs", filterCrs); qs.set("filterType", "to"); }
  const headers = { "x-apikey": DARWIN_KEY };

  const withDetails = DARWIN_BASE + "/GetDepBoardWithDetails/" + crs + "?" + qs;
  let r = await fetch(withDetails, { headers });
  if (r.status === 404) {
    const basic = DARWIN_BASE + "/GetDepartureBoard/" + crs + "?" + qs;
    r = await fetch(basic, { headers });
  }
  if (!r.ok) throw new Error("RDM " + crs + " HTTP " + r.status);
  return r.json();
}

async function fetchHuxley(path) {
  let lastErr;
  for (const base of HUXLEY) {
    try {
      const r = await fetch(base + path);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("all proxies failed");
}

async function getBoards() {
  if (DARWIN_KEY) {
    return {
      source: "rdm",
      boards: await Promise.all([
        fetchRDM("WYE"),
        fetchRDM("AFK", "CBW"),
        fetchRDM("CBW", "AFK"),
      ]),
    };
  }
  return {
    source: "huxley",
    boards: await Promise.all([
      fetchHuxley("/all/WYE/10?timeWindow=120"),
      fetchHuxley("/departures/AFK/to/CBW/10?timeWindow=120"),
      fetchHuxley("/departures/CBW/to/AFK/10?timeWindow=120"),
    ]),
  };
}

// ── shape helpers (tolerant of both sources) ─────────────────────────────────
const services = b => (b && (b.trainServices || b.services)) || [];
const key = s => s.serviceIdGuid || s.serviceID || s.serviceId || (s.std + "" + s.sta);
const locName = v => Array.isArray(v) ? (v[0]?.locationName || "—") : (v?.locationName || "—");

function coachCount(s) {
  const n = Number(s && (s.length ?? s.trainLength));
  return Number.isFinite(n) && n > 0 && n < 40 ? n : null;
}
function callingPoints(s) {
  const wrap = s && s.subsequentCallingPoints;
  const first = Array.isArray(wrap) ? wrap[0] : wrap;
  const list = first && (first.callingPoint || first);
  if (!Array.isArray(list)) return "";
  return list.map(c => c && c.locationName).filter(Boolean).join(", ");
}

// ── run ──────────────────────────────────────────────────────────────────────
export default async () => {
  const store = getStore("wye-live");
  const { hour, minute } = ukNow();

  // Overnight the line is dead — back off to twice an hour to protect quota.
  const quiet = hour >= 1 && hour < 5;
  if (quiet && minute !== 0 && minute !== 30)
    return new Response("quiet hours — skipped", { status: 200 });

  let boards, source;
  try {
    ({ boards, source } = await getBoards());
  } catch (e) {
    // Leave the previous snapshot in place rather than blanking it
    return new Response("fetch failed: " + e.message, { status: 200 });
  }
  const [wye, afk, cbw] = boards;

  const map = new Map();
  const cancelledAt = [];
  let scheduled = 0, cancelled = 0;
  const isCx = s => s.isCancelled || s.etd === "Cancelled" || s.eta === "Cancelled";

  // 1) Services calling at Wye — the board time IS the crossing time
  for (const s of services(wye)) {
    scheduled++;
    const sched = s.std || s.sta;
    if (isCx(s)) { cancelled++; if (isHHMM(sched)) cancelledAt.push(sched); continue; }
    const est = s.etd || s.eta;
    const t = isHHMM(est) ? est : sched;
    if (!isHHMM(t)) continue;
    map.set(key(s), {
      t, sched: isHHMM(sched) ? sched : t,
      live: isHHMM(est) || est === "On time",
      delayed: est === "Delayed",
      stops: true,
      dest: locName(s.destination), origin: locName(s.origin),
      cars: coachCount(s), operator: s.operator || "",
      platform: s.platform || "", calling: callingPoints(s),
    });
  }

  // 2) Through services, offset from the adjacent station's departure
  const addThrough = (list, offMin) => {
    for (const s of list) {
      scheduled++;
      const sched = s.std;
      if (isCx(s)) {
        cancelled++;
        const c = shift(sched, offMin);
        if (c) cancelledAt.push(c);
        continue;
      }
      const k = key(s);
      if (map.has(k)) continue; // the Wye board time is more accurate
      const est = s.etd;
      const base = isHHMM(est) ? est : sched;
      const t = shift(base, offMin);
      if (!t) continue;
      map.set(k, {
        t, sched: shift(sched, offMin) || t,
        live: isHHMM(est) || est === "On time",
        delayed: est === "Delayed",
        stops: false,
        dest: locName(s.destination), origin: locName(s.origin),
        cars: coachCount(s), operator: s.operator || "",
        platform: "", calling: callingPoints(s),
      });
    }
  };
  addThrough(services(afk), OFF_AFK);
  addThrough(services(cbw), OFF_CBW);

  const trains = [...map.values()].sort((a, b) => a.t.localeCompare(b.t));

  await store.setJSON("snapshot", {
    at: new Date().toISOString(),
    source, trains, cancelledAt,
    meta: { scheduled, cancelled, running: trains.length },
  });

  return new Response(JSON.stringify({ ok: true, source, trains: trains.length }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};
