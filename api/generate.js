// /api/generate —— v1.1 模式化长度控制（article 900–1200；short 140–280）
// 兼容旧入参（不破坏你现有调用），新增：mode / min_chars / max_chars / postKind
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
const TIMEOUT_MS     = 25000; // 25s：先于平台超时，避免 504
const MODEL_DEFAULT  = 'meta-llama/llama-3.1-8b-instruct';

const DEDUP_PHRASES_ZH = [
  '点赞关注','一键三连','欢迎私信','带你了解','冲冲冲','不构成投资建议',
  '一定要看','别再错过','爆赚','财富自由','总结来说','综上所述','最后我们来看',
  '赶紧','速看','建议收藏','分享给朋友'
];
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
  const m = cut.match(/.*?[。！？.!?：:；;,，、]/);
  if (m && m[0].length >= Math.max(6, limit * 0.6)) {
    return m[0].replace(/[：:；;,，、]$/,'');
  }
  return cut.replace(/[\s\-_/,:;，。！？!?.]+$/,'').trim();
}

/* -------------------- 标题：从正文抽一句 + 模板随机 -------------------- */
function pickTitleCandidate(body='', token='', outline=''){
  const lines = String(body).split(/\n+/).filter(Boolean);
  const sentences = (lines.join(' ')).split(/[。！？.!?]/).map(s=>s.trim()).filter(Boolean);
  const r1 = sentences.find(s => new RegExp(`\\b${token}\\b`, 'i').test(s));
  if (r1) return r1;
  if (outline) {
    const key = String(outline).split(/[，,。；;：:\s]/)[0] || outline;
    const r2 = sentences.find(s => s.includes(key));
    if (r2) return r2;
  }
  return sentences[0] || (lines[0] || '').slice(0, 24);
}
const TITLE_TEMPLATES = [
  (k, p)=>`${k}：${p}`,
  (k, p)=>`${k}观察｜${p}`,
  (k, p)=>`${p}（${k}）`,
  (k, p)=>`${k}要点：${p}`,
  (k, p)=>`${k}进展速记｜${p}`,
  (k, p)=>`${k}｜${p}`,
];
function makeTitleFrom(body, token, outline){
  const MAX = 48;
  const base = pickTitleCandidate(body, token, outline).replace(/[#*$@>\-]/g,'').trim();
  let tpl = TITLE_TEMPLATES[(Math.random()*TITLE_TEMPLATES.length)|0];
  let title = tpl(token, smartClip(base, Math.max(10, MAX-6)));
  if (title.length > MAX) title = title.slice(0, MAX);
  return title;
}

/* -------------------- 正文清洗 + 标题生成 -------------------- */
function sanitizeOut(bodyText='', token='') {
  let text = String(bodyText||'').replace(/\r/g,'').trim();
  text = stripMarketing(text);
  text = limitEmoji(text);
  text = dedupSentences(text);
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  const MAX_TITLE = 48;
  let title = makeTitleFrom(text, token, (globalThis.__LAST_OUTLINE__ || ''));
  if (!title.trim()) title = `${token} 更新`;
  if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE);

  const h = hashStr(title.toLowerCase());
  if (RECENT.includes(h)) {
    const tweak = ['快评','观察','要点','随记'][Math.floor(Math.random()*4)];
    title = (title + '｜' + tweak).slice(0, MAX_TITLE);
  }
  RECENT.unshift(h); if (RECENT.length > 50) RECENT.pop();

  return { title, text };
}

/* -------------------- System / User（按模式生成） -------------------- */
function buildSystemByMode({ token='BTC', language='zh', outline='', mode='article', min=900, max=1200 }) {
  const zh   = (language||'zh').toLowerCase().startsWith('zh');
  const tone = pick(TONES);
  if (zh) {
    if (mode === 'short') {
      return [
        tone,
        `输出一条中文短贴，**总长度严格控制在 ${min}–${max} 字**（汉字计数），建议 1–2 段，语气自然克制。`,
        `只围绕 ${token} 的一个清晰要点展开；可包含 1 个可核验细节（时间/版本/编号/tx 片段）。`,
        outline ? `尽量围绕「${outline}」展开；如无把握给出查验路径。` : '',
        '禁止价格预测/点位/K线；禁止口号与营销腔。',
        `输出**纯正文**，不要任何 JSON/列表/代码块。`
      ].filter(Boolean).join('\n');
    } else {
      return [
        tone,
        `输出一篇中文文章，**总长度严格控制在 ${min}–${max} 字**（汉字计数），分 3–5 段，每段 ≥150 字。`,
        `只围绕 ${token} 的一个明确主题展开；包含 1–2 个可核验细节（时间/版本/编号/tx 片段）。`,
        outline ? `尽量围绕「${outline}」展开；如无把握给出查验路径。` : '',
        '禁止价格预测/点位/K线；禁止口号与营销腔。',
        '输出**纯正文**，不要任何 JSON/列表/代码块。'
      ].filter(Boolean).join('\n');
    }
  }
  // 英文分支（如需）
  if (mode === 'short') {
    return [
      'Calm, natural, non-promotional tone.',
      `Write a short Chinese post **${min}-${max} chars**, 1–2 short paragraphs.`,
      `Focus strictly on ${token}, include one verifiable detail (time/version/id/tx snippet).`,
      outline ? `Prefer focusing on: ${outline}` : '',
      'No TA/price targets; output plain text only.'
    ].filter(Boolean).join('\n');
  }
  return [
    'Calm, natural, non-promotional tone.',
    `Write a Chinese article **${min}-${max} chars**, 3–5 paragraphs, each ≥150 chars.`,
    `Focus strictly on ${token}, include 1–2 verifiable details (time/version/id/tx snippet).`,
    outline ? `Prefer focusing on: ${outline}` : '',
    'No TA/price targets; output plain text only.'
  ].filter(Boolean).join('\n');
}
function buildUserFast({ prompt='', language='zh' }) {
  const zh = (language||'zh').toLowerCase().startsWith('zh');
  return zh ? (prompt || '来一段自然的人性化分析。') : (prompt || 'A short human-like analysis.');
}

/* -------------------- 上游调用 -------------------- */
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
      max_tokens: clamp(Number(max_tokens)||0, 1, 1600) // article 也能容纳
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

/* -------------------- 小工具：是否以句末标点结束 -------------------- */
function endsWithPunct(s=''){
  return /[。！？.!?」”’)\]]\s*$/.test(String(s).trim());
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

    // —— 新增：mode / min_chars / max_chars；并兼容旧字段 postKind/context.postKind
    const postKind = body.postKind || body.mode || body.kind || body?.context?.postKind || 'article';
    const mode = (/short/i.test(postKind) ? 'short' : 'article');
    // 缺省长度：文章 900–1200；短贴 140–280
    const MIN_DEFAULT = (mode === 'short' ? 140 : 900);
    const MAX_DEFAULT = (mode === 'short' ? 280 : 1200);

    const {
      prompt = '',
      system = '',
      model = MODEL_DEFAULT,
      temperature = (mode === 'short' ? 0.72 : 0.68),
      max_tokens  = (mode === 'short' ? 360 : 1600),
      lang = 'zh',
      token = 'BTC',
      context = {},
      min_chars = MIN_DEFAULT,
      max_chars = MAX_DEFAULT
    } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify(err(trace_id, 'ERR_INPUT', 'Invalid \"prompt\"')), {
        status: 400, headers: corsHeaders(),
      });
    }

    const min = clamp(Number(min_chars)||0, 40, 3000);
    const max = Math.max(min + 40, clamp(Number(max_chars)||0, min+40, 4000));

    // System / User（带 outline 提示）
    const outlineHint = (context?.outline || '').trim();
    globalThis.__LAST_OUTLINE__ = outlineHint; // 提供给标题生成使用
    const sysText = [
      system,
      buildSystemByMode({ token, language: lang, outline: outlineHint, mode, min, max })
    ].filter(Boolean).join('\n\n');
    const usrText = buildUserFast({ prompt, language: lang });

    // —— 第一次生成（25s 总预算）
    const startTs = Date.now();
    const leftMs  = () => Math.max(0, TIMEOUT_MS - (Date.now() - startTs) - 1200);

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

    // 软裁函数
    function softTrimBody(s='', limit=1000){
      if (s.length <= limit) return s;
      const cut = s.slice(0, limit);
      const m = cut.match(/.*?[。！？.!?]/);
      return (m ? m[0] : cut).replace(/\s+$/,'').trim();
    }

    // —— 若短于 min，尝试“补齐一次”（文章力度更大，短贴也补但更短）
    if (clean.length < min && leftMs() > 6000) {
      try {
        const controller2 = new AbortController();
        const to2 = setTimeout(()=>controller2.abort(), leftMs());
        const more = await callUpstreamFast({
          model, temperature: (mode==='short'? 0.72 : 0.66), max_tokens: (mode==='short'? 240 : 480),
          messages: [
            { role:'system', content: `延续同一风格；只补充新信息避免重复；总长度控制在 ${min}–${max} 字；输出纯正文。` },
            { role:'user',   content: `在这段文字基础上补写，使总长度达到 ${min}–${max} 字：\n\n${clean}` }
          ],
          signal: controller2.signal
        });
        clearTimeout(to2);
        const add = String(more?.choices?.[0]?.message?.content ?? more?.output_text ?? '').trim();
        if (add) clean = `${clean}\n\n${add}`.trim();
      } catch(_) {}
    }

    // —— 若结尾未收口且还有预算，再补 1–2 句
    if (!endsWithPunct(clean)) {
      const budget = leftMs();
      if (budget > 4500) {
        try {
          const controller3 = new AbortController();
          const to3 = setTimeout(()=>controller3.abort(), Math.min(4000, budget-800));
          const more2 = await callUpstreamFast({
            model, temperature: (mode==='short'? 0.7 : 0.66), max_tokens: (mode==='short'? 120 : 180),
            messages: [
              { role:'system', content: '只续写 1–2 句把上文收尾；不重复已写内容；输出纯正文。' },
              { role:'user',   content: `延续并完整收尾这段话的最后一句：\n\n${clean.slice(-260)}` }
            ],
            signal: controller3.signal
          });
          clearTimeout(to3);
          const add2 = String(more2?.choices?.[0]?.message?.content ?? more2?.output_text ?? '').trim();
          if (add2) clean = `${clean}${add2}`;
        } catch(_) {}
      } else {
        clean = clean.replace(/\s*$/, '。');
      }
    }

    // 超长软裁到 max
    if (clean.length > max) clean = softTrimBody(clean, max);

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
      flags: { mode, timeout_ms: TIMEOUT_MS, length: sOut.text.length, range: [min, max] }
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
