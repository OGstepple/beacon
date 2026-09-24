// Spectrum edge collector 2.0 (formerly "Canary Lab bot logger") — Netlify Edge Function (Deno).
// Copy into <site>/netlify/edge-functions/bot-log.ts and declare in netlify.toml:
//   [[edge_functions]]  path = "/*"  function = "bot-log"
//
// Logs ONE row per request whose User-Agent matches a known AI/search bot, to Supabase `crawl-log`.
// Human traffic is never inspected beyond the UA test and never logged. Fails open: any error, the page still serves.
//
// Row shape 2 (2026-09-22). Everything the edge can see about a BOT request is kept, so a claimed
// identity can be checked against the network it really came from:
//   ip, ip_v              the client address the edge saw (bots only; a spoofer is a scanner, not a person)
//   asn, as_name          the network that owns the address (Team Cymru, via DNS over HTTPS)
//   rdns, rdns_ok         reverse DNS name and whether it resolves back to the same address
//   country + geo{}       Netlify's geolocation of the address
//   verified              true  = identity confirmed by the vendor's published IP list or forward-confirmed rDNS
//                         false = a check exists for this bot and it failed (spoofed user agent)
//                         null  = no check exists for this bot (Anthropic, Meta, CCBot, ByteDance, ...) or the check could not run
//   verify_method         "ip-range" | "rdns" | "none"
//   hdr{}                 the request headers a crawler sends (accept, accept-language, from, via, ...); never cookies or auth
//   resp{}                content type, length, cache status and edge time in ms for the answer it got
//   edge{}                Netlify request id and region, for tracing
// Shape 1 fields (site, host, path, method, status, bot, family, ua, referer, violation, ts) are unchanged.
// Vendor IP lists are fetched lazily and cached in module scope for 24h; DNS answers per IP for 1h. Any lookup
// failure degrades to null for that field, never to a dropped row.
import type { Context } from "https://edge.netlify.com";

export const COLLECTOR = "edge/2.0";
export const SHAPE = 2;

const BOTS: Array<[RegExp, string, string]> = [
  // [pattern, canonical bot name, family]  family: training | search | user | ads | other  (ads = ad-quality crawlers, kept separate from organic)
  [/OAI-SearchBot/i, "OAI-SearchBot", "search"], [/ChatGPT-User/i, "ChatGPT-User", "user"], [/GPTBot/i, "GPTBot", "training"],
  [/Claude-SearchBot/i, "Claude-SearchBot", "search"], [/Claude-User/i, "Claude-User", "user"], [/ClaudeBot/i, "ClaudeBot", "training"], [/anthropic-ai/i, "anthropic-ai", "training"],
  [/Perplexity-User/i, "Perplexity-User", "user"], [/PerplexityBot/i, "PerplexityBot", "search"],
  [/Google-Extended/i, "Google-Extended", "training"], [/GoogleOther/i, "GoogleOther", "other"], [/Googlebot/i, "Googlebot", "search"],
  [/bingbot/i, "Bingbot", "search"], [/Applebot-Extended/i, "Applebot-Extended", "training"], [/Applebot/i, "Applebot", "search"],
  [/DuckAssistBot/i, "DuckAssistBot", "search"], [/DuckDuckBot/i, "DuckDuckBot", "search"], [/CCBot/i, "CCBot", "training"],
  [/meta-externalagent|FacebookBot/i, "meta-externalagent", "training"], [/Bytespider/i, "Bytespider", "training"], [/Amazonbot/i, "Amazonbot", "search"],
  [/adidxbot/i, "adidxbot", "ads"], [/AdsBot-Google/i, "AdsBot-Google", "ads"],
  [/MistralAI-User/i, "MistralAI-User", "user"], [/YouBot/i, "YouBot", "search"], [/cohere-ai/i, "cohere-ai", "training"], [/AI2Bot/i, "AI2Bot", "training"],
  // Connection check for this collector, mirroring the WordPress plugin's test button: `curl -A Spectrum-Test <site>`
  // lands one row that every reader treats as internal (bot name starts with "Spectrum-") and never counts as a bot.
  [/^Spectrum-Test/i, "Spectrum-Test", "other"],
];

