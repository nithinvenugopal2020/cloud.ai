/**
 * Cloudflare Pages Function — /chat
 * cloudnetworking.ai
 *
 * Calls OpenAI directly (no AI Gateway).
 * Region issue is handled by setting smart_placement in wrangler or
 * Cloudflare automatically routing to nearest OpenAI-supported region.
 *
 * Secrets:  OPENAI_API_KEY
 * Binding:  CHAT_RATE_LIMIT (KV)
 */

const MODEL       = "gpt-4o-mini";
const DAILY_LIMIT = 5;
const OPENAI_URL  = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = `You are the AI assistant for cloudnetworking.ai — an educational site focused on cloud networking and security.

Your knowledge covers:
- AWS networking: VPC, Transit Gateway, Direct Connect, BGP, route tables, attachments, VRFs
- Firewall concepts: flow, connection, session, stateful vs stateless, 5-tuple
- Cloud security: IAM, Zero Trust, DDoS protection, Security Groups, CloudTrail
- Traditional DC vs cloud security: perimeter vs identity-driven security
- Networking fundamentals: OSI model, TCP/IP, routing, DNS, packets

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

  // Rate limiting
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

  // Parse body
  let body;
  try { body = await request.json(); }
  catch { return respond({ error: "Invalid JSON" }, 400); }

  const { message, history } = body;
  if (!message) return respond({ error: "message required" }, 400);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(Array.isArray(history) ? history.slice(-6) : []),
    { role: "user", content: message },
  ];

  // Call OpenAI directly
  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: messages,
        max_tokens: 600,
        temperature: 0.7,
      }),
    });
  } catch (err) {
    return respond({ error: "Connection failed: " + err.message }, 502);
  }

  const rawText = await res.text();
  let data;
  try { data = JSON.parse(rawText); }
  catch { return respond({ error: "Bad response: " + rawText.slice(0, 200) }, 500); }

  if (!res.ok) {
    const errMsg = data?.error?.message || data?.error?.code || ("HTTP " + res.status + ": " + rawText.slice(0, 200));
    return respond({ error: errMsg }, res.status);
  }

  const reply = data?.choices?.[0]?.message?.content ?? "Sorry, no response generated.";
  return respond({ reply, remaining }, 200);
}

function respond(data, status) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}
