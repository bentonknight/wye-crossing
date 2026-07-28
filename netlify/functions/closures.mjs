// Serves the current set of Wye road closures (written by sns.mjs) as the
// JSON array the front-end already consumes: [{start,end,reason,source}, ...]
import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("wye-closures");
  const now = Date.now();
  const out = [];

  try {
    const { blobs } = await store.list();
    for (const b of blobs) {
      const rec = await store.get(b.key, { type: "json" });
      if (!rec) continue;
      // Tidy up closures that ended well in the past
      if (new Date(rec.end).getTime() < now - 6 * 3600 * 1000) {
        await store.delete(b.key).catch(() => {});
        continue;
      }
      out.push({ start: rec.start, end: rec.end, reason: rec.reason, source: rec.source });
    }
  } catch {
    // On any storage error, return an empty list rather than failing the app
  }

  out.sort((a, b) => new Date(a.start) - new Date(b.start));

  return new Response(JSON.stringify(out), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=30",
      "access-control-allow-origin": "*",
    },
  });
};
