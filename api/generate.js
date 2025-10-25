// /api/generate —— 学习模式 + 校验修复 + 可观测（Vercel Edge）
// 环境变量：
// - OPENROUTER_KEY (必需)
// - OR_HTTP_REFERER / OR_X_TITLE (可选，用于统计归因)
// - JSON_MODE=1 （可选；上游支持 json_object 时强制 JSON 输出）
// - KV_REST_URL / KV_REST_TOKEN （可选；Upstash/Redis REST 用于持久化学习状态）
//
// 返回结构兼容前端：顶层含 { title, text, tags, ... }，并镜像到 data:{title,text,tags}

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

/* -------------------- 常量 / 工具 -------------------- */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 35000;                 // 放宽 35s，减少高峰期超时
const JSON_MODE = (process.env.JSON_MODE === '1');

const DEDUP_PHRASES_ZH = [
  '点赞关注','一键三连','欢迎私信','带你了解','冲冲冲','不构成投资建议','强烈建议',
  '一定要看','别再错过','爆赚','财富自由','总结来说','综上所述','最后我们来看',
  '赶紧','速看','建议收藏','分享给朋友'
];

const FORMAT_HINTS_ZH = [
  { name:'清单体',   hint:'3–6 条；用“- ”开头；每条 ≤30 字' },
  { name:'问答体',   hint:'Q: 两到三问；A: 简洁回应（≤3 轮）' },
  { name:'三段式',   hint:'用“---”分隔：现状｜问题｜建议' },
  { name:'引用开场', hint:'首行用“> …”引出；后续自然段' },
  { name:'对话体',   hint:'甲：… 乙：…（≤6 轮）' },
  { name:'小词典',   hint:'4 条：术语：一句话解释' },
];

const PERSONAS_ZH = [
  '老练的链上观察者','理性的交易复盘者','面向新手的解释者','协议细节党'
];

const TA_PATTERNS = [/均线|K线|支撑位|压力位|目标价|抄底|拉盘|做多|做空|止损|点位/];
const VERIFIABLE_PATTERNS = [
  /0x[a-fA-F0-9]{6,}/,                 // tx/hash 片段
  /\bblock\s?#?\d{4,}\b/i,             // 块高
  /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/ // 时间戳
];

const ERR = {
  INPUT: 'ERR_INPUT',
  UPSTREAM: 'ERR_UPSTREAM',
  PARSE: 'ERR_PARSE',
  TIMEOUT: 'ERR_TIMEOUT',
  VALID: 'ERR_VALIDATION',
  RATE: 'ERR_RATE_LIMIT',
};

const ok  = (trace_id, data) => ({ ok: true, trace_id, ...data });
const err = (trace_id, code, message, extra={}) => ({ ok: false, trace_id, code, message, ...extra });

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const pick  = (arr) => arr[(Math.random()*arr.length)|0];
const uniq  = (arr) => Array.from(new Set((arr||[]).filter(Boolean)));

/* 轻度 hash（标题去重） */
function hashStr(s=''){ let h=2166136261>>>0; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619) } return (h>>>0).toString(36); }

/* Trace 与轻量限流（每 IP） */
function traceId(req) {
  const fromHeader = req.headers.get('X-Request-ID');
  if (fromHeader) return String(fromHeader).slice(0,64);
  const arr = new Uint8Array(16); crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
}
const RATE = { BURST: 8, REFILL_MS: 8000 }; // 8 请求/8秒
globalThis.__BP_BUCKET = globalThis.__BP_BUCKET || new Map();
function rateLimit(key) {
  const now = Date.now();
  const b = globalThis.__BP_BUCKET.get(key) || { tokens: RATE.BURST, ts: now };
  const elapsed = now - b.ts;
  const refill = Math.floor(elapsed / RATE.REFILL_MS);
  if (refill > 0) { b.tokens = Math.min(RATE.BURST, b.tokens + refill); b.ts = now; }
  if (b.tokens <= 0) { globalThis.__BP_BUCKET.set(key, b); return false; }
  b.tokens -= 1; globalThis.__BP_BUCKET.set(key, b); return true;
}

