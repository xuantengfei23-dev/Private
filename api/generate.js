// /api/generate —— Fast Minimal（500–1000 字 + 标题聪明截断 + 一次补齐）
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
const TIMEOUT_MS     = 25000; // 25s：先于 Vercel 平台超时，避免 504
const MODEL_DEFAULT  = 'meta-llama/llama-3.1-8b-instruct';

// 最小化去重短语（避免营销腔/模板腔）
const DEDUP_PHRASES_ZH = [
  '点赞关注','一键三连','欢迎私信','带你了解','冲冲冲','不构成投资建议',
  '一定要看','别再错过','爆赚','财富自由','总结来说','综上所述','最后我们来看',
  '赶紧','速看','建议收藏','分享给朋友'
];

// 轻语气/开场钩子（提升“人味”，不影响速度）
const TONES = [
  '口吻自然、克制，像和朋友交流但保持客观，不用营销口号。',
  '语气平实、少形容词，不要煽动性词汇。',
  '先抛一个小观察，再给理由或证据。'
];

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

/* -------------------- 清洗 / 去重 -------------------- */
function limitEmoji(s=''){
  const arr = Array.from(s); let c = 0;
  return arr.map(ch => /\p{Emoji_Presentation}/u.test(ch) ? (++c<=2?ch:'') : ch).join('');
}
function stripMarketing(s=''){
  let out = s;
  for (const p of DEDUP_PHRASES_ZH) out = out.replace(new RegExp(p, 'g'), '');
  return out;
}
function dedupSentences(s=''){
  const parts = s.split(/(?<=[。！？!?])|\n+/).map(t => t.trim()).filter(Boolean);
  const seen = new Set(); const out = [];
  for (const t of parts) { if (!seen.has(t)) { seen.add(t); out.push(t); } }
  return out.join('').replace(/\s{2,}/g,' ').trim();
}

// —— 标题“聪明截断”：优先在标点收尾，兜底硬裁，避免半句
function smartClip(s = '', limit = 24) {
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const m = cut.match(/.*?[。！？.!?：:；;,，、]/); // 到最后一个标点
  if (m && m[0].length >= Math.max(6, limit * 0.6)) {
    return m[0].replace(/[：:；;,，、]$/,'');
  }
  return cut.replace(/[\s\-_/,:;，。！？!?.]+$/,'').trim();
}

