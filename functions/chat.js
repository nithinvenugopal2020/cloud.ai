/**
 * Cloudflare Pages Function — /chat
 * cloudnetworking.ai AI chat proxy with rate limiting
 *
 * Rate limit: 5 questions per IP per day (resets midnight UTC)
 * Uses Cloudflare KV for tracking — free tier is plenty.
 *
 * SETUP:
 * 1. Cloudflare Dashboard → Workers & Pages → KV
 *    → Create namespace → name it: CHAT_RATE_LIMIT
 * 2. Pages project → Settings → Bindings → Add KV binding:
 *    Variable name: CHAT_RATE_LIMIT
 *    KV namespace:  select the one you just created
 * 3. Secret already set:
 *    OPENAI_API_KEY
 */

const MODEL       = "gpt-4o-mini";   // cost-efficient, resets to gpt-4o anytime
const DAILY_LIMIT = 5;

const SYSTEM_PROMPT = `You are the AI assistant for cloudnetworking.ai — an educational site focused on cloud networking and security.

Your knowledge covers:
- AWS networking: VPC, Transit Gateway, Direct Connect, BGP, route tables
- Firewall concepts: flow, connection, session, stateful vs stateless
- Cloud security: IAM, Zero Trust, DDoS protection, Security Groups
- Networking fundamentals: OSI model, TCP/IP, routing, DNS, packets
- Traditional DC vs cloud security models

Be concise, clear, and beginner-friendly. Explain technical terms when you use them.
If you do not know something, say so honestly.`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestPost({ request, env }) {

  // ── Get visitor IP (Cloudflare always sets this header) ──
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // ── Rate limit key: one per IP per calendar day (UTC) ──
  const today   = new Date().toISOString().slice(0, 10);
  const kvKey   = `rate:${ip}:${today}`;
  const current = parseInt(await env.CHAT_RATE_LIMIT.get(kvKey) || "0");

  if (current >= DAILY_LIMIT) {
    return respond({
      error: `You have reached today's limit of ${DAILY_LIMIT} questions. Come back tomorrow!`,
      limitReached: true,
      remaining: 0,
    }, 429);
  }

  // ── Increment counter — expires after 25h to cover timezone edge cases ──
  await env.CHAT_RATE_LIMIT.put(kvKey, String(current + 1), { expirationTtl: 90000 });
  const remaining = DAILY_LIMIT - (current + 1);

  // ── Parse body ──
  let body;
  try { body = await request.json(); }
  catch { return respond({ error: "Invalid JSON" }, 400); }

  const { message, history } = body;
  if (!message) return respond({ error: "message required" }, 400);

  // ── Build messages — keep last 6 messages (3 turns) to save tokens ──
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(Array.isArray(history) ? history.slice(-6) : []),
    { role: "user", content: message },
  ];

  // ── Call OpenAI ──
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: 600,
        temperature: 0.7,
      }),
    });
  } catch (err) {
    return respond({ error: "Failed to reach OpenAI: " + err.message }, 502);
  }

  const data = await res.json();

  if (!res.ok) {
    return respond({ error: data?.error?.message || "OpenAI error" }, res.status);
  }

  const reply = data?.choices?.[0]?.message?.content ?? "Sorry, no response generated.";
  return respond({ reply, remaining }, 200);
}

function respond(data, status) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}