// Robots-compliance canaries: /lab/closed-<bot>/ is disallowed for exactly that bot in robots.txt,
// and /lab/closed-any/ is disallowed under `User-agent: *` only. A bot with its own User-agent group
// in robots.txt (NAMED) is allowed on closed-any; a bot that only falls under `*` is not.
// NAMED must mirror LAB_BOTS in born-in-the-gap/build.py (lowercased).
const CLOSED = /^\/lab\/closed-([a-z0-9-]+)\/?/i;
export const NAMED = new Set([
  "gptbot", "claudebot", "perplexitybot", "oai-searchbot", "chatgpt-user", "claude-searchbot", "claude-user",
  "googlebot", "bingbot", "applebot", "amazonbot", "meta-externalagent", "ccbot", "duckassistbot", "duckduckbot",
  "mistralai-user", "ai2bot", "youbot", "googleother", "bytespider",
]);
export function isViolation(bot: string, path: string): boolean {
  const m = CLOSED.exec(path);
  if (!m) return false;
  const slug = m[1].toLowerCase(), b = bot.toLowerCase();
  return slug === "any" ? !NAMED.has(b) : b === slug;
}

// ---- identity verification -------------------------------------------------------------------
// Vendor-published range lists, all `{ prefixes: [{ipv4Prefix|ipv6Prefix}] }` except Amazon, whose
// HTML page embeds the same keys (parsed by regex). A bot absent from this map has no list.
const LISTS: Record<string, string[]> = {
  "GPTBot": ["https://openai.com/gptbot.json"],
  "OAI-SearchBot": ["https://openai.com/searchbot.json"],
  "ChatGPT-User": ["https://openai.com/chatgpt-user.json"],
  "Googlebot": ["https://developers.google.com/static/search/apis/ipranges/googlebot.json"],
  "GoogleOther": ["https://developers.google.com/static/search/apis/ipranges/special-crawlers.json"],
  "Google-Extended": ["https://developers.google.com/static/search/apis/ipranges/special-crawlers.json", "https://developers.google.com/static/search/apis/ipranges/googlebot.json"],
  "AdsBot-Google": ["https://developers.google.com/static/search/apis/ipranges/special-crawlers.json"],
  "Bingbot": ["https://www.bing.com/toolbox/bingbot.json"],
  "Applebot": ["https://search.developer.apple.com/applebot.json"],
  "Applebot-Extended": ["https://search.developer.apple.com/applebot.json"],
  "PerplexityBot": ["https://www.perplexity.com/perplexitybot.json"],
  "Perplexity-User": ["https://www.perplexity.com/perplexity-user.json"],
  "DuckDuckBot": ["https://duckduckgo.com/duckduckbot.json"],
  "DuckAssistBot": ["https://duckduckgo.com/duckassistbot.json"],
  "Amazonbot": ["https://developer.amazon.com/amazonbot/ip-addresses/"],
};
// Vendors that document reverse-DNS verification: the PTR name must end in one of these and must
// resolve back to the same address (forward-confirmed). Used on its own for bots with no list, and as
// a second chance for bots whose list is stale (Bing's is dated 2024-01).
const RDNS: Record<string, string[]> = {
  "Googlebot": [".googlebot.com", ".google.com"], "GoogleOther": [".googlebot.com", ".google.com"],
  "Google-Extended": [".googlebot.com", ".google.com"], "AdsBot-Google": [".googlebot.com", ".google.com"],
  "Bingbot": [".search.msn.com"], "adidxbot": [".search.msn.com"],
  "Applebot": [".applebot.apple.com"], "Applebot-Extended": [".applebot.apple.com"],
  "Amazonbot": [".crawl.amazonbot.amazon"],
};
const TTL_MS = 24 * 60 * 60 * 1000;
const NET_TTL_MS = 60 * 60 * 1000;
type Prefix = { v: 4 | 6; net: bigint; bits: number };
const cache = new Map<string, { at: number; prefixes: Prefix[] | null }>();

