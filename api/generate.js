// /api/generate —— 学习模式版（Vercel Edge）
// 兼容你当前前端；可直接替换本文件。
// 环境变量：
// - OPENROUTER_KEY (必需)
// - OR_HTTP_REFERER / OR_X_TITLE (可选，用于统计)
// - JSON_MODE=1      （可选，若上游支持 json_object 则开启）
// - KV_REST_URL / KV_REST_TOKEN （可选，Upstash/Redis REST；用于跨实例持久化学习状态）

export const config = { runtime: 'edge' };

/* -------------------- CORS -------------------- */
function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'content-type': 'application/json; charset=utf-8',
  };
}

/* -------------------- 小工具 -------------------- */
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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 18000;
const JSON_MODE = (process.env.JSON_MODE === '1');

/* 选取与打乱 */
const pick = (arr) => arr[(Math.random()*arr.length)|0];
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const uniq  = (arr) => Array.from(new Set(arr.filter(Boolean)));
const shuffle = (arr) => arr.slice().sort(()=>Math.random()-0.5);

/* 简易 hash（用于种子/去重） */
function hashStr(s=''){ let h=2166136261>>>0; for (let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619) } return (h>>>0).toString(36); }

/* 提取/修复 JSON */
function extractJson(text='') {
  if (!text) return null;
  const direct = text.trim();
  try { return JSON.parse(direct); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  const stripped = direct.replace(/^```(?:json)?\s*/i,'').replace(/```$/,'');
  try { return JSON.parse(stripped); } catch {}
  return null;
}

/* 输出清洗与钳制 */
function sanitizeOut(p = {}, token = '') {
  let title = (p.title || '').toString().trim().replace(/\s+/g,' ');
  if (!title) {
    const first = (p.body || p.text || '').toString().trim().split('\n')[0] || '';
    // 兜底标题：Token + 主题片段
    title = `${token}｜${first.replace(/[#*$@>\-]/g,'').slice(0, 24)}`.trim();
  }
  if (title.length > 48) title = title.slice(0,48);

  let body = (p.body || p.text || '').toString();
  for (const phrase of DEDUP_PHRASES_ZH) body = body.replace(new RegExp(phrase, 'g'), '');
  body = body.replace(/\n{3,}/g, '\n\n').trim();

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

/* -------------------- 学习存储（轻） -------------------- */
/** 结构：{ tokens: { [TOKEN]: { topicIdx, formatIdx, recentTitles: string[] } }, updatedAt } */
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
  // 1) 先用全局内存（同 Region 复用）
  if (!globalThis.__BP_STATE) {
    globalThis.__BP_STATE = (await kvGet()) || { tokens:{}, updatedAt: Date.now() };
  }
  return globalThis.__BP_STATE;
}
async function saveState(state) {
  globalThis.__BP_STATE = state;
  // 尝试落到 KV（可选）
  await kvSet(state).catch(()=>{});
}

/* 轮转选择：基于 state 的循环与去重 */
function rotatePick(state, token, list, key) {
  if (!list || !list.length) return { item: null, idx: 0 };
  state.tokens[token] ||= { topicIdx:0, formatIdx:0, recentTitles:[] };
  const idx = (state.tokens[token][key] || 0) % list.length;
  state.tokens[token][key] = (idx + 1) % list.length;
  return { item: list[idx], idx };
}

/* 标题去重（记忆近 N 条） */
function rememberTitle(state, token, title, N=40) {
  state.tokens[token] ||= { topicIdx:0, formatIdx:0, recentTitles:[] };
  const arr = state.tokens[token].recentTitles || [];
  arr.unshift(hashStr(title.toLowerCase()));
  while (arr.length > N) arr.pop();
  state.tokens[token].recentTitles = uniq(arr);
}
function titleSeen(state, token, title) {
  const arr = state.tokens[token]?.recentTitles || [];
  return arr.includes(hashStr(title.toLowerCase()));
}

/* -------------------- 提示词拼装 -------------------- */
function buildSystem({ token='BTC', language='zh', persona, formatHint }) {
  const zh = (language||'zh').toLowerCase().startsWith('zh');
  const personaLine = zh
    ? `你是${persona || pick(PERSONAS_ZH)}，口吻克制、专业、人话，不要营销腔。`
    : `You are a ${persona || 'seasoned on-chain observer'}, calm and professional.`;

  const tokenFocus = zh ? [
    `输出围绕 ${token}，不要写价格预测/点位/纯技术分析（K线）。`,
    `Token 聚焦：从下列维度任选 2–3 个展开：`,
    `· 协议职责/架构模块（模块/函数/角色名称）`,
    `· 代币经济（用途/发行/销毁/治理最小闭环）`,
    `· 生态集成（钱包/桥/基础设施/数据源/合作方）`,
    `· 近 3 个月里程碑/提案（编号/名称；不确定就给验证路径）`,
    `· 风险与边界（权限/依赖/合规/可升级性）`,
    `事实约束：不编造具体数据/时间；不确定时写“验证方法/路径”。`,
  ].join('\n') : [
    `Focus strictly on ${token}. No price predictions or TA.`,
    `Pick 2–3 aspects: protocol modules, token economics, ecosystem integrations, recent milestones (last 3 months, with IDs), risks & limits.`,
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
  "verifiable_detail": "one verifiable detail (e.g., tx hash last6, precise time, block id)"
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
    topic ? (zh ? `本次话题：${topic}` : `Topic for this turn: ${topic}`) : '',
    outline ? (zh ? `题库聚焦：\n${outline}` : `Topic bank focus:\n${outline}`) : ''
  ].filter(Boolean).join('\n\n');

  return [prompt, focus, scaff].filter(Boolean).join('\n\n');
}

/* -------------------- Upstream 调用（重试+超时） -------------------- */
async function withRetries(fn, tries=3, base=250) {
  let last;
  for (let i=0;i<tries;i++){
    try { return await fn(); }
    catch(e){ last=e; if (i<tries-1) await new Promise(r=>setTimeout(r, base*Math.pow(2,i))); }
  }
  throw last;
}

/* -------------------- 主处理 -------------------- */
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
    const OR_KEY = process.env.OPENROUTER_KEY;
    if (!OR_KEY) {
      return new Response(JSON.stringify({ error: 'Missing OPENROUTER_KEY' }), {
        status: 500, headers: corsHeaders(),
      });
    }

    const body = await req.json().catch(()=> ({}));
    const {
      prompt = '',
      system = '',
      model = 'meta-llama/llama-3.1-8b-instruct',
      temperature = 0.7,
      max_tokens = 900,
      lang = 'zh',
      token = 'BTC',
      ptype = 'short',
      context = {} // { outline, topic_bank, tags, mentions, styleMeta }
    } = body || {};

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid "prompt"' }), { status: 400, headers: corsHeaders() });
    }

    // 学习状态
    const state = await loadState();
    state.tokens ||= {};
    state.tokens[token] ||= { topicIdx:0, formatIdx:0, recentTitles:[] };

    // 话题池：优先 context.topic_bank，其次把 outline 的行切成条目
    let topicBank = Array.isArray(context.topic_bank) ? context.topic_bank.filter(Boolean) : [];
    if (!topicBank.length && context.outline) {
      topicBank = String(context.outline).split(/\n+/).map(s=>s.replace(/^[-•\s]+/,'').trim()).filter(Boolean);
    }
    if (!topicBank.length) {
      // 没传就做一个通用兜底
      topicBank = [
        '近期里程碑/提案影响与验证路径',
        '协议职责与代币在其中的角色',
        '生态集成（钱包/桥/基础设施）典型场景',
        '风险与边界（权限/依赖/可升级性）'
      ];
    }

    // 轮转：话题与版式
    const { item: topicUsed } = rotatePick(state, token, topicBank, 'topicIdx');
    const { item: formatUsed } = rotatePick(state, token, FORMAT_HINTS_ZH, 'formatIdx');

    // System / User 提示
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

    // 组织消息
    const messages = [];
    const sys = [system, sysComposed].filter(Boolean).join('\n\n');
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push({ role: 'user', content: String(userComposed) });

    // OpenRouter 头
    const referer = process.env.OR_HTTP_REFERER || 'https://your-app.example';
    const titleHdr = process.env.OR_X_TITLE || 'BinancePoster-Proxy';

    // 调用上游（带超时+重试）
    const controller = new AbortController();
    const to = setTimeout(()=>controller.abort(), TIMEOUT_MS);

    const data = await withRetries(async () => {
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
          max_tokens: clamp(Number(max_tokens)||0, 1, 2000),
          ...(JSON_MODE ? { response_format: { type: 'json_object' } } : {})
        }),
        signal: controller.signal
      });
      const j = await resp.json().catch(()=>null);
      if (!resp.ok) {
        const errMsg = j?.error || j || { error: 'Upstream error' };
        throw new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
      }
      return j;
    }, 3, 250);

    clearTimeout(to);

    // 解析输出（优先 JSON）
    const raw = data?.choices?.[0]?.message?.content ?? data?.output_text ?? '';
    const parsed = typeof raw === 'string' ? extractJson(raw) : (raw || {});
    let out = sanitizeOut(parsed || {}, token);

    // 强制补齐 token 相关标签/提及（与前端策略兼容）
    const mergedTags = uniq([...(out.tags||[]), ...(context?.tags||[]), token.toLowerCase()]).slice(0,2);
    const mergedTickers = uniq([token.toUpperCase(), ...(out.tickers||[])]).slice(0,1);
    const mergedMentions = uniq([...(out.mentions||[]), ...(context?.mentions||[])]).slice(0,1);
    out.tags = mergedTags;
    out.tickers = mergedTickers;
    out.mentions = mergedMentions;

    // 标题去重（如重复则拼 topic/format 微调）
    if (titleSeen(state, token, out.title)) {
      const tweak = topicUsed ? `｜${String(topicUsed).slice(0,8)}` : `｜${formatUsed?.name || '更新'}`;
      out.title = (out.title + tweak).slice(0,48);
    }
    rememberTitle(state, token, out.title);

    // 存回学习状态
    state.updatedAt = Date.now();
    await saveState(state);

    // 汇总返回
    const respPayload = {
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
      warnings: JSON_MODE ? [] : ['json_mode_off: best-effort JSON extraction']
    };

    return new Response(JSON.stringify(respPayload), { status: 200, headers: corsHeaders() });

  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'Upstream timeout' : String(e?.message || e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: corsHeaders(),
    });
  }
}
