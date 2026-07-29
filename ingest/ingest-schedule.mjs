// ─────────────────────────────────────────────────────────────────────────────
// WYE SCHEDULE INGEST   (runs on GitHub Actions, not Netlify)
//
// 1. Downloads the Network Rail all-operator daily JSON SCHEDULE snapshot.
// 2. Keeps only schedules whose route passes the Wye TIPLOC (WYEE).
// 3. Resolves STP overlays per day for the next N days (which schedule wins).
// 4. Extracts the true passing time at Wye, destination and whether it stops.
// 5. POSTs the forward timetable to /api/timetable on the Netlify site.
//
// Env required:
//   NR_USER, NR_PASS       Network Rail Open Data credentials
//   INGEST_URL             https://<site>/api/timetable
//   INGEST_KEY             shared secret (matches Netlify env INGEST_KEY)
//
// Exits non-zero on any failure or if the result looks empty, so a failed
// GitHub Action emails Benton.
// ─────────────────────────────────────────────────────────────────────────────
import zlib from "node:zlib";
import readline from "node:readline";
import { Readable } from "node:stream";

const WYE_TIPLOC = "WYEE";
const DAYS_AHEAD = 14;
const SE_TOC = "SE"; // Southeastern ATOC code (belt-and-braces filter)

// Full daily snapshot, all operators, JSON (per docs: CIF_ALL_FULL_DAILY / toc-full)
const FEED_URL =
  "https://publicdatafeeds.networkrail.co.uk/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full";

const die = (msg) => { console.error("INGEST FAILED:", msg); process.exit(1); };

const NR_USER = process.env.NR_USER;
const NR_PASS = process.env.NR_PASS;
const INGEST_URL = process.env.INGEST_URL;
const INGEST_KEY = process.env.INGEST_KEY;
if (!NR_USER || !NR_PASS) die("NR_USER / NR_PASS not set");
if (!INGEST_URL || !INGEST_KEY) die("INGEST_URL / INGEST_KEY not set");

// ── date helpers ─────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, "0");
const dayKey = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
// CIF runs_from/runs_to are "YYYY-MM-DD"; days_run is a 7-char bitmap Mon..Sun
function inRange(dateStr, from, to) {
  return (!from || dateStr >= from) && (!to || dateStr <= to);
}
function runsOn(daysRun, jsDay) {
  // jsDay: 0=Sun..6=Sat ; bitmap index: 0=Mon..6=Sun
  const idx = jsDay === 0 ? 6 : jsDay - 1;
  return daysRun && daysRun[idx] === "1";
}
// CIF times are "HHMM" or "HHMMH" (H = half minute); we want "HH:MM"
function cifTime(t) {
  if (!t || t.length < 4) return null;
  return t.slice(0, 2) + ":" + t.slice(2, 4);
}

// ── download + stream-parse ──────────────────────────────────────────────────
async function fetchFeed() {
  const auth = "Basic " + Buffer.from(`${NR_USER}:${NR_PASS}`).toString("base64");
  const res = await fetch(FEED_URL, { headers: { Authorization: auth }, redirect: "follow" });
  if (!res.ok) die(`feed HTTP ${res.status}`);
  return res;
}