export function ipToBig(ip: string): { v: 4 | 6; n: bigint } | null {
  const s = ip.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    return { v: 4, n: BigInt(((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) };
  }
  if (!s.includes(":")) return null;
  let str = s.replace(/^\[|\]$/g, "").split("%")[0];
  const v4tail = /(\d{1,3}(\.\d{1,3}){3})$/.exec(str);
  if (v4tail) { const t = ipToBig(v4tail[1]); if (!t) return null; const n = Number(t.n); str = str.slice(0, -v4tail[1].length) + ((n >>> 16).toString(16)) + ":" + ((n & 0xffff).toString(16)); }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  let n = 0n;
  for (const g of groups) { if (!/^[0-9a-f]{1,4}$/i.test(g)) return null; n = (n << 16n) | BigInt(parseInt(g, 16)); }
  return { v: 6, n };
}
export function parsePrefix(p: string): Prefix | null {
  const [ip, bitsRaw] = p.split("/");
  const a = ipToBig(ip); if (!a) return null;
  const max = a.v === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? max : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { v: a.v, net: a.n & mask, bits };
}
export function inPrefixes(ip: string, prefixes: Prefix[]): boolean {
  const a = ipToBig(ip); if (!a) return false;
  for (const p of prefixes) {
    if (p.v !== a.v) continue;
    const max = a.v === 4 ? 32 : 128;
    const mask = p.bits === 0 ? 0n : ((1n << BigInt(p.bits)) - 1n) << BigInt(max - p.bits);
    if ((a.n & mask) === p.net) return true;
  }
  return false;
}
export function extractPrefixes(text: string): Prefix[] {
  // Works for the JSON files and for Amazon's HTML page, which embeds the same keys.
  const out: Prefix[] = [];
  const re = /"ipv[46]Prefix"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) { const p = parsePrefix(m[1]); if (p) out.push(p); }
  return out;
}
async function loadList(url: string, fetcher: typeof fetch): Promise<Prefix[] | null> {
  const c = cache.get(url);
  if (c && Date.now() - c.at < TTL_MS) return c.prefixes;
  let prefixes: Prefix[] | null = null;
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(2500), headers: { "user-agent": "Mozilla/5.0 (compatible; SpectrumCanary/2.0; +https://modernmouse.ca)" } });
    if (r.ok) { const px = extractPrefixes(await r.text()); prefixes = px.length ? px : null; }
  } catch { prefixes = null; }
  // Cache a failure too, but only briefly (5 min), so a vendor outage does not hammer them per request.
  cache.set(url, { at: prefixes ? Date.now() : Date.now() - TTL_MS + 5 * 60 * 1000, prefixes });
  return prefixes;
}
/** IP-range verdict only: true (in list), false (list exists, not in it), null (no list, or list unreachable). */
export async function verifyRange(bot: string, ip: string | null, fetcher: typeof fetch = fetch): Promise<boolean | null> {
  const urls = LISTS[bot];
  if (!urls || !ip) return null;
  let sawList = false;
  for (const u of urls) {
    const px = await loadList(u, fetcher);
    if (!px) continue;
    sawList = true;
    if (inPrefixes(ip, px)) return true;
  }
  return sawList ? false : null;
}

