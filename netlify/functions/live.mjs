// Serves the cached live snapshot written by poll.mjs.
//
// The CDN headers matter as much as the code: with s-maxage set, Netlify's edge
// serves the vast majority of requests without ever invoking this function, so
// hundreds of concurrent users cost close to nothing.
import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("wye-live");
  let snap = null;
  try {
    snap = await store.get("snapshot", { type: "json" });
  } catch {
    snap = null;
  }

  if (!snap) {
    return json({ at: null, trains: [], cancelledAt: [],
                  meta: { scheduled: 0, cancelled: 0, running: 0 }, stale: true });
  }

  // Tell the client how old this is so it can be honest if the poller stops.
  const ageSec = snap.at ? Math.round((Date.now() - new Date(snap.at).getTime()) / 1000) : null;
  // Poller runs every 2 min (twice an hour overnight), so allow generous
  // headroom before crying wolf.
  return json({ ...snap, ageSec, stale: ageSec == null || ageSec > 15 * 60 });
};

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Browser holds it briefly; the CDN holds it for the poll interval and
      // may serve slightly stale data while it revalidates in the background.
      "cache-control": "public, max-age=15",
      "netlify-cdn-cache-control": "public, s-maxage=30, stale-while-revalidate=60, durable",
      "access-control-allow-origin": "*",
    },
  });
}
