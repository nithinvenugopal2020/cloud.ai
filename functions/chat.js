/**
 * Cloudflare Pages Function — /chat
 * cloudnetworking.ai AI chat proxy with rate limiting
 * Routes via Cloudflare AI Gateway (avoids region restrictions)
 *
 * SETUP:
 * 1. Cloudflare → AI Gateway → Create Gateway → name: openai-proxy
 * 2. Copy your Account ID from the gateway URL
 * 3. Replace YOUR_ACCOUNT_ID below with your actual Account ID
 * 4. KV binding: CHAT_RATE_LIMIT (already set up)
 * 5. Secret: OPENAI_API_KEY (already set)
 */

const MODEL       = "gpt-4o-mini";
const DAILY_LIMIT = 5;
const ACCOUNT_ID  = "2f60f2d3b1487567a2b0a7fcbab445cb";

// AI Gateway URL — routes through Cloudflare US infrastructure
const OPENAI_URL  = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/openai-proxy/openai/chat/completions`;

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

  // ── Rate limiting ──
  const ip      = request.headers.get("CF-Connecting-IP") || "unknown";
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

  await env.CHAT_RATE_LIMIT.put(kvKey, String(current + 1), { expirationTtl: 90000 });
  const remaining = DAILY_LIMIT - (current + 1);

  // ── Parse body ──
  let body;
  try { body = await request.json(); }
  catch { return respond({ error: "Invalid JSON" }, 400); }

  const { message, history } = body;
  if (!message) return respond({ error: "message required" }, 400);

  // ── Build messages ──
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(Array.isArray(history) ? history.slice(-6) : []),
    { role: "user", content: message },
  ];

  // ── Call OpenAI via Cloudflare AI Gateway ──
  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "cf-aig-authorization": `Bearer ${env.OPENAI_API_KEY}`,
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
