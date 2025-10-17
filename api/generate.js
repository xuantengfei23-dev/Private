// 运行在 Vercel Edge，路径：/api/generate
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
  // 处理预检请求
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
    const OR_KEY = process.env.OPENROUTER_KEY;
    if (!OR_KEY) {
      return new Response(JSON.stringify({ error: 'Missing OPENROUTER_KEY' }), {
        status: 500,
        headers: corsHeaders(),
      });
    }

    const { prompt = '', system = '', model = 'openai/gpt-4o-mini', temperature = 0.7, max_tokens = 800 } = await req.json();

    // 推荐的两个请求头（可选，但更稳）
    const referer = process.env.OR_HTTP_REFERER || 'https://your-app.example';
    const title = process.env.OR_X_TITLE || 'BinancePoster-Proxy';

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
        messages: [
          system ? { role: 'system', content: system } : null,
          { role: 'user', content: prompt }
        ].filter(Boolean),
        temperature,
        max_tokens,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: data?.error || data }), {
        status: resp.status,
        headers: corsHeaders(),
      });
    }

    const text = data?.choices?.[0]?.message?.content || '';
    return new Response(JSON.stringify({ text, raw: data }), {
      status: 200,
      headers: corsHeaders(),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: corsHeaders(),
    });
  }
}