/* JSON 提取与清洗 */
function extractJson(text='') {
  if (!text) return null;
  const direct = text.trim();
  try { return JSON.parse(direct); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  const stripped = direct.replace(/^```(?:json)?\s*/i,'').replace(/```$/, '');
  try { return JSON.parse(stripped); } catch {}
  return null;
}

function limitEmoji(s='') {
  // 最多 2 个 emoji
  const arr = Array.from(s);
  let count = 0;
  return arr.map(ch=>{
    if (/\p{Emoji_Presentation}/u.test(ch)) return (++count <= 2) ? ch : '';
    return ch;
  }).join('');
}

function sanitizeOut(p = {}, token = '') {
  let title = (p.title || '').toString().trim().replace(/\s+/g,' ');
  if (!title) {
    const first = (p.body || p.text || '').toString().trim().split('\n')[0] || '';
    title = `${token}｜${first.replace(/[#*$@>\-]/g,'').slice(0, 24)}`.trim();
  }
  if (title.length > 48) title = title.slice(0,48);

  let body = (p.body || p.text || '').toString();
  for (const phrase of DEDUP_PHRASES_ZH) body = body.replace(new RegExp(phrase, 'g'), '');
  body = limitEmoji(body).replace(/\n{3,}/g, '\n\n').trim();

  const hashtags = uniq((p.hashtags || p.tags || []).map(s => s.toString().replace(/^#/,'').toLowerCase())).slice(0,2);
  const tickers  = uniq((p.tickers || []).map(s => s.toString().replace(/^\$/,'').toUpperCase())).slice(0,1);
  const mentions = uniq((p.mentions || []).map(s => s.toString().replace(/^@/,''))).slice(0,1);

  return {
    title,
    text: body,
    tags: hashtags,
    tickers,
    mentions,
    verifiable_detail: (p.verifiable_detail || '').toString().trim()
  };
}

/* -------------------- 学习存储（可选持久化） -------------------- */
/** state 结构：
{
  tokens: {
    [TOKEN]: {
      topicStats: { [topicText]: count },
      formatStats: { [formatName]: count },
      recentTitles: string[]
    }
  },
  updatedAt: number
}
*/
const STATE_KEY = 'bp_state_v1';

async function kvGet() {
  const url = process.env.KV_REST_URL, token = process.env.KV_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${STATE_KEY}`, { headers:{ Authorization:`Bearer ${token}` }});
    if (!r.ok) return null;
    const j = await r.json();
    return j?.result ? JSON.parse(j.result) : null;
  } catch { return null; }
}
async function kvSet(obj) {
  const url = process.env.KV_REST_URL, token = process.env.KV_REST_TOKEN;
  if (!url || !token) return false;
  try {
    await fetch(`${url}/set/${STATE_KEY}`, {
      method:'POST',
      headers:{ Authorization:`Bearer ${token}`, 'content-type':'application/json' },
      body: JSON.stringify(obj)
    });
    return true;
  } catch { return false; }
}
async function loadState() {
  if (!globalThis.__BP_STATE) {
    globalThis.__BP_STATE = (await kvGet()) || { tokens:{}, updatedAt: Date.now() };
  }
  return globalThis.__BP_STATE;
}
async function saveState(state) {
  globalThis.__BP_STATE = state;
  await kvSet(state).catch(()=>{});
}

function minUsagePick(state, token, list, statKey) {
  if (!list?.length) return { item:null, idx:0 };
  state.tokens[token] ||= { topicStats:{}, formatStats:{}, recentTitles:[] };
  const stats = state.tokens[token][statKey] || {};
  let best = null; let bestCount = Infinity; let bestIdx = 0;
  list.forEach((item, idx) => {
    const k = typeof item === 'string' ? item : item.name;
    const c = stats[k] || 0;
    if (c < bestCount) { best = item; bestCount = c; bestIdx = idx; }
  });
  const keyName = typeof best === 'string' ? best : best.name;
  stats[keyName] = (stats[keyName] || 0) + 1;
  state.tokens[token][statKey] = stats;
  return { item: best, idx: bestIdx };
}

function rememberTitle(state, token, title, N=40) {
  state.tokens[token] ||= { topicStats:{}, formatStats:{}, recentTitles:[] };
  const arr = state.tokens[token].recentTitles || [];
  arr.unshift(hashStr((title||'').toLowerCase()));
  while (arr.length > N) arr.pop();
  state.tokens[token].recentTitles = uniq(arr);
}
function titleSeen(state, token, title) {
  const arr = state.tokens[token]?.recentTitles || [];
  return arr.includes(hashStr((title||'').toLowerCase()));
}

/* -------------------- 提示词拼装 -------------------- */
function buildSystem({ token='BTC', language='zh', persona, formatHint }) {
  const zh = (language||'zh').toLowerCase().startsWith('zh');
  const personaLine = zh
    ? `你是${persona || pick(PERSONAS_ZH)}，口吻克制、专业、人话，不要营销腔。`
    : `You are a ${persona || 'seasoned on-chain observer'}, calm and professional.`;

  const tokenFocus = zh ? [
    `输出严格围绕 ${token}；不要写价格预测/点位/传统 TA（K线）。`,
    `从下列维度任选 2–3 个展开：`,
    `· 协议职责/架构模块（模块/函数/角色名称）`,
    `· 代币经济（用途/发行/销毁/治理最小闭环）`,
    `· 生态集成（钱包/桥/基础设施/数据源/合作方）`,
    `· 近 3 个月里程碑/提案（编号/名称；不确定就给验证路径）`,
    `· 风险与边界（权限/依赖/可升级性）`,
    `事实约束：不编造具体数据/时间；不确定时写“验证路径”。`,
  ].join('\n') : [
    `Focus strictly on ${token}. No price predictions or TA.`,
    `Pick 2–3 aspects: protocol modules, token economics, ecosystem integrations, recent milestones (IDs), risks & limits.`,
    `If unsure about facts, provide a verification path.`,
  ].join('\n');

  const schemaHint = zh ? `
只用合法 JSON 回复，结构：
{
  "title": "string (<=48)",
  "body": "string（中文，口语化、专业，不要口号）",
  "hashtags": ["0-2, no #"],
  "tickers": ["0-1, token symbol like ${token}, no $"],
  "mentions": ["0-1, slug, no @"],
  "verifiable_detail": "一个可验证细节（例：tx hash 末6位、准确时间、block id）"
}` : `
Reply ONLY with JSON:
{
  "title": "string (<=48)",
  "body": "string (conversational, professional, no slogans)",
  "hashtags": ["0-2, no #"],
  "tickers": ["0-1, symbol like ${token}, no $"],
  "mentions": ["0-1, slug, no @"],
  "verifiable_detail": "one verifiable detail (e.g., tx hash last6, exact time, block id)"
}`;

  const formatLine = zh
    ? `格式可选：清单 / Q&A / 分隔线(---) / 引用(>) / 对话体 / 小词典；随机提示：${formatHint?.name}｜${formatHint?.hint}`
    : `Formatting allowed: list / Q&A / --- separators / quote / dialogue / glossary; random hint: ${formatHint?.name} | ${formatHint?.hint}`;

  return [personaLine, tokenFocus, formatLine, schemaHint].join('\n\n');
}

function buildUser({ prompt='', outline='', topic='', language='zh' }) {
  const zh = (language||'zh').toLowerCase().startsWith('zh');
  const scaff = zh
    ? `结构建议：开场1句 -> 证据1-2句（含可验证细节）-> 为什么重要1句。避免“总结/欢迎关注”等收尾。`
    : `Suggested structure: 1-sentence hook -> 1-2 sentences of evidence (with a verifiable detail) -> 1 sentence on why it matters. No CTA endings.`;

  const focus = [
    topic ? (zh ? `本次话题：${topic}` : `Topic: ${topic}`) : '',
    outline ? (zh ? `题库聚焦：\n${outline}` : `Topic bank focus:\n${outline}`) : ''
  ].filter(Boolean).join('\n\n');

  return [prompt, focus, scaff].filter(Boolean).join('\n\n');
}

/* -------------------- 上游调用（重试+超时） -------------------- */
async function withRetries(fn, tries=3, base=250) {
  let last;
  for (let i=0;i<tries;i++){
    try { return await fn(); }
    catch(e){ last=e; if (i<tries-1) await new Promise(r=>setTimeout(r, base*Math.pow(2,i))); }
  }
  throw last;
}

async function callUpstreamJSON({ model, messages, temperature, max_tokens, signal }) {
  const OR_KEY = process.env.OPENROUTER_KEY;
  const referer = process.env.OR_HTTP_REFERER || 'https://your-app.example';
  const titleHdr = process.env.OR_X_TITLE || 'BinancePoster-Proxy';

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
      top_p: 0.95,
      frequency_penalty: 0.2,
      presence_penalty: 0.15,
      max_tokens: clamp(Number(max_tokens)||0, 1, 2000),
      ...(JSON_MODE ? { response_format: { type: 'json_object' } } : {})
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

/* -------------------- 轻校验 + 修复 -------------------- */
function detectFormatKind(t='') {
  if (/^\s*-\s+\S+/m.test(t)) return 'list';
  if (/^Q:\s.*$/m.test(t) && /^A:\s.*$/m.test(t)) return 'qa';
  if (/^>/m.test(t)) return 'quote';
  if (/^\s*-{3,}\s*$/m.test(t)) return 'separator';
  if (/甲：|乙：/.test(t)) return 'dialogue';
  return 'paragraph';
}
function validateOutput(out, token) {
  const text = (out.text || '').toString();
  const title = (out.title || '').toString();
  const full  = `${title}\n${text}`;

  const tokenRegex = new RegExp(`\\b${token}\\b`, 'i');
  const token_mentioned = tokenRegex.test(full) || (out.tickers||[]).includes(token.toUpperCase());
  const includes_verifiable_detail = VERIFIABLE_PATTERNS.some(r=>r.test(full));
  const ta_violation = TA_PATTERNS.some(r=>r.test(full));
  const format_kind = detectFormatKind(text);

  const reasons = [];
  if (!token_mentioned) reasons.push('no_token_focus');
  if (!includes_verifiable_detail) reasons.push('no_verifiable_detail');
  if (ta_violation) reasons.push('ta_detected');

  return {
    ok: reasons.length === 0,
    reasons, token_mentioned, includes_verifiable_detail, format_kind, ta_violation
  };
}
function buildRepairMessage(out, token, reasons, language='zh') {
  const zh = (language||'zh').startsWith('zh');
  const issues = reasons.map(r=>{
    if (r==='no_token_focus') return zh?'缺少 Token 聚焦':'missing token focus';
    if (r==='no_verifiable_detail') return zh?'缺少可验证细节':'missing verifiable detail';
    if (r==='ta_detected') return zh?'包含 TA/点位':'contains TA';
    return r;
  }).join('；');

  const base = zh
    ? `你刚才的输出存在问题：${issues}。在不改变口吻的情况下，最小改动修复这些问题；仍只返回 JSON（同一结构）。Token: ${token}。`
    : `Your output had issues: ${issues}. Keep the tone, minimally fix to address them; return JSON only (same schema). Token: ${token}.`;
  const content = typeof out === 'string' ? out : JSON.stringify(out);
  return `${base}\n\n原输出：\n${content}`;
}

/* -------------------- 主处理 -------------------- */
export default async function handler(req) {
  // 预检
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify(err('-', ERR.INPUT, 'Method Not Allowed')), {
      status: 405, headers: corsHeaders(),
    });
  }

  const trace_id = traceId(req);
  const ipKey = req.headers.get('x-forwarded-for') || '0.0.0.0';
  if (!rateLimit(`${ipKey}`)) {
    return new Response(JSON.stringify(err(trace_id, ERR.RATE, 'Too many requests')), { status: 429, headers: corsHeaders() });
  }

  try {
    const OR_KEY = process.env.OPENROUTER_KEY;
    if (!OR_KEY) {
      return new Response(JSON.stringify(err(trace_id, ERR.INPUT, 'Missing OPENROUTER_KEY')), {
        status: 500, headers: corsHeaders(),
      });
    }

    const body = await req.json().catch(()=> ({}));
    const {
      prompt = '',
      system = '',
      model = 'meta-llama/llama-3.1-8b-instruct',
      temperature = 0.85,            // 提高多样化
      max_tokens = 900,
      lang = 'zh',
      token = 'BTC',
      ptype = 'short',
      context = {} // { outline, topic_bank, tags, mentions, styleMeta }
    } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify(err(trace_id, ERR.INPUT, 'Invalid "prompt"')), { status: 400, headers: corsHeaders() });
    }

    // 学习状态加载
    const state = await loadState();
    state.tokens ||= {};
    state.tokens[token] ||= { topicStats:{}, formatStats:{}, recentTitles:[] };

    // 话题池：优先 topic_bank；否则把 outline 的每行切成条目
    let topicBank = Array.isArray(context.topic_bank) ? context.topic_bank.filter(Boolean) : [];
    if (!topicBank.length && context.outline) {
      topicBank = String(context.outline).split(/\n+/).map(s=>s.replace(/^[-•\s]+/,'').trim()).filter(Boolean);
    }
    if (!topicBank.length) {
      topicBank = [
        '近期里程碑/提案影响与验证路径',
        '协议职责与代币在其中的角色',
        '生态集成（钱包/桥/基础设施）典型场景',
        '风险与边界（权限/依赖/可升级性）'
      ];
    }

    // 轮转（最少使用优先）
    const { item: topicUsed }  = minUsagePick(state, token, topicBank, 'topicStats');
    const { item: formatUsed } = minUsagePick(state, token, FORMAT_HINTS_ZH, 'formatStats');

    // System / User
    const sysComposed = buildSystem({
      token,
      language: lang,
      persona: context?.styleMeta?.persona,
      formatHint: formatUsed || pick(FORMAT_HINTS_ZH)
    });
    const userComposed = buildUser({
      prompt,
      outline: context?.outline || '',
      topic: topicUsed || '',
      language: lang
    });

    // 消息体
    const messages = [];
    const sys = [system, sysComposed].filter(Boolean).join('\n\n');
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push({ role: 'user', content: String(userComposed) });

    // 调上游（带超时+重试）
    const controller = new AbortController();
    const to = setTimeout(()=>controller.abort(), TIMEOUT_MS);
    const data = await withRetries(
      () => callUpstreamJSON({ model, messages, temperature, max_tokens, signal: controller.signal }),
      3, 250
    );
    clearTimeout(to);

    // 解析输出（优先 JSON）
    const raw = data?.choices?.[0]?.message?.content ?? data?.output_text ?? '';
    const parsed = typeof raw === 'string' ? extractJson(raw) : (raw || {});
    let out = sanitizeOut(parsed || {}, token);

    // 强制补齐 token 标签/提及（与前端策略兼容）
    out.tags     = uniq([...(out.tags||[]), ...(context?.tags||[]), token.toLowerCase()]).slice(0,2);
    out.tickers  = uniq([token.toUpperCase(), ...(out.tickers||[])]).slice(0,1);
    out.mentions = uniq([...(out.mentions||[]), ...(context?.mentions||[])]).slice(0,1);

    // 校验
    let flags = validateOutput(out, token);

    // 自动修复（最多 2 次）
    let repaired_attempts = 0;
    while (!flags.ok && repaired_attempts < 2) {
      repaired_attempts++;
      const repairUser = buildRepairMessage(out, token, flags.reasons, lang);
      const repairMessages = [
        { role:'system', content: 'Return ONLY valid JSON with the same schema.' },
        { role:'user',   content: repairUser }
      ];
      const j = await callUpstreamJSON({
        model, messages: repairMessages,
        temperature: Math.max(0.4, Number(temperature)-0.1),
        max_tokens
      });
      const raw2 = j?.choices?.[0]?.message?.content ?? j?.output_text ?? '';
      const parsed2 = typeof raw2 === 'string' ? extractJson(raw2) : (raw2 || {});
      const out2 = sanitizeOut(parsed2 || {}, token);
      if ((out2.text||'').length >= 32) out = out2;
      flags = validateOutput(out, token);
    }

    // 标题去重（同 Token 最近 40 条）
    if (titleSeen(state, token, out.title)) {
      const tweak = topicUsed ? `｜${String(topicUsed).slice(0,8)}` : `｜${formatUsed?.name || '更新'}`;
      out.title = (out.title + tweak).slice(0,48);
    }
    rememberTitle(state, token, out.title);

    // 存回学习状态（KV 可选）
    state.updatedAt = Date.now();
    await saveState(state);

    // 回包（顶层字段 + data 镜像，兼容旧前端）
    const payload = ok(trace_id, {
      id: data?.id,
      model: data?.model || model,
      title: out.title,
      text: out.text,
      tags: out.tags,            // 不带 '#'
      tickers: out.tickers,      // 不带 '$'
      mentions: out.mentions,    // 不带 '@'
      verifiable_detail: out.verifiable_detail,
      topic_used: topicUsed || null,
      format_hint: formatUsed?.name || null,
      usage: data?.usage || null,
      flags: {
        repaired_attempts,
        token_mentioned: flags.token_mentioned,
        includes_verifiable_detail: flags.includes_verifiable_detail,
        format_kind: flags.format_kind,
        ta_violation: !!flags.ta_violation,
        needs_review: !flags.ok || !!flags.ta_violation
      },
      warnings: JSON_MODE ? [] : ['json_mode_off: best-effort JSON extraction']
    });

    // 镜像 data 以兼容前端的 (j.data || j) 解析
    payload.data = { title: payload.title, text: payload.text, tags: payload.tags };

    return new Response(JSON.stringify(payload), { status: 200, headers: corsHeaders() });

  } catch (e) {
    const message = (e && e.name === 'AbortError') ? 'Upstream timeout' : String(e?.message || e);
    const code = (e && e.name === 'AbortError') ? ERR.TIMEOUT : ERR.UPSTREAM;
    return new Response(JSON.stringify(err(traceId(req), code, message)), {
      status: 500, headers: corsHeaders(),
    });
  }
}