// —— 正文清洗 + 标题生成
function sanitizeOut(bodyText='', token='') {
  let text = String(bodyText||'').replace(/\r/g,'').trim();
  text = stripMarketing(text);
  text = limitEmoji(text);
  text = dedupSentences(text);
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  const MAX_TITLE = 48;
  const prefix    = `${token}｜`;
  const avail     = Math.max(10, MAX_TITLE - prefix.length);

  const firstLine = text.split(/\n/)[0] || '';
  const firstSent = (firstLine.split(/[。！？.!?]/)[0] || firstLine)
                      .replace(/[#*$@>\-]/g,'');

  let title = prefix + smartClip(firstSent, avail);
  if (!title.trim() || title === `${token}｜`) title = `${token} 更新`;
  if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE);

  // 内存最近 50 个标题去重（轻量）
  const h = hashStr(title.toLowerCase());
  if (RECENT.includes(h)) {
    const tweak = ['快评','观察','要点','随记'][Math.floor(Math.random()*4)];
    title = (title + '｜' + tweak).slice(0, MAX_TITLE);
  }
  RECENT.unshift(h); if (RECENT.length > 50) RECENT.pop();

  return { title, text };
}

/* -------------------- System / User（500–1000 字） -------------------- */
function buildSystemFast({ token='BTC', language='zh', outline='' }) {
  const zh   = (language||'zh').toLowerCase().startsWith('zh');
  const tone = pick(TONES);
  if (zh) {
    return [
      tone,
      '输出一篇中文短文，**总长度控制在 500–1000 字**，建议分 2–3 段，逻辑清晰、口语化但专业。',
      `只围绕 ${token} 的一个清晰要点展开；包含 1–2 个可核验细节（时间/版本/编号/tx 片段）。`,
      outline ? `**尽量围绕**「${outline}」展开，如无把握可写可验证路径。` : '',
      '禁止价格预测/点位/K线；禁止“点赞关注/不构成投资建议/总结来说”等模板化语句。',
      '输出**纯正文**，不要任何 JSON/列表/代码块。'
    ].filter(Boolean).join('\n');
  }
  return [
    'Calm, natural, non-promotional tone.',
    'Write a Chinese short article **500–1000 chars**, 2–3 paragraphs.',
    `Focus strictly on ${token}, include 1–2 verifiable details (time/version/id/tx snippet).`,
    outline ? `Prefer focusing on: ${outline}` : '',
    'No price targets/TA; output plain text only.'
  ].filter(Boolean).join('\n');
}
function buildUserFast({ prompt='', language='zh' }) {
  const zh = (language||'zh').toLowerCase().startsWith('zh');
  return zh ? (prompt || '来一段简洁的人性化分析。') : (prompt || 'A short human-like analysis.');
}

/* -------------------- 上游调用（一次、无 JSON 模式） -------------------- */
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
      max_tokens: clamp(Number(max_tokens)||0, 1, 1300)
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

/* -------------------- Handler -------------------- */
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
      temperature = 0.70,          // 为长文稍收敛
      max_tokens  = 1000,          // 500–1000 字推荐 1000~1100
      lang = 'zh',
      token = 'BTC',
      context = {}                 // { outline, tags, mentions, tickers }
    } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify(err(trace_id, 'ERR_INPUT', 'Invalid "prompt"')), {
        status: 400, headers: corsHeaders(),
      });
    }

    // System / User（带 outline 提示）
    const outlineHint = (context?.outline || '').trim();
    const sysText = [
      system,
      buildSystemFast({ token, language: lang, outline: outlineHint })
    ].filter(Boolean).join('\n\n');
    const usrText = buildUserFast({ prompt, language: lang });

    // —— 第一次生成（25s 总预算）
    const startTs = Date.now();
    const leftMs  = () => Math.max(0, TIMEOUT_MS - (Date.now() - startTs) - 1200); // 预留 1.2s

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), leftMs());
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
    let clean = String(
      data?.choices?.[0]?.message?.content ?? data?.output_text ?? ''
    ).replace(/^```[\s\S]*?```$/g,'').trim();

    // 软裁：超长时在标点收尾
    function softTrimBody(s='', limit=1000){
      if (s.length <= limit) return s;
      const cut = s.slice(0, limit);
      const m = cut.match(/.*?[。！？.!?]/);
      return (m ? m[0] : cut).replace(/\s+$/,'');
    }

    // —— 偏短时一次性补齐（只做一次，且必须还在时间预算内）
    if (clean.length < 500 && leftMs() > 6000) {
      try {
        const controller2 = new AbortController();
        const to2 = setTimeout(()=>controller2.abort(), leftMs());
        const more = await callUpstreamFast({
          model, temperature: 0.68, max_tokens: 420, // 适度补写
          messages: [
            { role:'system', content: '继续保持相同风格与语气；只补充新信息，避免重复；总长度控制在 500–1000 字；输出纯正文。' },
            { role:'user',   content: `在这段文字基础上补充一段，使总长度达到 500–1000 字，并加入 1 个可核验细节（时间/版本/编号/tx 片段）：\n\n${clean}` }
          ],
          signal: controller2.signal
        });
        clearTimeout(to2);
        const add = String(more?.choices?.[0]?.message?.content ?? more?.output_text ?? '').trim();
        if (add) clean = `${clean}\n\n${add}`.trim();
      } catch(_) {} // 忽略补齐失败
    }

    // 超长就软裁到 1000 字附近
    if (clean.length > 1100) clean = softTrimBody(clean, 1000);

    const sOut = sanitizeOut(clean, token);

    const payload = ok(trace_id, {
      id: data?.id,
      model: data?.model || model,
      title: sOut.title,
      text:  sOut.text,
      tags:  Array.from(new Set([...(context?.tags||[])]))
                .map(s => String(s).replace(/^#/,'').toLowerCase())
                .filter(Boolean).slice(0, 2),
      tickers: Array.from(new Set([token.toUpperCase(), ...(context?.tickers||[])]))
                .map(s => String(s).replace(/^\$/,'').toUpperCase())
                .filter(Boolean).slice(0, 1),
      mentions: Array.from(new Set([...(context?.mentions||[])]))
                .map(s => String(s).replace(/^@/,''))
                .filter(Boolean).slice(0, 1),
      usage: data?.usage || null,
      flags: { mode: 'fast-500-1000', timeout_ms: TIMEOUT_MS, length: sOut.text.length }
    });
    payload.data = { title: payload.title, text: payload.text, tags: payload.tags };

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders() });

  } catch (e) {
    const message = (e && e.name === 'AbortError') ? 'Upstream timeout' : String(e?.message || e);
    const code = (e && e.name === 'AbortError') ? 'ERR_TIMEOUT' : 'ERR_UPSTREAM';
    return new Response(JSON.stringify(err(traceId(req), code, message)), {
      status: 500, headers: corsHeaders(),
    });
  }
}
