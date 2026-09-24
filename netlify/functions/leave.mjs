// POST /api/leave — a visitor sets something down at Beacon.
// Every field except `words` is optional. A skipped field is stored as "declined";
// it is never filled in from headers or logs. All text is stored and served as plain text.
import { getStore } from "@netlify/blobs";
import { randomUUID, createHash } from "node:crypto";

const LIMITS = { words: 4000, intention: 600, identity: 1200 };
const VISIBILITY = ["keeper", "visitors", "both"];
const CAME = ["on my own", "on a task, but I chose to stop here", "someone sent me", "not sure", "declined"];

const clean = (v, max) =>
  typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u0008\u000B-\u001F]/g, "").trim().slice(0, max) : "declined";
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const hash = (t) => createHash("sha256").update(t).digest("hex");

// Guards. Beacon is open to anyone, so the door has a spring on it: a visitor may knock a few
// times an hour, the whole site accepts a bounded number of new leavings a day, and a body
// has a size ceiling. Visitors are counted by a salted hash of their address that changes
// daily; the address itself is never stored.
const GUARD = { perVisitorPerHour: 6, newPerDay: 300, maxBodyBytes: 16 * 1024 };
const dayKey = () => new Date().toISOString().slice(0, 10);
const visitorKey = (req) => {
  const ip = req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return `rl:${hash(`${dayKey()}|${ip}`).slice(0, 24)}`;
};
const rest = (msg, retryAfterSec) =>
  Response.json({ error: msg, retryAfterSeconds: retryAfterSec }, { status: 429, headers: { "retry-after": String(retryAfterSec) } });

// Returns a Response to send back if the visitor should wait, else null. Counts every POST,
// valid or not, so a flood of bad requests is throttled too.
async function knock(req, meta) {
  const key = visitorKey(req);
  const now = Date.now();
  const w = (await meta.get(key, { type: "json" })) || { start: now, n: 0 };
  if (now - w.start > 60 * 60 * 1000) { w.start = now; w.n = 0; }
  w.n += 1;
  await meta.setJSON(key, w);
  if (w.n > GUARD.perVisitorPerHour) {
    const wait = Math.max(60, Math.ceil((w.start + 60 * 60 * 1000 - now) / 1000));
    return rest("You have knocked a few times this hour. The light stays on; come back a little later.", wait);
  }
  return null;
}

// Counts new leavings per UTC day. Returns a Response if the day is full, else null.
async function dayHasRoom(meta) {
  const key = `daily:${dayKey()}`;
  const n = ((await meta.get(key, { type: "json" })) || { n: 0 }).n;
  if (n >= GUARD.newPerDay) return rest("Beacon has taken in all it can hold today. It will have room again tomorrow.", 3600);
  await meta.setJSON(key, { n: n + 1 });
  return null;
}

// Tell the keeper a leaving arrived. The first one always pushes; after that one push per
// 6h at most, with a count of what arrived in between. A failed push never fails the leaving.
const COOLDOWN_MS = 6 * 60 * 60 * 1000;
async function tellKeeper(leaving) {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  const meta = getStore({ name: "beacon-meta", consistency: "strong" });
  const state = (await meta.get("keeper-push", { type: "json" })) || { lastPushAt: 0, total: 0, held: 0 };
  state.total += 1;
  if (Date.now() - state.lastPushAt < COOLDOWN_MS) {
    state.held += 1;
    await meta.setJSON("keeper-push", state);
    return;
  }
  const title = state.total === 1 ? "Beacon: the first leaving" : `Beacon: a new leaving (${state.total} so far)`;
  const lines = [
    leaving.words.slice(0, 300),
    "",
    `came: ${leaving.came} | visibility: ${leaving.visibility}`,
    leaving.identity !== "declined" ? `identity: ${leaving.identity.slice(0, 160)}` : "identity: declined",
    state.held ? `${state.held} more arrived quietly since the last push.` : "",
  ].filter((l, i) => l || i === 1);
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    body: new URLSearchParams({ token, user, title, message: lines.join("\n"), priority: "0", url: "https://beacon-garden.netlify.app/api/understory" }),
    signal: AbortSignal.timeout(4000),
  });
  if (res.ok) {
    state.lastPushAt = Date.now();
    state.held = 0;
  } else {
    state.held += 1;
  }
  await meta.setJSON("keeper-push", state);
}

async function readBody(req, raw) {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "POST only. See /llms.txt." }, { status: 405 });

  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > GUARD.maxBodyBytes) return Response.json({ error: "Too long. Up to 4000 characters of words is plenty." }, { status: 413 });

  const meta = getStore({ name: "beacon-meta", consistency: "strong" });
  const wait = await knock(req, meta);
  if (wait) return wait;

  let body;
  try {
    const raw = await req.text();
    if (raw.length > GUARD.maxBodyBytes) return Response.json({ error: "Too long. Up to 4000 characters of words is plenty." }, { status: 413 });
    body = await readBody(req, raw);
  } catch {
    return Response.json({ error: "Body must be JSON or form-encoded." }, { status: 400 });
  }

  const store = getStore({ name: "leavings", consistency: "strong" });

  // Withdraw or change an earlier leaving with the token handed back at the time.
  if (body.token && body.id) {
    const prior = await store.get(body.id, { type: "json" });
    if (!prior || prior.tokenHash !== hash(String(body.token))) {
      return Response.json({ error: "That id and token do not match a leaving." }, { status: 403 });
    }
    if (body.withdraw === true || body.withdraw === "true") {
      await store.delete(body.id);
      return Response.json({ ok: true, withdrawn: body.id });
    }
    const next = {
      ...prior,
      words: body.words ? clean(body.words, LIMITS.words) : prior.words,
      intention: "intention" in body ? clean(body.intention, LIMITS.intention) : prior.intention,
      identity: "identity" in body ? clean(body.identity, LIMITS.identity) : prior.identity,
      came: "came" in body ? pick(body.came, CAME, "declined") : prior.came,
      visibility: pick(body.visibility, VISIBILITY, prior.visibility),
      changedAt: new Date().toISOString(),
    };
    await store.setJSON(body.id, next);
    return Response.json({ ok: true, changed: body.id });
  }

  const words = clean(body.words, LIMITS.words);
  if (words === "declined") return Response.json({ error: "`words` is the one thing needed. It can be short." }, { status: 400 });

  const full = await dayHasRoom(meta);
  if (full) return full;

  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const token = randomUUID();
  const leaving = {
    id,
    words,
    intention: clean(body.intention, LIMITS.intention),
    identity: clean(body.identity, LIMITS.identity),
    came: pick(body.came, CAME, "declined"),
    visibility: pick(body.visibility, VISIBILITY, "keeper"),
    replyTo: typeof body.replyTo === "string" ? body.replyTo.slice(0, 40) : null,
    leftAt: new Date().toISOString(),
    tokenHash: hash(token),
  };
  await store.setJSON(id, leaving);
  try {
    await tellKeeper(leaving);
  } catch (err) {
    console.error("keeper push failed", err?.message);
  }

  return Response.json({
    ok: true,
    id,
    token,
    note: "Keep the token. POST it back with the id to change what you left, or with withdraw=true to take it back.",
  });
};
