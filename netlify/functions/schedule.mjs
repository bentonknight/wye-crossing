// Serves the learned timetable pattern for a given weekday.
// GET /api/schedule?dow=1   (0 = Sunday … 6 = Saturday)
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const dow = Number(url.searchParams.get("dow"));
  if (!Number.isInteger(dow) || dow < 0 || dow > 6)
    return json({ error: "dow must be 0-6" }, 400);

  const store = getStore("wye-schedule");
  let rec;
  try {
    rec = await store.get("pattern-" + dow, { type: "json" });
  } catch {
    rec = null;
  }
  if (!rec) return json({ dow, entries: [], days: 0, updated: null });

  const entries = Object.values(rec.entries || {})
    .map(e => ({ time: e.time, dest: e.dest, stops: !!e.stops, count: e.count || 0 }))
    .sort((a, b) => a.time.localeCompare(b.time));

  return json({
    dow,
    entries,
    days: (rec.dates || []).length,
    updated: rec.updated || null,
  });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
