// ─────────────────────────────────────────────────────────────────────────────
// Street Manager open-data subscriber (Wye level crossing)
// Receives AWS SNS notifications from DfT Street Manager, verifies them,
// keeps only ROAD CLOSURES on the configured USRN(s), and stores the current
// set in Netlify Blobs. The companion `closures.mjs` serves them to the app.
// ─────────────────────────────────────────────────────────────────────────────
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// Only these Street Manager SNS topics are accepted.
const ALLOWED_TOPIC_ARNS = new Set([
  "arn:aws:sns:eu-west-2:287813576808:prod-permit-topic",
  "arn:aws:sns:eu-west-2:287813576808:prod-activity-topic",
  "arn:aws:sns:eu-west-2:287813576808:prod-section-58-topic",
]);

// USRN(s) of the road(s) over the crossing. Set Netlify env var WYE_USRN
// (comma-separated if more than one). Find it via GeoPlace FindMyStreet.
const TARGET_USRNS = new Set(
  (process.env.WYE_USRN || "").split(",").map(s => s.trim()).filter(Boolean)
);

export default async (req) => {
  if (req.method !== "POST") return new Response("OK", { status: 200 });

  let body;
  try { body = JSON.parse(await req.text()); }
  catch { return new Response("bad json", { status: 400 }); }

  // Reject anything not from a known Street Manager topic
  if (body.TopicArn && !ALLOWED_TOPIC_ARNS.has(body.TopicArn))
    return new Response("unknown topic", { status: 403 });

  // Cryptographically verify the message really came from AWS SNS
  try {
    if (!(await verifySns(body)))
      return new Response("bad signature", { status: 403 });
  } catch {
    return new Response("verify failed", { status: 403 });
  }

  // Subscription handshake — confirm by calling the SubscribeURL
  if (body.Type === "SubscriptionConfirmation" && body.SubscribeURL) {
    await fetch(body.SubscribeURL);
    return new Response("subscription confirmed", { status: 200 });
  }

  if (body.Type === "Notification") {
    let msg;
    try { msg = JSON.parse(body.Message); }
    catch { return new Response("ok", { status: 200 }); }
    await handleEvent(msg);
  }

  return new Response("ok", { status: 200 });
};

// ── event handling ───────────────────────────────────────────────────────────
async function handleEvent(msg) {
  const d = msg.object_data || {};
  const usrn = String(d.usrn || "");

  // Only our road
  if (TARGET_USRNS.size && !TARGET_USRNS.has(usrn)) return;

  const store = getStore("wye-closures");
  const ref =
    d.permit_reference_number || d.work_reference_number ||
    d.section_58_reference_number || msg.object_reference;
  if (!ref) return;

  const ev = (msg.event_type || "").toLowerCase().replace(/[-_]/g, "");

  // Events that clear a closure
  const ENDING = new Set([
    "workstop", "workstartreverted", "permitcancelled", "permitrevoked",
    "permitrefused", "activitycancelled", "section58cancelled", "section58closed",
  ]);
  if (ENDING.has(ev)) { await store.delete(ref).catch(() => {}); return; }

  // For all other (active/update) events: keep only if it's a road closure
  const isRoadClosure =
    d.traffic_management_type_ref === "road_closure" ||
    d.traffic_management_type === "Road closure";
  if (!isRoadClosure) { await store.delete(ref).catch(() => {}); return; }

  const start = pickStart(d);
  const end = pickEnd(d);
  if (!start || !end) return;

  await store.setJSON(ref, {
    start, end, ref,
    reason: humanReason(d),
    source: "Street Manager",
  });
}

// ── date helpers ─────────────────────────────────────────────────────────────
// Street Manager gives proposed_start_date / _end_date (ISO date, UTC midnight)
// plus optional _start_time / _end_time (full ISO datetimes), and sometimes
// actual_start_date_time / actual_end_date_time once works begin/end.
function pickStart(d) {
  if (d.actual_start_date_time) return d.actual_start_date_time;
  return combine(d.proposed_start_date, d.proposed_start_time, "00:00:00.000Z");
}
function pickEnd(d) {
  if (d.actual_end_date_time) return d.actual_end_date_time;
  return combine(d.proposed_end_date, d.proposed_end_time, "23:59:00.000Z");
}
function combine(dateIso, timeIso, defaultTime) {
  if (!dateIso) return null;
  const day = dateIso.substring(0, 10);
  const time = timeIso ? timeIso.substring(11) : defaultTime;
  return `${day}T${time}`;
}
function humanReason(d) {
  if (d.activity_type) return d.activity_type;
  const cat = d.work_category ? `${d.work_category} works` : "Works";
  return `${cat} – road closure`;
}

// ── SNS signature verification ───────────────────────────────────────────────
const SIGNABLE = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};
const certCache = new Map();

async function getCert(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !/(^|\.)amazonaws\.com$/.test(u.hostname))
    throw new Error("bad cert host");
  if (certCache.has(url)) return certCache.get(url);
  const pem = await (await fetch(url)).text();
  certCache.set(url, pem);
  return pem;
}

async function verifySns(body) {
  const fields = SIGNABLE[body.Type];
  if (!fields || !body.Signature || !body.SigningCertURL) return false;
  let str = "";
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null) continue;
    str += `${f}\n${body[f]}\n`;
  }
  const pem = await getCert(body.SigningCertURL);
  const algo = body.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  const v = crypto.createVerify(algo);
  v.update(str, "utf8");
  return v.verify(pem, body.Signature, "base64");
}
