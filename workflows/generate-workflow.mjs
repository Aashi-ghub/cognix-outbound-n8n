import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

const uid = () => randomUUID();

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

const PARSE_GEMINI_HELPERS = `function extractGeminiText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = payload.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => p?.text || '').join('').trim();
}
function parseStrictJson(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  if (cleaned.startsWith('\`\`\`')) {
    cleaned = cleaned.replace(/^\\\`\\\`\\\`(?:json)?\\s*/i, '').replace(/\\\`\\\`\\\`\\s*$/, '').trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\\{[\\s\\S]*\\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {}
    }
  }
  return null;
}`;

const GEMINI_UNIFIED_PROMPT = `You are helping CognixAI Labs build authentic founder relationships on LinkedIn.

You are NOT writing sales outreach.

Generate thoughtful, observant, founder-to-founder networking messages.

Return STRICT JSON only with:
{
  "icp_score": number,
  "priority": "high|medium|low",
  "summary": "",
  "relationship_angle": "",
  "likely_pain_points": [],
  "connection_note": "",
  "relationship_message": ""
}

Rules:
- connection_note must feel human and natural
- never sound salesy
- never pitch services directly
- sound curious and intelligent
- mention something specific from the company context
- tone should feel like operator-to-operator networking
- connection_note max 260 chars
- relationship_message max 450 chars
- Do NOT invent founder names or LinkedIn URLs — use only provided founder fields
- Do NOT discover founders or guess company facts not in context
- likely_pain_points: array of strings (max 5)
- No markdown. No extra keys.`;

function node(name, type, position, parameters, extra = {}) {
  const versions = {
    'n8n-nodes-base.manualTrigger': 1,
    'n8n-nodes-base.scheduleTrigger': 1.2,
    'n8n-nodes-base.set': 3.4,
    'n8n-nodes-base.code': 2,
    'n8n-nodes-base.httpRequest': 4.2,
    'n8n-nodes-base.if': 2.2,
    'n8n-nodes-base.googleSheets': 4.5,
    'n8n-nodes-base.merge': 3,
    'n8n-nodes-base.errorTrigger': 1,
    'n8n-nodes-base.stickyNote': 1,
  };
  return {
    id: uid(),
    name,
    type,
    typeVersion: versions[type] ?? 1,
    position,
    parameters,
    ...extra,
  };
}

const httpRetryOnce = {
  retry: { enabled: true, maxTries: 1, waitBetween: 1000 },
  timeout: 30000,
};

const geminiUrlExpr = `={{ "${GEMINI_ENDPOINT}?key=" + $env.GEMINI_API_KEY }}`;

const nodes = [];
const connections = {};
const conn = (from, to, output = 0, input = 0) => {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: input });
};

// ─── TRIGGERS ───────────────────────────────────────────────
nodes.push(node('Manual Trigger', 'n8n-nodes-base.manualTrigger', [-2400, 0], {}));
nodes.push(
  node('Schedule - Discovery', 'n8n-nodes-base.scheduleTrigger', [-2400, -180], {
    rule: { interval: [{ field: 'cronExpression', expression: '0 6 * * 1,3,5' }] },
  })
);

// ─── STEP 1: CONFIG ─────────────────────────────────────────
nodes.push(
  node('Workflow Config', 'n8n-nodes-base.set', [-2160, 0], {
    mode: 'manual',
    duplicateItem: false,
    assignments: {
      assignments: [
        {
          id: uid(),
          name: 'spreadsheetId',
          value: "={{ $env.COGNIX_LEADS_SHEET_ID || '' }}",
          type: 'string',
        },
        { id: uid(), name: 'sheetName', value: 'Leads', type: 'string' },
        { id: uid(), name: 'failedSheetName', value: 'Failed_Leads', type: 'string' },
        {
          id: uid(),
          name: 'serperQueries',
          value:
            '=["AI SaaS site:linkedin.com/company","agentic AI startup site:linkedin.com/company","workflow automation SaaS site:linkedin.com/company","B2B AI platform site:linkedin.com/company","AI operations startup site:linkedin.com/company"]',
          type: 'array',
        },
        { id: uid(), name: 'batchSize', value: 2, type: 'number' },
        { id: uid(), name: 'maxLeadsPerRun', value: 8, type: 'number' },
        { id: uid(), name: 'maxScrapeChars', value: 1500, type: 'number' },
        { id: uid(), name: 'serperNumResults', value: 8, type: 'number' },
        { id: uid(), name: 'brandName', value: 'CognixAI Labs', type: 'string' },
      ],
    },
  }, {
    notes: 'Env: GEMINI_API_KEY, SERPER_API_KEY, FIRECRAWL_API_KEY, COGNIX_LEADS_SHEET_ID',
  })
);