// The JSON feed is newline-delimited JSON objects, gzipped. Each line is either
// a JsonScheduleV1 (a schedule) or metadata we ignore.
async function collectSchedules() {
  const res = await fetchFeed();
  const gunzip = zlib.createGunzip();
  const nodeStream = Readable.fromWeb(res.body);
  nodeStream.on("error", e => die("stream error: " + e.message));
  gunzip.on("error", e => die("gunzip error: " + e.message));
  const rl = readline.createInterface({ input: nodeStream.pipe(gunzip), crlfDelay: Infinity });

  const schedules = []; // only those passing Wye
  let seen = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const s = obj.JsonScheduleV1;
    if (!s) continue;
    seen++;

    // must have a route with Wye on it
    const seg = s.schedule_segment;
    const locs = seg && seg.schedule_location;
    if (!Array.isArray(locs)) continue;
    const wye = locs.find(l => l.tiploc_code === WYE_TIPLOC);
    if (!wye) continue;

    // passing time at Wye: pass (through) or departure/arrival (calls)
    const passStr = cifTime(wye.pass);
    const depStr = cifTime(wye.departure);
    const arrStr = cifTime(wye.arrival);
    const time = passStr || depStr || arrStr;
    if (!time) continue;
    const stops = !passStr && !!(depStr || arrStr);

    // destination = last scheduled location
    const last = locs[locs.length - 1];
    const dest = tiplocName(last && last.tiploc_code) || "—";

    schedules.push({
      uid: s.CIF_train_uid,
      from: s.schedule_start_date,
      to: s.schedule_end_date,
      days: s.schedule_days_runs,        // "1111100" style bitmap
      stp: s.CIF_stp_indicator,          // P / O / C / N
      toc: seg && seg.CIF_train_service_code ? s.atoc_code : s.atoc_code,
      time, stops, dest,
    });
  }

  console.log(`scanned ${seen} schedules, ${schedules.length} pass Wye`);
  if (!schedules.length) die("no schedules pass Wye — check TIPLOC / feed format");
  return schedules;
}

// Minimal TIPLOC → friendly name for the destinations we expect on this line.
// Anything unknown falls back to the raw code (still useful).
const TIPLOC_NAMES = {
  ASHFKY: "Ashford International", ASHFDK: "Ashford International",
  CANTBW: "Canterbury West", RAMSGTE: "Ramsgate", MARGATE: "Margate",
  DOVERP: "Dover Priory", STPXBOX: "London St Pancras", STPX: "London St Pancras",
  WYEE: "Wye", CHILHM: "Chilham", CHRTHM: "Chartham",
};
function tiplocName(code) { return code ? (TIPLOC_NAMES[code] || code) : null; }

// ── STP resolution per date ──────────────────────────────────────────────────
// For each date, group candidate schedules by UID and pick the winner:
//   lowest STP indicator wins (C < N < O < P alphabetically → cancel/overlay beats base).
// A winning "C" (cancellation) means the train does NOT run that day.
const STP_RANK = { C: 0, N: 1, O: 2, P: 3 };

function buildForward(schedules) {
  const days = {};
  const today = new Date(); today.setHours(0, 0, 0, 0);

  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today.getTime() + i * 864e5);
    const key = dayKey(d);
    const jsDay = d.getDay();

    // candidates valid on this date and running on this weekday
    const byUid = new Map();
    for (const s of schedules) {
      if (!inRange(key, s.from, s.to)) continue;
      if (!runsOn(s.days, jsDay)) continue;
      const cur = byUid.get(s.uid);
      if (!cur || STP_RANK[s.stp] < STP_RANK[cur.stp]) byUid.set(s.uid, s);
    }

    const list = [];
    for (const s of byUid.values()) {
      if (s.stp === "C") continue; // cancelled that day
      list.push({ time: s.time, dest: s.dest, stops: s.stops });
    }
    list.sort((a, b) => a.time.localeCompare(b.time));
    days[key] = list;
  }
  return days;
}

// ── post to the site ─────────────────────────────────────────────────────────
async function post(days) {
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-key": INGEST_KEY },
    body: JSON.stringify({ days }),
  });
  const text = await res.text();
  if (!res.ok) die(`ingest endpoint HTTP ${res.status}: ${text}`);
  console.log("posted:", text);
}

// ── run ──────────────────────────────────────────────────────────────────────
(async () => {
  const schedules = await collectSchedules();
  const days = buildForward(schedules);
  const total = Object.values(days).reduce((n, a) => n + a.length, 0);
  console.log(`forward timetable: ${Object.keys(days).length} days, ${total} train-slots`);
  if (total < 20) die(`suspiciously few slots (${total}) — aborting so last good copy is kept`);
  await post(days);
  console.log("ingest complete");
})().catch(e => die(e.message));
