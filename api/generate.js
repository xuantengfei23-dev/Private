// /api/generate —— Fast Minimal 版（更快 + 最小化去重 + 人性化）
// 环境变量：OPENROUTER_KEY（必需），OR_HTTP_REFERER / OR_X_TITLE（可选）

export const config = { runtime: 'edge' };

/* -------------------- CORS -------------------- */
function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-Request-ID',
    'content-type': 'application/json; charset=utf-8',
  };
}

/* -------------------- 常量 / 轻工具 -------------------- */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS     = 25000;                 // 25s：先于 Vercel 平台超时返回
const MODEL_DEFAULT  = 'meta-llama/llama-3.1-8b-instruct';

// 可选去重短语（最小化，避免“营销腔 / 模板腔”）
const DEDUP_PHRASES_ZH = [
  '点赞关注','一键三连','欢迎私信','带你了解','冲冲冲','不构成投资建议',
  '一定要看','别再错过','爆赚','财富自由','总结来说','综上所述','最后我们来看',
  '赶紧','速看','建议收藏','分享给朋友'
];

// 轻 persona / 语气 / 开场钩子（随机一点，提升“人味”但不影响速度）
const TONES = [
  '口吻自然，像和朋友交流，但保持克制和客观。',
  '语气平实、少形容词，不用口号。',
  '先抛一个小问题或观察，再给结论。'
];
const HOOKS = [
  '一个细节常被忽略：',
  '快速记录一下：',
  '个人小结：',
  '值得二次确认的是：'
];

// 内存最近标题去重（Edge 实例内；已够用且极轻）
globalThis.__RECENT_TITLES = globalThis.__RECENT_TITLES || [];
const RECENT = globalThis.__RECENT_TITLES;

const ok  = (trace_id, data) => ({ ok: true,  trace_id, ...data });
const err = (trace_id, code, message, extra={}) => ({ ok: false, trace_id, code, message, ...extra });

function traceId(req) {
  const fromHeader = req.headers.get('X-Request-ID');
  if (fromHeader) return String(fromHeader).slice(0,64);
  const arr = new Uint8Array(16); crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
}
function clamp(n,a,b){ return Math.min(b, Math.max(a, n)); }
function pick(arr){ return arr[(Math.random()*arr.length)|0]; }
function hashStr(s=''){ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619)} return (h>>>0).toString(36); }