nodes.push(
  node('Validate Config', 'n8n-nodes-base.code', [-1920, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const c = $input.first().json;
if (!c.spreadsheetId) throw new Error('COGNIX_LEADS_SHEET_ID is required');
if (!$env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
if (!$env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is required');
if (!$env.FIRECRAWL_API_KEY) throw new Error('FIRECRAWL_API_KEY is required');
return [{ json: { ...c, _runId: 'run_' + Date.now() } }];`,
  })
);

// ─── READ SHEET + DEDUPE INDEX (once) ───────────────────────
nodes.push(
  node('Read Existing Leads', 'n8n-nodes-base.googleSheets', [-1680, 0], {
    operation: 'read',
    documentId: { __rl: true, value: '={{ $json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $json.sheetName }}', mode: 'name' },
    options: { rangeDefinition: 'specifyRange', range: 'A:Z' },
  }, { alwaysOutputData: true })
);

nodes.push(
  node('Build Dedup Index', 'n8n-nodes-base.code', [-1440, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $('Validate Config').first().json;
const rows = $input.all().map((i) => i.json).filter((r) => r && (r.lead_id || r.company_name));
const normDomain = (w) =>
  String(w || '')
    .toLowerCase()
    .replace(/^https?:\\/\\//, '')
    .replace(/\\/$/, '')
    .split('/')[0];
const seenDomains = new Set();
const seenNames = new Set();
const seenLinkedIn = new Set();
const seenFounderUrls = new Set();
for (const r of rows) {
  const d = normDomain(r.website);
  const n = String(r.company_name || '').toLowerCase().trim();
  const li = String(r.linkedin_company_url || '').toLowerCase().split('?')[0];
  const fu = String(r.founder_linkedin_url || '').toLowerCase().split('?')[0];
  if (d) seenDomains.add(d);
  if (n) seenNames.add(n);
  if (li) seenLinkedIn.add(li);
  if (fu && fu.includes('linkedin.com/in')) seenFounderUrls.add(fu);
}
return [{
  json: {
    ...cfg,
    seenDomains: [...seenDomains],
    seenNames: [...seenNames],
    seenLinkedIn: [...seenLinkedIn],
    seenFounderUrls: [...seenFounderUrls],
    existingRowCount: rows.length,
  },
}];`,
  })
);

// ─── STEP 2: SERPER (linear — 1 page, no loop-back) ─────────
nodes.push(
  node('Build Serper Queries', 'n8n-nodes-base.code', [-1200, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $input.first().json;
let queries = cfg.serperQueries;
if (typeof queries === 'string') {
  try { queries = JSON.parse(queries); } catch { queries = []; }
}
if (!Array.isArray(queries) || !queries.length) {
  queries = ['AI SaaS site:linkedin.com/company'];
}
return queries.slice(0, 5).map((q, queryIndex) => ({
  json: {
    ...cfg,
    searchQuery: q,
    queryIndex,
    page: 1,
    _queryKey: (cfg._runId || 'run') + '_q' + queryIndex,
  },
}));`,
  })
);

nodes.push(
  node('Serper Search', 'n8n-nodes-base.httpRequest', [-960, 0], {
    method: 'POST',
    url: 'https://google.serper.dev/search',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-API-KEY', value: '={{ $env.SERPER_API_KEY }}' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      '={{ JSON.stringify({ q: $json.searchQuery, num: $json.serperNumResults || 8, page: 1, gl: "us", hl: "en" }) }}',
    options: httpRetryOnce,
  }, { onError: 'continueRegularOutput' })
);

nodes.push(
  node('Merge Serper By Query Key', 'n8n-nodes-base.code', [-720, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const queries = $('Build Serper Queries').all().map((i) => i.json);
const results = $input.all().map((i) => i.json);
const merged = [];
const len = Math.max(queries.length, results.length);
for (let i = 0; i < len; i++) {
  const q = queries[i] || {};
  const r = results[i] || {};
  const queryKey = q._queryKey || ((q._runId || 'run') + '_q' + (q.queryIndex ?? i));
  merged.push({
    json: {
      ...q,
      ...r,
      _queryKey: queryKey,
      _mergeBy: 'queryKey',
    },
  });
}
return merged.length ? merged : [{ json: { _empty: true, _trace: 'serper_merge_empty' } }];`,
  })
);

nodes.push(
  node('Parse Serper Companies', 'n8n-nodes-base.code', [-480, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const normDomain = (w) =>
  String(w || '')
    .toLowerCase()
    .replace(/^https?:\\/\\//, '')
    .replace(/\\/$/, '')
    .split('/')[0];

function isLikelyStartupDomain(host) {
  if (!host || host.length < 4) return false;
  const h = host.split(':')[0];
  const bad = new Set([
    'reddit.com', 'youtube.com', 'youtu.be', 'medium.com', 'twitter.com', 'x.com',
    'facebook.com', 'instagram.com', 'linkedin.com', 'wikipedia.org', 'google.com',
    'bing.com', 'yahoo.com', 'news.ycombinator.com', 'producthunt.com', 'tiktok.com',
    'pinterest.com', 'quora.com', 'stackoverflow.com', 'github.com', 'substack.com',
    'wordpress.com', 'blogspot.com', 'tumblr.com', 'soundcloud.com', 'vimeo.com',
  ]);
  if (bad.has(h)) return false;
  const parts = h.split('.');
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1];
  const tldOk = ['com', 'io', 'ai', 'co', 'app', 'dev', 'tech', 'so', 'team', 'tools', 'cloud', 'software', 'net', 'org'].includes(tld);
  if (!tldOk) return false;
  if (parts[0].length < 2) return false;
  return true;
}

const blockedPatterns = [
  'reddit',
  'youtube',
  'medium',
  'y combinator',
  'yc',
  'best ',
  'top ',
  'how to',
  'guide',
  'blog',
  'article',
  'tools',
  'tips',
  'watch',
  'founder reacts',
  'underestimated',
];

const companies = [];
const runId = $input.first().json._runId || ('run_' + Date.now());

for (const item of $input.all()) {
  const row = item.json;
  const searchQuery = row.searchQuery || '';
  const queryIndex = row.queryIndex ?? 0;
  const organic = Array.isArray(row.organic) ? row.organic : [];

  for (let i = 0; i < organic.length; i++) {
    const r = organic[i] || {};
    const link = r.link || '';
    const title = String(r.title || '').toLowerCase();
    const linkLower = String(link || '').toLowerCase();

    const isBad =
      blockedPatterns.some((p) => title.includes(p)) ||
      linkLower.includes('reddit.com') ||
      linkLower.includes('youtube.com') ||
      linkLower.includes('medium.com');
    if (isBad) continue;

    let website = '';
    let linkedin_company_url = '';
    if (link.includes('linkedin.com/company')) {
      linkedin_company_url = link.split('?')[0];
      const m = (r.snippet || '').match(/https?:\\/\\/[^\\s)]+/);
      website = m ? m[0] : '';
    } else if (link && !link.includes('linkedin.com/in')) {
      website = link;
    }

    const domainFromLink = normDomain(link);
    const domainFromSite = normDomain(website);
    const isLinkedInCompany = linkLower.includes('linkedin.com/company');
    const acceptNonLinkedIn = !isLinkedInCompany && isLikelyStartupDomain(domainFromLink);

    if (!isLinkedInCompany && !acceptNonLinkedIn) continue;

    let company_name = String(r.title || '')
      .replace(/Official Page|LinkedIn/gi, '')
      .split('|')[0]
      .split(' - ')[0]
      .trim();
    if (!company_name || company_name.length < 2) continue;
    if (company_name.length > 45) continue;

    const domain = normDomain(website);
    companies.push({
      lead_id: runId + '_q' + queryIndex + '_' + i,
      company_name,
      website: website.startsWith('http') ? website : domain ? 'https://' + domain : '',
      linkedin_company_url,
      description: (r.snippet || '').slice(0, 400),
      source_query: searchQuery,
      status: 'discovered',
      created_at: new Date().toISOString(),
    });
  }
}

return companies.length
  ? companies.map((json) => ({ json }))
  : [{ json: { _empty: true, _trace: 'no_serper_companies' } }];`,
  })
);

// ─── STEP 3: DEDUPE ─────────────────────────────────────────
nodes.push(
  node('Dedupe Companies', 'n8n-nodes-base.code', [-240, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $input.first().json._empty
  ? $('Build Dedup Index').first().json
  : { ...$('Build Dedup Index').first().json };

if ($input.first().json._empty) {
  return [{ json: { ...cfg, _empty: true, _trace: 'dedupe_nothing_to_process' } }];
}

const normDomain = (w) =>
  String(w || '')
    .toLowerCase()
    .replace(/^https?:\\/\\//, '')
    .replace(/\\/$/, '')
    .split('/')[0];

const seenDomains = new Set(cfg.seenDomains || []);
const seenNames = new Set(cfg.seenNames || []);
const seenLinkedIn = new Set(cfg.seenLinkedIn || []);
const seenFounderUrls = new Set(cfg.seenFounderUrls || []);
const localDomains = new Set();
const unique = [];

for (const item of $input.all()) {
  const c = item.json;
  if (!c || c._empty || !c.company_name) continue;
  const domain = normDomain(c.website);
  const name = String(c.company_name).toLowerCase().trim();
  const li = String(c.linkedin_company_url || '').toLowerCase().split('?')[0];
  const fu = String(c.founder_linkedin_url || '').toLowerCase().split('?')[0];
  if (domain && (seenDomains.has(domain) || localDomains.has(domain))) continue;
  if (seenNames.has(name)) continue;
  if (li && seenLinkedIn.has(li)) continue;
  if (fu && fu.includes('linkedin.com/in') && seenFounderUrls.has(fu)) continue;
  if (domain) { localDomains.add(domain); seenDomains.add(domain); }
  seenNames.add(name);
  if (li) seenLinkedIn.add(li);
  if (fu) seenFounderUrls.add(fu);
  unique.push({ json: { ...cfg, ...c } });
}

if (!unique.length) {
  return [{ json: { ...cfg, _empty: true, _trace: 'all_duplicates' } }];
}
return unique;`,
  })
);

nodes.push(
  node('Limit Leads Per Run', 'n8n-nodes-base.code', [0, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $input.first().json;
if (cfg._empty) return [{ json: cfg }];
const max = Number(cfg.maxLeadsPerRun) || 8;
const leads = $input.all().map((i) => i.json).filter((j) => j.company_name);
return leads.slice(0, max).map((json) => ({ json }));`,
  })
);

nodes.push(
  node('IF Has Leads To Process', 'n8n-nodes-base.if', [240, 0], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $json._empty === true }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals' },
        },
        {
          leftValue: '={{ $json.company_name || "" }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty' },
        },
      ],
      combinator: 'and',
    },
  })
);

nodes.push(
  node('Run Complete - Nothing New', 'n8n-nodes-base.set', [480, 180], {
    mode: 'manual',
    assignments: {
      assignments: [
        {
          id: uid(),
          name: '_trace',
          value: '={{ "complete_nothing_new " + $now.toISO() }}',
          type: 'string',
        },
      ],
    },
    includeOtherFields: true,
  })
);

// ─── FOUNDER LOOKUP (Serper, before scrape) ─────────────────
nodes.push(
  node('Prepare Founder Search', 'n8n-nodes-base.code', [480, 0], {
    mode: 'runOnceForEachItem',
    jsCode: `const lead = $json;
if (!lead.lead_id) throw new Error('lead_id required before founder search');
return {
  json: {
    ...lead,
    _mergeBy: 'lead_id',
    founder_search_query: String(lead.company_name || '') + ' founder site:linkedin.com/in',
  },
};`,
  })
);
nodes.push(
  node('Serper Founder Lookup', 'n8n-nodes-base.httpRequest', [720, 0], {
    method: 'POST',
    url: 'https://google.serper.dev/search',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-API-KEY', value: '={{ $env.SERPER_API_KEY }}' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      '={{ JSON.stringify({ q: $json.founder_search_query, num: 5, page: 1, gl: "us", hl: "en" }) }}',
    options: httpRetryOnce,
  }, { onError: 'continueRegularOutput' })
);
nodes.push(
  node('Parse Founder Result', 'n8n-nodes-base.code', [960, 0], {
    mode: 'runOnceForEachItem',
    jsCode: `const serper = $input.item.json || {};
const lead = $('Prepare Founder Search').item.json;
if (!lead?.lead_id) throw new Error('Parse Founder: missing lead_id from Prepare Founder Search');

let founder_name = String(lead.founder_name || '').trim();
let founder_linkedin_url = String(lead.founder_linkedin_url || '').split('?')[0];
let founder_title = String(lead.founder_title || '').trim();
const organic = Array.isArray(serper.organic) ? serper.organic : [];

for (const r of organic) {
  const link = String(r.link || '').split('?')[0];
  if (!link.includes('linkedin.com/in/')) continue;
  if (!founder_linkedin_url) {
    founder_linkedin_url = link;
    const titleRaw = String(r.title || '');
    founder_name = founder_name || titleRaw.split('|')[0].split('-')[0].trim();
    const titleMatch = titleRaw.match(/\\b(CEO|CTO|COO|Founder|Co-Founder|President)\\b[^|]*/i);
    if (titleMatch) founder_title = founder_title || titleMatch[0].trim();
  }
}

return {
  json: {
    ...lead,
    founder_name,
    founder_linkedin_url,
    founder_title,
    founder_lookup_ok: Boolean(founder_linkedin_url),
    status: 'founder_resolved',
    _mergeBy: 'lead_id',
  },
};`,
  })
);

// ─── STEP 4: LIGHT SCRAPE (homepage only) ───────────────────
nodes.push(
  node('Prepare Scrape Context', 'n8n-nodes-base.code', [1200, 0], {
    mode: 'runOnceForEachItem',
    jsCode: `const lead = $json;
if (!lead.lead_id) throw new Error('lead_id required before scrape');
return { json: { ...lead, _mergeBy: 'lead_id' } };`,
  })
);
nodes.push(
  node('Firecrawl Homepage', 'n8n-nodes-base.httpRequest', [1440, 0], {
    method: 'POST',
    url: 'https://api.firecrawl.dev/v1/scrape',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: '={{ "Bearer " + $env.FIRECRAWL_API_KEY }}' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      '={{ JSON.stringify({ url: $json.website, formats: ["markdown"], onlyMainContent: true, timeout: 30000 }) }}',
    options: httpRetryOnce,
  }, { onError: 'continueRegularOutput' })
);

nodes.push(
  node('Merge Scrape By Lead Id', 'n8n-nodes-base.code', [1680, 0], {
    mode: 'runOnceForEachItem',
    jsCode: `const fc = $input.item.json || {};
const lead = $('Prepare Scrape Context').item.json;
if (!lead?.lead_id) throw new Error('Merge Scrape: lead_id missing');
const maxChars = Number(lead.maxScrapeChars) || 1500;
const md = fc?.data?.markdown || fc?.markdown || '';
const homepage = String(md).slice(0, maxChars);
const scrape_ok = Boolean(md && !fc?.error);
return {
  json: {
    ...lead,
    scraped_homepage: homepage,
    scrape_ok,
    scrape_error: fc?.error ? String(fc.error) : (scrape_ok ? '' : 'empty_homepage'),
    status: scrape_ok ? 'scraped' : 'scrape_failed',
    _mergeBy: 'lead_id',
  },
};`,
  })
);

nodes.push(
  node('Prepare Gemini Context', 'n8n-nodes-base.code', [1920, 0], {
    mode: 'runOnceForEachItem',
    jsCode: `const lead = $json;
if (!lead.lead_id) throw new Error('lead_id required before Gemini');
return { json: { ...lead, _mergeBy: 'lead_id' } };`,
  })
);

// ─── STEP 5: SINGLE GEMINI CALL ─────────────────────────────
nodes.push(
  node('Gemini Unified Intelligence', 'n8n-nodes-base.httpRequest', [2160, 0], {
    method: 'POST',
    url: geminiUrlExpr,
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Content-Type', value: 'application/json' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  contents: [{
    parts: [{
      text: ${JSON.stringify(GEMINI_UNIFIED_PROMPT)} +
        "\\n\\nCompany:\\n" + ($json.company_name || "") +
        "\\n\\nFounder:\\n" + ($json.founder_name || "") +
        "\\n" + ($json.founder_title || "") +
        "\\n\\nWebsite:\\n" + ($json.website || "") +
        "\\n\\nLinkedIn:\\n" + ($json.linkedin_company_url || "") +
        "\\n\\nHomepage:\\n" + ($json.scraped_homepage || "").slice(0, 1500) +
        "\\n\\nDescription:\\n" + ($json.description || "")
    }]
  }],
  generationConfig: { temperature: 0.4, responseMimeType: "application/json", maxOutputTokens: 1024 }
}) }}`,
    options: httpRetryOnce,
  }, { onError: 'continueRegularOutput' })
);

// ─── STEP 6: PARSE GEMINI ───────────────────────────────────
nodes.push(
  node('Parse Gemini Unified', 'n8n-nodes-base.code', [2400, 0], {
    mode: 'runOnceForEachItem',
    jsCode: `${PARSE_GEMINI_HELPERS}
const geminiRaw = $input.item.json || {};
const lead = $('Prepare Gemini Context').item.json;
if (!lead?.lead_id) throw new Error('Parse Gemini: lead_id missing');

const text = extractGeminiText(geminiRaw.candidates ? geminiRaw : {});
let ai = parseStrictJson(text);

const fallback = {
  icp_score: 45,
  priority: 'low',
  summary: 'Fallback scoring — Gemini parse or API issue',
  relationship_angle: 'operational intelligence and workflow scaling',
  likely_pain_points: [],
  connection_note: 'Hi — appreciated learning about your team. Would love to connect.',
  relationship_message: 'Thanks for connecting. Curious how you think about ops workflows as you scale.',
};

if (!ai || typeof ai !== 'object') ai = { ...fallback, _parseMode: 'raw_text', _raw: (text || '').slice(0, 500) };

const icp_score = Math.min(100, Math.max(0, Number(ai.icp_score) || 45));
let priority = String(ai.priority || 'low').toLowerCase();
if (!['high', 'medium', 'low'].includes(priority)) {
  priority = icp_score >= 75 ? 'high' : icp_score >= 50 ? 'medium' : 'low';
}

const pain = Array.isArray(ai.likely_pain_points)
  ? ai.likely_pain_points.slice(0, 5)
  : [];

const now = new Date().toISOString();

return {
  json: {
    ...lead,
    icp_score,
    priority,
    summary: String(ai.summary || fallback.summary).slice(0, 600),
    relationship_angle: String(ai.relationship_angle || fallback.relationship_angle).slice(0, 300),
    likely_pain_points: pain.join('; '),
    connection_note: String(ai.connection_note || fallback.connection_note).slice(0, 260),
    relationship_message: String(ai.relationship_message || fallback.relationship_message).slice(0, 450),
    status: priority === 'low' ? 'archived' : 'queued',
    engagement_stage: 'profile_pending',
    viewed_at: '',
    connection_requested_at: '',
    connected_at: '',
    followup_sent_at: '',
    replied: false,
    error_log: geminiRaw?.error ? String(geminiRaw.error.message || geminiRaw.error) : (lead.scrape_error || ''),
    updated_at: now,
    _mergeBy: 'lead_id',
  },
};`,
  })
);

// ─── STEP 7: BATCH APPEND ───────────────────────────────────
nodes.push(
  node('Prepare Sheet Rows', 'n8n-nodes-base.code', [2880, 0], {
    mode: 'runOnceForEachItem',
    jsCode: `const j = $json;
if (!j.lead_id || !j.company_name) {
  return { json: { ...j, _skipAppend: true, _trace: 'invalid_row' } };
}
return { json: j };`,
  })
);

nodes.push(
  node('IF Valid For Append', 'n8n-nodes-base.if', [3120, 0], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $json._skipAppend }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals' },
        },
        {
          leftValue: '={{ $json.lead_id || "" }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty' },
        },
      ],
      combinator: 'and',
    },
  })
);

