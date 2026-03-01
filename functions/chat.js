/**
 * Cloudflare Pages Function — /chat
 * cloudnetworking.ai AI chat proxy
 *
 * Uses OpenAI chat completions with a system prompt grounded
 * in your Vector Store content. No Assistant ID needed.
 *
 * Secrets in Cloudflare Pages → Settings → Variables and Secrets:
 *   OPENAI_API_KEY
 *   OPENAI_VECTOR_STORE_ID
 */

const MODEL = "gpt-4o";

const SYSTEM_PROMPT = `You are the AI assistant for cloudnetworking.ai — an educational site focused on cloud networking and security.

Your knowledge covers:
- AWS networking: VPC, Transit Gateway, Direct Connect, BGP, route tables
- Firewall concepts: flow, connection, session, stateful vs stateless
- Cloud security: IAM, Zero Trust, DDoS protection, Security Groups
- Networking fundamentals: OSI model, TCP/IP, routing, DNS, packets
- Traditional DC vs cloud security models

Be concise, clear, and beginner-friendly. Explain technical terms when you use them.
If you don't know something, say so honestly.`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function onRequestPost({ request, env }) {

  // ── Parse body ──
  let body;
  try { body = await request.json(); }
  catch { return respond({ error: "Invalid JSON" }, 400); }

  const { message, history } = body;
  if (!message) return respond({ error: "message required" }, 400);

  // ── Build messages array ──
  // history = prior turns sent from the browser [ {role, content}, ... ]
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: message },
  ];

  // ── Call OpenAI chat completions ──
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
        max_tokens: 800,
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
  return respond({ reply }, 200);
}

function respond(data, status) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}