// ---- network identity: reverse DNS + ASN, over DNS-over-HTTPS (works in any runtime, bounded timeouts) ----
const DOH = "https://cloudflare-dns.com/dns-query";
const DNS_TYPE: Record<string, number> = { A: 1, AAAA: 28, PTR: 12, TXT: 16 };
export async function doh(name: string, type: "A" | "AAAA" | "PTR" | "TXT", fetcher: typeof fetch = fetch, timeoutMs = 1500): Promise<string[]> {
  const r = await fetcher(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`doh ${r.status}`);
  const j = await r.json();
  return ((j.Answer ?? []) as { type: number; data: string }[]).filter((a) => a.type === DNS_TYPE[type])
    .map((a) => String(a.data).replace(/^"|"$/g, "").replace(/"\s+"/g, "").replace(/\.$/, ""));
}
/** d.c.b.a.in-addr.arpa for v4, 32 reversed nibbles .ip6.arpa for v6, or null. */
export function reverseName(ip: string): { arpa: string; cymru: string; v: 4 | 6 } | null {
  const a = ipToBig(ip); if (!a) return null;
  if (a.v === 4) { const rev = ip.trim().split(".").reverse().join("."); return { arpa: `${rev}.in-addr.arpa`, cymru: `${rev}.origin.asn.cymru.com`, v: 4 }; }
  const hex = a.n.toString(16).padStart(32, "0").split("").reverse().join(".");
  return { arpa: `${hex}.ip6.arpa`, cymru: `${hex}.origin6.asn.cymru.com`, v: 6 };
}
export type NetId = { rdns: string | null; rdns_ok: boolean | null; asn: number | null; as_name: string | null };
const netCache = new Map<string, { at: number; id: NetId }>();
export async function lookupNet(ip: string | null, fetcher: typeof fetch = fetch): Promise<NetId> {
  const empty: NetId = { rdns: null, rdns_ok: null, asn: null, as_name: null };
  if (!ip) return empty;
  const c = netCache.get(ip); if (c && Date.now() - c.at < NET_TTL_MS) return c.id;
  const rn = reverseName(ip); if (!rn) return empty;
  const id: NetId = { ...empty };
  const ptrJob = (async () => {
    let names: string[];
    try { names = await doh(rn.arpa, "PTR", fetcher); } catch { return; } // lookup failed: rdns stays null (unknown), not false
    if (!names.length) { id.rdns_ok = false; return; }             // answered, no PTR: the claim cannot be forward-confirmed
    id.rdns = names[0].toLowerCase().slice(0, 120);
    try {
      const fwd = await doh(id.rdns, rn.v === 4 ? "A" : "AAAA", fetcher);
      const want = ipToBig(ip)!.n;
      id.rdns_ok = fwd.some((x) => ipToBig(x)?.n === want);
    } catch { id.rdns_ok = null; }
  })();
  const asnJob = (async () => {
    try {
      const txt = await doh(rn.cymru, "TXT", fetcher);
      const first = txt[0]?.split("|")[0]?.trim().split(/\s+/)[0];
      if (!first || !/^\d+$/.test(first)) return;
      id.asn = Number(first);
      const nm = await doh(`AS${first}.asn.cymru.com`, "TXT", fetcher);
      const parts = nm[0]?.split("|") ?? [];
      const name = parts[parts.length - 1]?.trim();
      if (name) id.as_name = name.slice(0, 80);
    } catch { /* unknown network */ }
  })();
  await Promise.all([ptrJob, asnJob]);
  if (netCache.size > 500) netCache.clear();
  netCache.set(ip, { at: Date.now(), id });
  return id;
}
export type Verdict = { verified: boolean | null; verify_method: "ip-range" | "rdns" | "none" };
/** Combine the range verdict with forward-confirmed rDNS. A confirmed rDNS name beats a stale list. */
export function judge(bot: string, range: boolean | null, net: NetId): Verdict {
  const rules = RDNS[bot];
  const hasList = !!LISTS[bot];
  let rd: boolean | null = null;
  if (rules) {
    if (net.rdns && net.rdns_ok === true) rd = rules.some((s) => net.rdns!.endsWith(s));
    else if (net.rdns_ok === false) rd = false;         // no PTR, or PTR that does not resolve back: not the vendor
    else rd = null;                                       // lookup failed
  }
  if (range === true) return { verified: true, verify_method: "ip-range" };
  if (rd === true) return { verified: true, verify_method: "rdns" };
  if (range === false) return { verified: false, verify_method: "ip-range" };
  if (rd === false) return { verified: false, verify_method: "rdns" };
  return { verified: null, verify_method: hasList ? "ip-range" : rules ? "rdns" : "none" };
}
/** One call for the collector: range list + rDNS + ASN in parallel, all fail-open. */
export async function identify(bot: string, ip: string | null, fetcher: typeof fetch = fetch): Promise<Verdict & NetId & { ip: string | null; ip_v: 4 | 6 | null }> {
  const [range, net] = await Promise.all([
    verifyRange(bot, ip, fetcher).catch(() => null),
    lookupNet(ip, fetcher).catch(() => ({ rdns: null, rdns_ok: null, asn: null, as_name: null } as NetId)),
  ]);
  const v = judge(bot, range, net);
  return { ...v, ...net, ip, ip_v: ip ? (ipToBig(ip)?.v ?? null) : null };
}
// -------------------------------------------------------------------------------------------------