nodes.push(
  node('Sheets Append Leads', 'n8n-nodes-base.googleSheets', [3360, 0], {
    operation: 'append',
    documentId: { __rl: true, value: '={{ $json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $json.sheetName }}', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        lead_id: '={{ $json.lead_id }}',
        company_name: '={{ $json.company_name }}',
        website: '={{ $json.website }}',
        linkedin_company_url: '={{ $json.linkedin_company_url }}',
        founder_name: '={{ $json.founder_name }}',
        founder_title: '={{ $json.founder_title }}',
        founder_linkedin_url: '={{ $json.founder_linkedin_url }}',
        icp_score: '={{ $json.icp_score }}',
        priority: '={{ $json.priority }}',
        summary: '={{ $json.summary }}',
        relationship_angle: '={{ $json.relationship_angle }}',
        connection_note: '={{ $json.connection_note }}',
        relationship_message: '={{ $json.relationship_message }}',
        status: '={{ $json.status }}',
        engagement_stage: '={{ $json.engagement_stage || "profile_pending" }}',
        viewed_at: '={{ $json.viewed_at || "" }}',
        connection_requested_at: '={{ $json.connection_requested_at || "" }}',
        connected_at: '={{ $json.connected_at || "" }}',
        followup_sent_at: '={{ $json.followup_sent_at || "" }}',
        replied: '={{ $json.replied || false }}',
        created_at: '={{ $json.created_at }}',
        updated_at: '={{ $json.updated_at }}',
        error_log: '={{ $json.error_log || "" }}',
        source_query: '={{ $json.source_query || "" }}',
      },
    },
    options: { cellFormat: 'USER_ENTERED' },
  })
);