/* -------------------- 轻清洗 / 去重 -------------------- */
function limitEmoji(s='') {
  const arr = Array.from(s); let c = 0;
  return arr.map(ch => /\p{Emoji_Presentation}/u.test(ch) ? (++c<=2?ch:'') : ch).join('');
}
function stripMarketing(s=''){
  let out = s;
  for (const p of DEDUP_PHRASES_ZH) out = out.replace(new RegExp(p, 'g'), '');
  return out;
}
function dedupSentences(s=''){
  // 按句号/换行粗糙切分，去掉完全重复，合并多空白
  const parts = s.split(/(?<=[。！？!?])|\n+/).map(t => t.trim()).filter(Boolean);
  const seen = new Set(); const out = [];
  for (const t of parts) { const k = t; if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out.join('').replace(/\s{2,}/g,' ').trim();
}
function sanitizeOut(bodyText='', token='') {
  let text = String(bodyText||'').replace(/\r/g,'').trim();
  text = stripMarketing(text);
  text = limitEmoji(text);
  text = dedupSentences(text);
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // 标题：首行或首句；附 token；限制长度
  const firstLine = text.split(/\n|。|!|！|\?/)[0] || '';
  let title = `${token}｜${firstLine.replace(/[#*$@>\-]/g,'').slice(0,24)}`.trim();
  if (!title) title = `${token} 更新`.slice(0, 16);
  if (title.length > 48) title = title.slice(0,48);

  // 内存去重：最近 50 个标题哈希
  const h = hashStr(title.toLowerCase());
  if (RECENT.includes(h)) {
    // 轻微扰动避免重复
    const tweak = ['快评','观察','随记','备忘'][Math.floor(Math.random()*4)];
    title = (title + '｜' + tweak).slice(0,48);
  }
  RECENT.unshift(h); if (RECENT.length > 50) RECENT.pop();

  return { title, text };
}

/* -------------------- System & User（极简，人性化） -------------------- */
function buildSystemFast({ token='BTC', language='zh' }) {
  const zh = (language||'zh').toLowerCase().startsWith('zh');
  const tone  = pick(TONES);
  const hook  = pick(HOOKS);

  if (zh) {
    return [
      `${tone}`,
      `只写一段中文短文（120–200 字），${hook}`,
      `只围绕 ${token} 的一个清晰要点展开；可以包含 1 个可核验细节（时间/版本/编号/tx 片段）。`,
      `不要价格预测/点位/K线；不要口号/鸡汤/结语模板。`,
      `输出纯正文，不要 JSON 或额外格式。`,
    ].join('\n');
  }
  return [
    `${tone}`,
    `Write one short paragraph (120–200 chars), ${hook}`,
    `Focus strictly on ${token}, include at most one verifiable detail (time/version/id/tx snippet).`,
    `No price targets/TA/slogans. Output plain text only.`,
  ].join('\n');
}
function buildUserFast({ prompt='', language='zh' }) {
  const zh = (language||'zh').toLowerCase().startsWith('zh');
  return zh
    ? [prompt || '来一段简洁的观察与提醒。'].join('\n')
    : [prompt || 'A short observation and reminder.'].join('\n');
}

/* -------------------- 上游调用（无 JSON 模式 / 无修复 / 无 KV） -------------------- */
async function callUpstreamFast({ model, messages, temperature, max_tokens, signal }) {
  const OR_KEY = process.env.OPENROUTER_KEY;
  const referer = process.env.OR_HTTP_REFERER || 'https://your-app.example';
  const titleHdr = process.env.OR_X_TITLE || 'BinancePoster-Fast';

  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OR_KEY}`,
      'HTTP-Referer': referer,
      'X-Title': titleHdr,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: Number(temperature),
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.1,
      max_tokens: clamp(Number(max_tokens)||0, 1, 1200) // 适度上限即可
    }),
    signal
  });

  const j = await resp.json().catch(()=>null);
  if (!resp.ok) {
    const errMsg = j?.error || j || { error: 'Upstream error' };
    throw new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
  }
  return j;
}

/* -------------------- Handler（极速极简路径） -------------------- */
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify(err('-', 'ERR_INPUT', 'Method Not Allowed')), {
      status: 405, headers: corsHeaders(),
    });
  }

  const trace_id = traceId(req);

  try {
    const OR_KEY = process.env.OPENROUTER_KEY;
    if (!OR_KEY) {
      return new Response(JSON.stringify(err(trace_id, 'ERR_INPUT', 'Missing OPENROUTER_KEY')), {
        status: 500, headers: corsHeaders(),
      });
    }

    const body = await req.json().catch(()=> ({}));
    const {
      prompt = '',
      system = '',
      model = MODEL_DEFAULT,
      temperature = 0.72,          // 稍收敛以提速
      max_tokens  = 650,           // 精简返回
      lang = 'zh',
      token = 'BTC',
      // 可选：前端透传 tags/mentions/tickers
      context = {}                 // { tags, mentions, tickers }
    } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify(err(trace_id, 'ERR_INPUT', 'Invalid "prompt"')), {
        status: 400, headers: corsHeaders(),
      });
    }

    // System / User（极简）
    const sysText  = [system, buildSystemFast({ token, language: lang })].filter(Boolean).join('\n\n');
    const usrText  = buildUserFast({ prompt, language: lang });

    // 上游一次调用（25s 总预算）
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let data;
    try {
      data = await callUpstreamFast({
        model, temperature, max_tokens,
        messages: [
          ...(sysText ? [{ role:'system', content: sysText }] : []),
          { role:'user', content: usrText }
        ],
        signal: controller.signal
      });
    } finally { clearTimeout(to); }

    // 解析（纯文本）
    const raw = data?.choices?.[0]?.message?.content ?? data?.output_text ?? '';
    const clean = String(raw || '').replace(/^```[\s\S]*?```$/g,'').trim();
    const sOut = sanitizeOut(clean, token);

    // 组装结构（保持与前端兼容）
    const payload = ok(trace_id, {
      id: data?.id,
      model: data?.model || model,
      title: sOut.title,
      text:  sOut.text,
      tags:  Array.from(new Set([...(context?.tags||[])]))
               .map(s => String(s).replace(/^#/,'').toLowerCase())
               .filter(Boolean)
               .slice(0, 2),
      tickers: Array.from(new Set([token.toUpperCase(), ...(context?.tickers||[])]))
               .map(s => String(s).replace(/^\$/,'').toUpperCase())
               .filter(Boolean)
               .slice(0, 1),
      mentions: Array.from(new Set([...(context?.mentions||[])]))
               .map(s => String(s).replace(/^@/,''))
               .filter(Boolean)
               .slice(0, 1),
      usage: data?.usage || null,
      flags: { mode: 'fast', timeout_ms: TIMEOUT_MS }
    });
    payload.data = { title: payload.title, text: payload.text, tags: payload.tags };

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders() });

  } catch (e) {
    const message = (e && e.name === 'AbortError') ? 'Upstream timeout' : String(e?.message || e);
    const code = (e && e.name === 'AbortError') ? 'ERR_TIMEOUT' : 'ERR_UPSTREAM';
    return new Response(JSON.stringify(err(trace_id, code, message)), {
      status: 500, headers: corsHeaders(),
    });
  }
}
