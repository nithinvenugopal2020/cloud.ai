/**
 * Cloudflare Pages Function — /chat
 * cloudnetworking.ai AI chat proxy
 *
 * This file lives at: functions/chat.js in your GitHub repo.
 * Cloudflare automatically serves it at: https://cloudnetworking.ai/chat
 *
 * Secrets are already set in your Pages project:
 *   OPENAI_API_KEY
 *   OPENAI_VECTOR_STORE_ID
 */

const MODEL         = "gpt-4o";
const SYSTEM_PROMPT = `You are the AI assistant for cloudnetworking.ai — an educational site on cloud networking and security.
Answer questions using the knowledge base provided. Be clear, concise, and beginner-friendly.
If the answer is not in the knowledge base, say so honestly and give a general best-practice answer.`;

export async function onRequestPost({ request, env }) {
  // ── CORS headers ──
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  // ── Parse body ──
  let body;
  try { body = await request.json(); }
  catch { return respond({ error: "Invalid JSON" }, 400, corsHeaders); }

  const { message, threadId } = body;
  if (!message) return respond({ error: "message required" }, 400, corsHeaders);

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
    "OpenAI-Beta": "assistants=v2",
  };

  try {
    // 1 — Create or reuse thread
    let thread_id = threadId;
    if (!thread_id) {
      const t = await oai("POST", "/threads", {}, headers);
      thread_id = t.id;
    }

    // 2 — Add user message
    await oai("POST", `/threads/${thread_id}/messages`, {
      role: "user",
      content: message,
    }, headers);

    // 3 — Run with file_search against your Vector Store
    let run = await oai("POST", `/threads/${thread_id}/runs`, {
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      tools: [{ type: "file_search" }],
      tool_resources: {
        file_search: {
          vector_store_ids: [env.OPENAI_VECTOR_STORE_ID],
        },
      },
    }, headers);

    // 4 — Poll until complete (max 30s)
    const start = Date.now();
    while (["queued", "in_progress"].includes(run.status)) {
      if (Date.now() - start > 30000) {
        return respond({ error: "Response timed out. Please try again." }, 504, corsHeaders);
      }
      await sleep(1200);
      run = await oai("GET", `/threads/${thread_id}/runs/${run.id}`, null, headers);
    }

    if (run.status !== "completed") {
      return respond({ error: `Run ended with status: ${run.status}` }, 500, corsHeaders);
    }

    // 5 — Get latest assistant message
    const msgs   = await oai("GET", `/threads/${thread_id}/messages?limit=1&order=desc`, null, headers);
    const latest = msgs?.data?.[0];
    const raw    = latest?.content?.[0]?.text?.value ?? "Sorry, I couldn't generate a response.";

    // Strip OpenAI citation markers e.g. 【4:0†source】
    const reply  = raw.replace(/【[^】]*】/g, "").trim();

    return respond({ reply, threadId: thread_id }, 200, corsHeaders);

  } catch (err) {
    return respond({ error: err.message || "Unexpected error" }, 500, corsHeaders);
  }
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// ── Helpers ──
async function oai(method, path, body, headers) {
  const res = await fetch(`https://api.openai.com/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI ${res.status}`);
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function respond(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