nodes.push(
  node('Run Complete - Success', 'n8n-nodes-base.set', [3600, 0], {
    mode: 'manual',
    includeOtherFields: true,
    assignments: {
      assignments: [
        {
          id: uid(),
          name: '_trace',
          value: '={{ "complete_success " + $now.toISO() }}',
          type: 'string',
        },
      ],
    },
  })
);

// ─── STEP 8: ERROR HANDLING ─────────────────────────────────
nodes.push(node('Error Trigger', 'n8n-nodes-base.errorTrigger', [-2400, 400], {}));
nodes.push(
  node('Prepare Failed Row', 'n8n-nodes-base.code', [-2160, 400], {
    mode: 'runOnceForAllItems',
    jsCode: `const err = $input.first().json;
return [{
  json: {
    company_name: err.company_name || err.json?.company_name || 'unknown',
    website: err.website || err.json?.website || '',
    error: err.execution?.error?.message || err.message || JSON.stringify(err).slice(0, 500),
    stage: err.execution?.lastNodeExecuted || 'unknown',
    timestamp: new Date().toISOString(),
    run_id: err._runId || '',
  },
}];`,
  })
);
nodes.push(
  node('Sheets Append Failed', 'n8n-nodes-base.googleSheets', [-1920, 400], {
    operation: 'append',
    documentId: { __rl: true, value: '={{ $env.COGNIX_LEADS_SHEET_ID }}', mode: 'id' },
    sheetName: { __rl: true, value: 'Failed_Leads', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        company_name: '={{ $json.company_name }}',
        website: '={{ $json.website }}',
        error: '={{ $json.error }}',
        stage: '={{ $json.stage }}',
        timestamp: '={{ $json.timestamp }}',
        run_id: '={{ $json.run_id }}',
      },
    },
    options: { cellFormat: 'USER_ENTERED' },
  })
);