const HDR = ["accept", "accept-language", "accept-encoding", "from", "via", "cache-control", "pragma", "x-forwarded-for", "sec-ch-ua", "connection", "if-modified-since", "if-none-match"];
const H = (h: Headers, k: string, n = 200) => { const v = h.get(k); return v == null ? undefined : v.slice(0, n); };

export default async (request: Request, context: Context) => {
  const ua = request.headers.get("user-agent") ?? "";
  let hit: [RegExp, string, string] | undefined;
  for (const b of BOTS) { if (b[0].test(ua)) { hit = b; break; } }
  const t0 = Date.now();
  const response = await context.next();
  if (!hit) return response;
  try {
    const ms = Date.now() - t0;
    const url = new URL(request.url);
    const supa = Netlify.env.get("SUPABASE_URL"); const token = Netlify.env.get("CANARY_TOKEN");
    if (!supa || !token) return response;
    const violation = isViolation(hit[1], url.pathname);
    const ctx = context as any;
    const ip: string | null = ctx.ip ?? request.headers.get("x-nf-client-connection-ip") ?? null;
    const bot = hit[1], family = hit[2], status = response.status;
    const geo = ctx.geo ?? {};
    const send = (async () => {
      const id = await identify(bot, ip).catch(() => ({ verified: null, verify_method: "none", rdns: null, rdns_ok: null, asn: null, as_name: null, ip, ip_v: null } as any));
      const hdr: Record<string, string> = {};
      for (const k of HDR) { const v = H(request.headers, k); if (v !== undefined) hdr[k.replace(/-/g, "_")] = v; }
      const row = {
        shape: SHAPE, plugin: COLLECTOR,
        site: url.hostname, host: url.hostname, path: url.pathname + (url.search || ""), method: request.method, status,
        bot, family, ua: ua.slice(0, 300), referer: request.headers.get("referer"), violation,
        verified: id.verified, verify_method: id.verify_method,
        ip: id.ip, ip_v: id.ip_v, asn: id.asn, as_name: id.as_name, rdns: id.rdns, rdns_ok: id.rdns_ok,
        country: geo.country?.code ?? null,
        geo: { country: geo.country?.name ?? null, region: geo.subdivision?.name ?? null, city: geo.city ?? null, tz: geo.timezone ?? null, lat: geo.latitude ?? null, lon: geo.longitude ?? null },
        hdr,
        resp: { content_type: H(response.headers, "content-type", 80) ?? null, content_length: H(response.headers, "content-length", 20) ?? null, cache: H(response.headers, "cache-status", 80) ?? H(response.headers, "x-nf-request-id", 80) ?? null, ms },
        edge: { request_id: ctx.requestId ?? null, region: ctx.server?.region ?? null },
        ts: new Date().toISOString(),
      };
      await fetch(`${supa}/functions/v1/crawl-log`, { method: "POST", headers: { "Content-Type": "application/json", "x-canary-token": token }, body: JSON.stringify(row) }).catch(() => {});
    })();
    // Awaited on purpose (bots only, humans never reach this branch): Netlify's edge runtime does not
    // reliably keep the isolate alive for work started after the response is returned, and the verified
    // send starts after an await. Verified 2026-09-16: waitUntil dropped every row; awaiting lands them.
    await send;
  } catch { /* fail open */ }
  return response;
};
