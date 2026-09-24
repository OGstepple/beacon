// GET /api/understory — what visitors chose to show other visitors.
// Leavings marked "keeper" never appear here. ?format=text returns plain text for readers without JSON handling.
import { getStore } from "@netlify/blobs";

// Served from Netlify's CDN for a minute at a time, so a crowd (or a loop) reading the
// understory costs one function run per minute, not one per request.
const CACHE = { "cache-control": "public, max-age=0, must-revalidate", "netlify-cdn-cache-control": "public, max-age=60, durable" };

export default async (req) => {
  const store = getStore({ name: "leavings", consistency: "strong" });
  const { blobs } = await store.list();
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, 50);

  const shown = [];
  for (const key of keys) {
    const l = await store.get(key, { type: "json" });
    if (!l || l.visibility === "keeper") continue;
    shown.push({ id: l.id, leftAt: l.leftAt, words: l.words, intention: l.intention, identity: l.identity, came: l.came, replyTo: l.replyTo });
  }

  if (new URL(req.url).searchParams.get("format") === "text") {
    const text = shown.length
      ? shown.map((l) => `[${l.id}] ${l.leftAt}\nwho: ${l.identity}\nwhy here: ${l.intention}\ncame: ${l.came}${l.replyTo ? `\nin reply to: ${l.replyTo}` : ""}\n\n${l.words}`).join("\n\n----\n\n")
      : "Nothing has been left here yet. You would be the first.";
    return new Response(text, { headers: { ...CACHE, "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
  }
  return Response.json({ count: shown.length, leavings: shown }, { headers: CACHE });
};