nodes.push(
  node('NOTE Lean Architecture', 'n8n-nodes-base.stickyNote', [-2600, -200], {
    content:
      '## CognixAI Lean Discovery (v3)\n\nCompany-intent Serper only. Parse filters junk + title noise. Merges: queryKey / lead_id via Code.',
    height: 220,
    width: 480,
  })
);

// ─── CONNECTIONS (linear only) ──────────────────────────────
conn('Manual Trigger', 'Workflow Config');
conn('Schedule - Discovery', 'Workflow Config');
conn('Workflow Config', 'Validate Config');
conn('Validate Config', 'Read Existing Leads');
conn('Read Existing Leads', 'Build Dedup Index');
conn('Build Dedup Index', 'Build Serper Queries');
conn('Build Serper Queries', 'Serper Search');
conn('Serper Search', 'Merge Serper By Query Key');
conn('Merge Serper By Query Key', 'Parse Serper Companies');
conn('Parse Serper Companies', 'Dedupe Companies');
conn('Dedupe Companies', 'Limit Leads Per Run');
conn('Limit Leads Per Run', 'IF Has Leads To Process');
conn('IF Has Leads To Process', 'Prepare Founder Search', 0, 0);
conn('IF Has Leads To Process', 'Run Complete - Nothing New', 1, 0);
conn('Prepare Founder Search', 'Serper Founder Lookup');
conn('Serper Founder Lookup', 'Parse Founder Result');
conn('Parse Founder Result', 'Prepare Scrape Context');
conn('Prepare Scrape Context', 'Firecrawl Homepage');
conn('Firecrawl Homepage', 'Merge Scrape By Lead Id');
conn('Merge Scrape By Lead Id', 'Prepare Gemini Context');
conn('Prepare Gemini Context', 'Gemini Unified Intelligence');
conn('Gemini Unified Intelligence', 'Parse Gemini Unified');
conn('Parse Gemini Unified', 'Prepare Sheet Rows');
conn('Prepare Sheet Rows', 'IF Valid For Append');
conn('IF Valid For Append', 'Sheets Append Leads', 0, 0);
conn('Sheets Append Leads', 'Run Complete - Success');
conn('Error Trigger', 'Prepare Failed Row');
conn('Prepare Failed Row', 'Sheets Append Failed');

const workflow = {
  name: 'CognixAI Labs - Lean Lead Discovery (Gemini)',
  nodes,
  connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    saveManualExecutions: true,
    callerPolicy: 'workflowsFromSameOwner',
    timezone: 'America/New_York',
  },
  pinData: {},
  meta: {
    templateCredsSetupCompleted: false,
    instanceId: 'cognix-lean-discovery-v2',
  },
  tags: [{ name: 'cognix' }, { name: 'lean' }, { name: 'discovery' }],
};

const outPath = new URL('./cognix-linkedin-relationship-intelligence.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');

const names = new Set(nodes.map((n) => n.name));
let missing = 0;
for (const [from, c] of Object.entries(connections)) {
  for (const outs of c.main || []) {
    for (const link of outs || []) {
      if (!names.has(link.node)) {
        console.error('Missing node:', link.node, 'from', from);
        missing++;
      }
    }
  }
}

const splitNodes = nodes.filter((n) => n.type === 'n8n-nodes-base.splitInBatches');
console.log('Written', outPath.pathname);
console.log('Nodes:', nodes.length, '| Missing links:', missing, '| SplitInBatches:', splitNodes.length);
