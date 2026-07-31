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
// a JsonScheduleV1 (a schedule), a TiplocV1 (a location name record), or
// metadata we ignore.
async function collectSchedules() {
  const res = await fetchFeed();
  const gunzip = zlib.createGunzip();
  const nodeStream = Readable.fromWeb(res.body);
  nodeStream.on("error", e => die("stream error: " + e.message));
  gunzip.on("error", e => die("gunzip error: " + e.message));
  const rl = readline.createInterface({ input: nodeStream.pipe(gunzip), crlfDelay: Infinity });

  const schedules = []; // only those passing Wye
  const tiplocs = new Map(); // code -> { name, crs }
  let seen = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    // Location reference records travel in the same file — collect them so we
    // can turn TIPLOCs into readable names without a second download.
    const tl = obj.TiplocV1;
    if (tl && tl.tiploc_code) {
      tiplocs.set(tl.tiploc_code, {
        name: tl.tps_description || tl.description || null,
        crs: tl.crs_code || null,
      });
      continue;
    }

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

    // Keep the tail of the route (last stops first). Resolved to a name after
    // the pass completes, since TIPLOC records may appear later in the file.
    const tail = locs.slice(-10).map(l => l.tiploc_code).filter(Boolean).reverse();

    schedules.push({
      uid: s.CIF_train_uid,
      from: s.schedule_start_date,
      to: s.schedule_end_date,
      days: s.schedule_days_runs,        // "1111100" style bitmap
      stp: s.CIF_stp_indicator,          // P / O / C / N
      cat: (seg && seg.CIF_train_category) || "",
      status: s.train_status || "",
      time, stops, tail,
    });
  }

  console.log(`scanned ${seen} schedules, ${schedules.length} pass Wye, ` +
              `${tiplocs.size} location names`);
  if (!schedules.length) die("no schedules pass Wye — check TIPLOC / feed format");

  // Resolve destinations now that every location record has been seen.
  for (const s of schedules) {
    s.dest = resolveDest(s.tail, tiplocs);
    delete s.tail;
  }
  return schedules;
}

// Prefer the last location that is a real passenger station (has a CRS code) —
// otherwise empty-stock moves report a depot or siding code as the destination.
function resolveDest(tail, tiplocs) {
  if (!Array.isArray(tail) || !tail.length) return "—";
  let firstNamed = null;
  for (const code of tail) {
    const rec = tiplocs.get(code);
    if (rec && rec.crs && rec.name) return titleCase(rec.name);
    if (!firstNamed && rec && rec.name) firstNamed = rec.name;
  }
  if (firstNamed) return titleCase(firstNamed);
  return TIPLOC_NAMES[tail[0]] || tail[0]; // last resort: the raw code
}

// Feed names are upper case ("LONDON ST PANCRAS INTL"); make them readable.
const KEEP_UPPER = new Set(["DLR", "CTRL", "HS1", "TMD"]);
const KEEP_LOWER = new Set(["and", "of", "on", "the", "in", "le", "upon", "under", "by"]);
const EXPAND = { intl: "International", jn: "Junction", jcn: "Junction" };
function capWord(w) {
  return w.replace(/([a-z])([a-z']*)/g, (m, a, b) => a.toUpperCase() + b);
}
function titleCase(str) {
  return String(str).toLowerCase().split(/\s+/).map((w, i) => {
    const up = w.toUpperCase();
    if (KEEP_UPPER.has(up)) return up;
    if (EXPAND[w]) return EXPAND[w];
    if (i > 0 && KEEP_LOWER.has(w)) return w;
    // hyphenated names keep their little words lower: stoke-on-trent
    if (w.includes("-"))
      return w.split("-").map((p, j) =>
        (j > 0 && KEEP_LOWER.has(p)) ? p : capWord(p)).join("-");
    return capWord(w);
  }).join(" ");
}

// Last-resort fallback only — names normally come from the feed's own
// TiplocV1 records (see resolveDest above).
const TIPLOC_NAMES = {
  ASHFKY: "Ashford International", ASHFDNS: "Ashford International",
  CNTBW: "Canterbury West", CANTBW: "Canterbury West",
  WYEE: "Wye", CHILHM: "Chilham", CHRTHM: "Chartham",
  STPANCI: "London St Pancras International", LNDNBDE: "London Bridge",
};

// ── movement classification ──────────────────────────────────────────────────
// Darwin only ever sees passenger services, so the app needs to know which
// movements it can expect live data for and which it can't.
const PASSENGER_CATS = new Set(["OL", "OO", "OW", "XC", "XD", "XI", "XR", "XX", "XZ"]);
function classify(s) {
  const cat = (s.cat || "").toUpperCase();
  const st = (s.status || "").toUpperCase();
  if (cat.startsWith("E")) return "ecs";            // EE/EL/ES — empty coaching stock
  if (st === "F" || st === "2" || st === "T" || st === "3") return "freight";
  if (cat.startsWith("J") || cat.startsWith("H")) return "freight";
  if (PASSENGER_CATS.has(cat)) return "passenger";
  if (st === "P" || st === "1") return "passenger";
  return "other";
}

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
      list.push({ time: s.time, dest: s.dest, stops: s.stops, kind: classify(s) });
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
