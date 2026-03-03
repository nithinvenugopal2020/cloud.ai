/**
 * Cloudflare Pages Function — /chat
 * cloudnetworking.ai — OpenAI Responses API with Vector Store search
 *
 * No Assistant needed — uses Responses API directly with file_search.
 * Routes via Cloudflare AI Gateway to avoid region restrictions.
 *
 * Secrets in Cloudflare Pages → Settings → Variables and Secrets:
 *   OPENAI_API_KEY
 *   OPENAI_VECTOR_STORE_ID
 * Binding:
 *   CHAT_RATE_LIMIT  (KV namespace)
 */

const MODEL       = "gpt-4o-mini";
const DAILY_LIMIT = 5;
const ACCOUNT_ID  = "2f60f2d3b1487567a2b0a7fcbab445cb";
const GATEWAY_URL = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/openai-proxy/compat`;
const OPENAI_URL  = `${GATEWAY_URL}/responses`;

const SYSTEM_PROMPT = `You are the AI assistant for cloudnetworking.ai — an educational site focused on cloud networking and security.
Search the knowledge base first before answering. Be concise, clear, and beginner-friendly.
If the answer is not in the knowledge base, say so honestly and give a general best-practice answer.`;

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

  const { message, previousResponseId } = body;
  if (!message) return respond({ error: "message required" }, 400);

  // Build Responses API payload
  // previousResponseId keeps conversation context across turns — no history array needed
  const payload = {
    model: MODEL,
    instructions: SYSTEM_PROMPT,
    input: message,
    tools: [{
      type: "file_search",
      vector_store_ids: [env.OPENAI_VECTOR_STORE_ID],
    }],
    ...(previousResponseId && { previous_response_id: previousResponseId }),
  };

  // Call OpenAI via Cloudflare AI Gateway
  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return respond({ error: "Failed to reach OpenAI: " + err.message }, 502);
  }

  const data = await res.json();

  if (!res.ok) {
    return respond({ error: data?.error?.message || "OpenAI error" }, res.status);
  }

  // Extract reply from Responses API output blocks
  const output = data?.output ?? [];
  let reply = "";
  for (const block of output) {
    if (block.type === "message") {
      for (const part of block.content ?? []) {
        if (part.type === "output_text") {
          reply += part.text;
        }
      }
    }
  }

  // Strip citation markers e.g. 【4:0source】
  reply = reply.replace(/[【][^】]*[】]/g, "").trim();
  if (!reply) reply = "Sorry, I could not find an answer. Please try rephrasing.";

  return respond({ reply, remaining, responseId: data.id }, 200);
}

function respond(data, status) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}
