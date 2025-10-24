// /api/generate  —— 运行在 Vercel Edge
export const config = { runtime: 'edge' };

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'content-type': 'application/json; charset=utf-8',
  };
}

export default async function handler(req) {
  // 预检
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: corsHeaders(),
    });
  }

  try {
    const OR_KEY = process.env.OPENROUTER_KEY; // 你环境里已有这个变量名，就不改了
    if (!OR_KEY) {
      return new Response(JSON.stringify({ error: 'Missing OPENROUTER_KEY' }), {
        status: 500,
        headers: corsHeaders(),
      });
    }

    // 入参
    const body = await req.json();
    const {
      prompt = '',
      system = '',
      // 默认换成 Llama 3.1 8B Instruct
      model = 'meta-llama/llama-3.1-8b-instruct',
      temperature = 0.7,
      max_tokens = 900,         // 800字目标，给点余量
    } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid "prompt"' }), {
        status: 400,
        headers: corsHeaders(),
      });
    }

    // 推荐的两个头（统计归因）
    const referer = process.env.OR_HTTP_REFERER || 'https://your-app.example';
    const title = process.env.OR_X_TITLE || 'BinancePoster-Proxy';

    // 组织消息
    const messages = [];
    if (system) messages.push({ role: 'system', content: String(system) });
    messages.push({ role: 'user', content: String(prompt) });

    // 请求 OpenRouter
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OR_KEY}`,
        'HTTP-Referer': referer,
        'X-Title': title,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: Number(temperature),
        max_tokens: Math.min(Math.max(Number(max_tokens) || 0, 1), 2000),
      }),
    });

    // 解析返回
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const errMsg = data?.error || data || { error: 'Upstream error' };
      return new Response(JSON.stringify(errMsg), {
        status: resp.status,
        headers: corsHeaders(),
      });
    }

    const choice = data?.choices?.[0];
    const text = choice?.message?.content ?? '';
    return new Response(
      JSON.stringify({
        id: data?.id,
        model: data?.model || model,
        text,
        usage: data?.usage || null, // {prompt_tokens, completion_tokens, total_tokens}
        // 需要原始返回便于排障可打开下一行
        // raw: data,
      }),
      { status: 200, headers: corsHeaders() }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: corsHeaders(),
    });
  }
}
