// ─────────────────────────────────────────────────────────────────────────────
// TIMETABLE ENDPOINT
//   POST /api/timetable  — receives the daily ingest (from the GitHub Action).
//                          Requires header  x-ingest-key: <INGEST_KEY>.
//   GET  /api/timetable  — serves the current forward timetable to the app.
//
// Stored payload shape:
//   { generated: ISO, days: { "YYYY-MM-DD": [ {time,dest,stops}, ... ] } }
// ─────────────────────────────────────────────────────────────────────────────
import { getStore } from "@netlify/blobs";

const KEY = "forward";

export default async (req) => {
  const store = getStore("wye-timetable");

  if (req.method === "POST") {
    // .trim() guards against a stray trailing space/newline sneaking in when
    // the key is copy-pasted on a phone — a very common source of "identical
    // looking but not byte-identical" secrets.
    const provided = (req.headers.get("x-ingest-key") || "").trim();
    const expected = (process.env.INGEST_KEY || "").trim();

    if (!expected || provided !== expected) {
      // Safe diagnostics only: lengths, never the actual values. Enough to
      // tell "Netlify has no key at all" from "the two keys don't match".
      return json({
        error: "unauthorised",
        expectedSet: !!expected,
        expectedLen: expected.length,
        providedLen: provided.length,
      }, 401);
    }

    let body;
    try { body = JSON.parse(await req.text()); }
    catch { return json({ error: "bad json" }, 400); }

    const days = body && body.days;
    if (!days || typeof days !== "object" || Array.isArray(days))
      return json({ error: "missing days" }, 400);

    // Sanity gate: a real ingest has trains across multiple days. If it looks
    // empty/broken we reject it, so the last good copy is kept and the GitHub
    // Action registers a failure (which emails Benton).
    const dayCount = Object.keys(days).length;
    const trainCount = Object.values(days).reduce(
      (n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
    if (dayCount < 7 || trainCount < 20)
      return json({ error: "sanity check failed", dayCount, trainCount }, 422);

    await store.setJSON(KEY, {
      generated: new Date().toISOString(),
      days,
    });
    return json({ ok: true, dayCount, trainCount });
  }

  // GET — serve current timetable
  let rec;
  try { rec = await store.get(KEY, { type: "json" }); }
  catch { rec = null; }
  if (!rec) return json({ generated: null, days: {} });
  return json(rec);
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
