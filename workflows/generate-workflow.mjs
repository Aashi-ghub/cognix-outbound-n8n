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

function node(name, type, position, parameters, extra = {}) {
  const versions = {
    'n8n-nodes-base.manualTrigger': 1,
    'n8n-nodes-base.scheduleTrigger': 1.2,
    'n8n-nodes-base.merge': 3,
    'n8n-nodes-base.set': 3.4,
    'n8n-nodes-base.code': 2,
    'n8n-nodes-base.splitInBatches': 3,
    'n8n-nodes-base.httpRequest': 4.2,
    'n8n-nodes-base.wait': 1.1,
    'n8n-nodes-base.if': 2.2,
    'n8n-nodes-base.switch': 3.2,
    'n8n-nodes-base.googleSheets': 4.5,
    'n8n-nodes-base.gmail': 2.1,
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

const retryOptions = {
  retry: { enabled: true, maxTries: 3, waitBetween: 2500 },
  timeout: 120000,
};

const geminiHeaders = {
  parameters: [
    { name: 'Content-Type', value: 'application/json' },
  ],
};

const geminiUrlExpr = `={{ "${GEMINI_ENDPOINT}?key=" + $env.GEMINI_API_KEY }}`;

const nodes = [];
const connections = {};
const conn = (from, to, output = 0, input = 0) => {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: input });
};

// ============ TRIGGERS & CONFIG ============
nodes.push(node('Manual Trigger', 'n8n-nodes-base.manualTrigger', [-3200, 0], {}));
nodes.push(
  node('Schedule - Discovery', 'n8n-nodes-base.scheduleTrigger', [-3200, -200], {
    rule: { interval: [{ field: 'cronExpression', expression: '0 6 * * 1,3,5' }] },
  })
);
nodes.push(
  node('Schedule - Follow-ups', 'n8n-nodes-base.scheduleTrigger', [-3200, 200], {
    rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * *' }] },
  })
);
nodes.push(
  node('Merge Triggers', 'n8n-nodes-base.merge', [-2960, 0], { mode: 'append', numberInputs: 3 })
);
nodes.push(
  node('Workflow Config', 'n8n-nodes-base.set', [-2720, 0], {
    mode: 'manual',
    duplicateItem: false,
    assignments: {
      assignments: [
        { id: uid(), name: 'runMode', value: 'full', type: 'string' },
        {
          id: uid(),
          name: 'spreadsheetId',
          value: "={{ $env.COGNIX_LEADS_SHEET_ID || '' }}",
          type: 'string',
        },
        { id: uid(), name: 'sheetName', value: 'Leads', type: 'string' },
        {
          id: uid(),
          name: 'serperQueries',
          value:
            '=["AI SaaS company site:linkedin.com/company","B2B SaaS startup hiring operations","recruitment agency workflow automation","agency scaling operations team","workflow-heavy SaaS company careers"]',
          type: 'array',
        },
        { id: uid(), name: 'discoveryBatchSize', value: 5, type: 'number' },
        { id: uid(), name: 'scrapeBatchSize', value: 2, type: 'number' },
        { id: uid(), name: 'outreachBatchSize', value: 5, type: 'number' },
        { id: uid(), name: 'followupBatchSize', value: 5, type: 'number' },
        { id: uid(), name: 'serperWaitMs', value: 2000, type: 'number' },
        { id: uid(), name: 'firecrawlWaitMs', value: 3000, type: 'number' },
        { id: uid(), name: 'geminiWaitMs', value: 1200, type: 'number' },
        { id: uid(), name: 'maxScrapeChars', value: 8000, type: 'number' },
        {
          id: uid(),
          name: 'fromEmail',
          value: "={{ $env.COGNIX_FROM_EMAIL || '' }}",
          type: 'string',
        },
        { id: uid(), name: 'senderName', value: 'CognixAI Labs', type: 'string' },
      ],
    },
    options: {},
  }, {
    notes:
      'Set COGNIX_LEADS_SHEET_ID, GEMINI_API_KEY, SERPER_API_KEY, FIRECRAWL_API_KEY in Windows env. Restart n8n after changes.',
  })
);
nodes.push(
  node('Detect Run Mode', 'n8n-nodes-base.code', [-2480, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const config = $input.first().json;
if (!config.spreadsheetId) {
  throw new Error('COGNIX_LEADS_SHEET_ID is required. Set it in Workflow Config or environment variables.');
}
if (!$env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is required for AI analysis and personalization.');
}
const discoveryRan = $('Schedule - Discovery').isExecuted;
const followupsRan = $('Schedule - Follow-ups').isExecuted;
const manualRan = $('Manual Trigger').isExecuted;
let runMode = 'full';
if (followupsRan && !discoveryRan && !manualRan) runMode = 'followups_only';
else if (discoveryRan && !manualRan) runMode = 'discovery_pipeline';
else if (manualRan) runMode = 'full';
return [{ json: { ...config, runMode } }];`,
  })
);
nodes.push(
  node('Route Run Mode', 'n8n-nodes-base.switch', [-2240, 0], {
    mode: 'rules',
    rules: {
      values: [
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ $json.runMode }}',
                rightValue: 'followups_only',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'followups_only',
        },
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ $json.runMode }}',
                rightValue: 'discovery_pipeline',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'discovery_pipeline',
        },
      ],
    },
    options: { fallbackOutput: 'extra', fallbackOutputName: 'full_pipeline' },
  })
);

// ============ SHEETS READ / DEDUP ============
nodes.push(
  node('Read Existing Leads', 'n8n-nodes-base.googleSheets', [-2000, -400], {
    operation: 'read',
    documentId: { __rl: true, value: '={{ $json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $json.sheetName }}', mode: 'name' },
    options: { rangeDefinition: 'specifyRange', range: 'A:AA' },
  })
);
nodes.push(
  node('Build Dedup Index', 'n8n-nodes-base.code', [-1760, -400], {
    mode: 'runOnceForAllItems',
    jsCode: `const config = $('Detect Run Mode').first().json;
const rows = $input.all().map((i) => i.json).filter((r) => r.lead_id || r.company_name);
const seenDomains = new Set();
const seenNames = new Set();
for (const r of rows) {
  const website = String(r.website || r.Website || '')
    .toLowerCase()
    .replace(/^https?:\\/\\//, '')
    .replace(/\\/$/, '')
    .split('/')[0];
  const name = String(r.company_name || r['Company Name'] || '')
    .toLowerCase()
    .trim();
  if (website) seenDomains.add(website);
  if (name) seenNames.add(name);
}
return [
  {
    json: {
      ...config,
      seenDomains: [...seenDomains],
      seenNames: [...seenNames],
      existingRowCount: rows.length,
    },
  },
];`,
  })
);

// ============ DISCOVERY ============
nodes.push(
  node('Build Discovery Queries', 'n8n-nodes-base.code', [-1520, -400], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $input.first().json;
let queries = cfg.serperQueries;
if (typeof queries === 'string') {
  try { queries = JSON.parse(queries); } catch { queries = []; }
}
if (!Array.isArray(queries)) queries = [];
const items = queries.map((q, idx) => ({
  json: { ...cfg, searchQuery: q, page: 1, maxPages: 3, queryIndex: idx },
}));
return items.length
  ? items
  : [{ json: { ...cfg, searchQuery: 'B2B SaaS AI automation company', page: 1, maxPages: 1, queryIndex: 0 } }];`,
  })
);
nodes.push(
  node('Split Discovery Batches', 'n8n-nodes-base.splitInBatches', [-1280, -400], {
    batchSize: '={{ $json.discoveryBatchSize || 5 }}',
    options: { reset: false },
  })
);
nodes.push(
  node('Serper Search', 'n8n-nodes-base.httpRequest', [-1040, -400], {
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
      '={{ JSON.stringify({ q: $json.searchQuery, num: 10, page: $json.page || 1, gl: "us", hl: "en" }) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput', notes: 'Requires SERPER_API_KEY env var.' })
);
nodes.push(
  node('Wait Serper Rate Limit', 'n8n-nodes-base.wait', [-800, -400], {
    resume: 'timeInterval',
    amount: '={{ $("Workflow Config").first().json.serperWaitMs || 2000 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Parse Serper Results', 'n8n-nodes-base.code', [-560, -400], {
    mode: 'runOnceForAllItems',
    jsCode: `const src = $('Split Discovery Batches').first().json;
const body = $input.first().json;
const organic = body.organic || [];
const companies = organic
  .map((r, i) => {
    const link = r.link || '';
    let website = link;
    if (link.includes('linkedin.com')) {
      website = (r.snippet || '').match(/https?:\\/\\/[^\\s)]+/)?.[0] || '';
    }
    const domain = website.replace(/^https?:\\/\\//, '').split('/')[0];
    return {
      lead_id: 'cognix_' + Date.now() + '_' + src.queryIndex + '_' + i,
      company_name: (r.title || '').split('|')[0].split('-')[0].trim() || r.title || 'Unknown Company',
      website: website.startsWith('http') ? website : domain ? 'https://' + domain : '',
      linkedin_url: link.includes('linkedin.com') ? link : '',
      description: r.snippet || '',
      source_query: src.searchQuery,
      discovery_page: src.page,
      status: 'discovered',
      outreach_stage: 'none',
      reply_detected: false,
      created_at: new Date().toISOString(),
    };
  })
  .filter((c) => c.company_name);
return companies.map((json) => ({ json }));`,
  })
);
nodes.push(
  node('IF More Serper Pages', 'n8n-nodes-base.if', [-320, -520], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [
        {
          leftValue: '={{ $("Split Discovery Batches").first().json.page }}',
          rightValue: '={{ $("Split Discovery Batches").first().json.maxPages }}',
          operator: { type: 'number', operation: 'lt' },
        },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('Increment Serper Page', 'n8n-nodes-base.set', [-80, -640], {
    mode: 'manual',
    assignments: {
      assignments: [
        {
          id: uid(),
          name: 'page',
          value: '={{ $("Split Discovery Batches").first().json.page + 1 }}',
          type: 'number',
        },
      ],
    },
    includeOtherFields: true,
  })
);
nodes.push(
  node('Dedupe Companies', 'n8n-nodes-base.code', [-320, -400], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $('Build Dedup Index').first().json;
const seenDomains = new Set(cfg.seenDomains || []);
const seenNames = new Set(cfg.seenNames || []);
const unique = [];
const localDomains = new Set();
for (const item of $input.all()) {
  const c = item.json;
  const domain = String(c.website || '')
    .toLowerCase()
    .replace(/^https?:\\/\\//, '')
    .replace(/\\/$/, '')
    .split('/')[0];
  const name = String(c.company_name || '').toLowerCase().trim();
  if (!name) continue;
  if (domain && (seenDomains.has(domain) || localDomains.has(domain))) continue;
  if (seenNames.has(name)) continue;
  if (domain) {
    localDomains.add(domain);
    seenDomains.add(domain);
  }
  seenNames.add(name);
  unique.push({ json: c });
}
return unique;`,
  })
);
nodes.push(
  node('IF Has New Companies', 'n8n-nodes-base.if', [-80, -400], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [
        {
          leftValue: '={{ $input.all().length }}',
          rightValue: 0,
          operator: { type: 'number', operation: 'gt' },
        },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('IF Apify Enabled', 'n8n-nodes-base.if', [40, -400], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $env.APIFY_API_TOKEN }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty' },
        },
      ],
      combinator: 'and',
    },
  }, { notes: 'Skips Apify when APIFY_API_TOKEN is not set.' })
);
nodes.push(
  node('Apify Optional Enrich', 'n8n-nodes-base.httpRequest', [200, -480], {
    method: 'POST',
    url: 'https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: '={{ "Bearer " + $env.APIFY_API_TOKEN }}' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      '={{ JSON.stringify({ queries: $json.company_name + " official website", maxPagesPerQuery: 1, resultsPerPage: 3 }) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Skip Apify Pass-through', 'n8n-nodes-base.code', [200, -320], {
    mode: 'runOnceForEachItem',
    jsCode: 'return { json: { ...$json, apify_enriched: false } };',
  })
);
nodes.push(
  node('Merge Apify Enrichment', 'n8n-nodes-base.code', [320, -400], {
    mode: 'runOnceForEachItem',
    jsCode: `const items = $('Dedupe Companies').all();
const base = items[$itemIndex]?.json || $json;
const apify = $input.first().json;
let website = base.website;
if (Array.isArray(apify) && apify[0]?.url) website = apify[0].url;
if (apify?.organic?.[0]?.link) website = apify.organic[0].link;
return { json: { ...base, website: website || base.website, apify_enriched: true } };`,
  })
);
nodes.push(
  node('Merge Apify Skip', 'n8n-nodes-base.code', [320, -320], {
    mode: 'runOnceForEachItem',
    jsCode: 'return { json: $json };',
  })
);
nodes.push(
  node('Merge Enrich Paths', 'n8n-nodes-base.merge', [440, -400], { mode: 'append', numberInputs: 2 })
);

// ============ FIRECRAWL ============
nodes.push(
  node('Split Scrape Batches', 'n8n-nodes-base.splitInBatches', [560, -400], {
    batchSize: '={{ $("Build Dedup Index").first().json.scrapeBatchSize || 2 }}',
    options: { reset: false },
  })
);
nodes.push(
  node('Attach Lead Context', 'n8n-nodes-base.code', [720, -400], {
    mode: 'runOnceForEachItem',
    jsCode: `const cfg = $('Build Dedup Index').first().json;
const lead = $json;
return {
  json: {
    ...cfg,
    ...lead,
    _lead_ref: lead.lead_id,
    website: lead.website || '',
  },
};`,
  })
);
nodes.push(
  node('Firecrawl Homepage', 'n8n-nodes-base.httpRequest', [920, -400], {
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
      '={{ JSON.stringify({ url: $("Attach Lead Context").first().json.website, formats: ["markdown"], onlyMainContent: true, timeout: 60000 }) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Wait Firecrawl Rate Limit', 'n8n-nodes-base.wait', [1160, -400], {
    resume: 'timeInterval',
    amount: '={{ $("Workflow Config").first().json.firecrawlWaitMs || 3000 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Firecrawl Careers', 'n8n-nodes-base.httpRequest', [1400, -400], {
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
    jsonBody: `={{ JSON.stringify({
  url: ($("Attach Lead Context").first().json.website || "").replace(/\\/$/, "") + "/careers",
  formats: ["markdown"],
  onlyMainContent: true,
  timeout: 60000
}) }}`,
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Firecrawl Product', 'n8n-nodes-base.httpRequest', [1640, -400], {
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
    jsonBody: `={{ JSON.stringify({
  url: ($("Attach Lead Context").first().json.website || "").replace(/\\/$/, "") + "/product",
  formats: ["markdown"],
  onlyMainContent: true,
  timeout: 60000
}) }}`,
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Extract Scrape Signals', 'n8n-nodes-base.code', [1880, -400], {
    mode: 'runOnceForEachItem',
    jsCode: `const company = $('Attach Lead Context').first().json;
const maxChars = Number(company.maxScrapeChars) || 8000;
const slice = (v) => String(v || '').slice(0, maxChars);
const homepage =
  $('Firecrawl Homepage').first().json?.data?.markdown ||
  $('Firecrawl Homepage').first().json?.markdown ||
  '';
const careers = $('Firecrawl Careers').first().json?.data?.markdown || '';
const product =
  $('Firecrawl Product').first().json?.data?.markdown ||
  $('Firecrawl Product').first().json?.markdown ||
  '';
const combined = [homepage, careers, product].join('\\n').toLowerCase();
const count = (term) => (combined.match(new RegExp(term, 'gi')) || []).length;
return {
  json: {
    lead_id: company.lead_id,
    company_name: company.company_name,
    website: company.website,
    linkedin_url: company.linkedin_url,
    description: company.description,
    source_query: company.source_query,
    scraped_homepage: slice(homepage),
    scraped_careers: slice(careers),
    scraped_product: slice(product),
    signals: {
      ai_mentions: count('\\\\b(ai|artificial intelligence|llm|gemini|machine learning)\\\\b'),
      automation_mentions: count('\\\\b(automation|automate|workflow|orchestrat)\\\\b'),
      hiring_mentions: count('\\\\b(hiring|careers|open roles)\\\\b'),
      support_mentions: count('\\\\b(support|customer success|helpdesk|ticket)\\\\b'),
    },
    status: 'scraped',
    outreach_stage: company.outreach_stage || 'none',
    reply_detected: false,
    created_at: company.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
};`,
  })
);

// ============ GEMINI ANALYSIS ============
nodes.push(
  node('Wait Gemini Rate Limit', 'n8n-nodes-base.wait', [2120, -400], {
    resume: 'timeInterval',
    amount: '={{ $("Workflow Config").first().json.geminiWaitMs || 1200 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Gemini Lead Analysis', 'n8n-nodes-base.httpRequest', [2360, -400], {
    method: 'POST',
    url: geminiUrlExpr,
    sendHeaders: true,
    headerParameters: geminiHeaders,
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  contents: [{
    parts: [{
      text: "You are a B2B GTM analyst for CognixAI Labs. Return STRICT JSON only with keys: ai_readiness_score, operational_complexity_score, buying_probability, likely_pain_points, workflow_complexity, internal_tooling_needs, onboarding_complexity, support_burden, scaling_signals, summary. No markdown.\\n\\nCompany: " + $json.company_name + "\\nWebsite: " + $json.website + "\\nDescription: " + ($json.description || "") + "\\nSignals: " + JSON.stringify($json.signals || {}) + "\\nHomepage: " + ($json.scraped_homepage || "").slice(0, 3500) + "\\nCareers: " + ($json.scraped_careers || "").slice(0, 2000)
    }]
  }],
  generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
}) }}`,
    options: retryOptions,
  }, { onError: 'continueErrorOutput', notes: 'Gemini 2.0 Flash via GEMINI_API_KEY query param.' })
);
nodes.push(
  node('IF Gemini Analysis OK', 'n8n-nodes-base.if', [2600, -400], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $json.candidates?.[0]?.content?.parts?.[0]?.text }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty' },
        },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('Parse AI Analysis JSON', 'n8n-nodes-base.code', [2840, -400], {
    mode: 'runOnceForEachItem',
    jsCode: `${PARSE_GEMINI_HELPERS}
const lead = $('Extract Scrape Signals').first().json;
const text = extractGeminiText($input.first().json);
let analysis = parseStrictJson(text);
if (!analysis || typeof analysis !== 'object') {
  analysis = {
    summary: text || 'Analysis parse fallback',
    ai_readiness_score: 50,
    operational_complexity_score: 50,
    buying_probability: 0.3,
    likely_pain_points: [],
  };
}
return {
  json: {
    ...lead,
    ...analysis,
    status: 'analyzed',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('Handle Gemini Analysis Error', 'n8n-nodes-base.code', [2840, -200], {
    mode: 'runOnceForEachItem',
    jsCode: `const lead = $('Extract Scrape Signals').first().json;
const errMsg = $json.error?.message || $json.message || 'Gemini analysis failed';
return {
  json: {
    ...lead,
    error_log: errMsg,
    status: 'analysis_failed',
    ai_readiness_score: 40,
    operational_complexity_score: 50,
    buying_probability: 0.25,
    likely_pain_points: [],
    summary: 'Fallback scoring applied after Gemini error',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('ICP Weighted Scoring', 'n8n-nodes-base.code', [3080, -400], {
    mode: 'runOnceForEachItem',
    jsCode: `const l = $input.first().json;
const s = l.signals || {};
const weights = { ai: 0.2, automation: 0.15, hiring: 0.15, support: 0.1, ai_readiness: 0.15, complexity: 0.1, buying: 0.15 };
const norm = (v, max = 10) => Math.min(100, (Number(v) || 0) / max * 100);
const score =
  norm(s.ai_mentions) * weights.ai +
  norm(s.automation_mentions) * weights.automation +
  norm(s.hiring_mentions) * weights.hiring +
  norm(s.support_mentions) * weights.support +
  (Number(l.ai_readiness_score) || 50) * weights.ai_readiness +
  (Number(l.operational_complexity_score) || 50) * weights.complexity +
  (Number(l.buying_probability) || 0) * 100 * weights.buying;
const icp_score = Math.round(Math.min(100, Math.max(0, score)));
let priority = 'low';
if (icp_score >= 75) priority = 'high';
else if (icp_score >= 50) priority = 'medium';
return {
  json: {
    ...l,
    icp_score,
    priority,
    route: priority === 'high' ? 'immediate_outreach' : priority === 'medium' ? 'nurture' : 'archive',
    lead_quality: priority,
    status: priority === 'low' ? 'archived' : 'scored',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('Route ICP Priority', 'n8n-nodes-base.switch', [3320, -400], {
    mode: 'rules',
    rules: {
      values: [
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              { leftValue: '={{ $json.priority }}', rightValue: 'high', operator: { type: 'string', operation: 'equals' } },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'high',
        },
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              { leftValue: '={{ $json.priority }}', rightValue: 'medium', operator: { type: 'string', operation: 'equals' } },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'medium',
        },
      ],
    },
    options: { fallbackOutput: 'extra', fallbackOutputName: 'low_archive' },
  })
);

// ============ GEMINI PERSONALIZATION ============
nodes.push(
  node('Wait Gemini Personalize', 'n8n-nodes-base.wait', [3560, -560], {
    resume: 'timeInterval',
    amount: '={{ $("Workflow Config").first().json.geminiWaitMs || 1200 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Gemini Personalization', 'n8n-nodes-base.httpRequest', [3800, -560], {
    method: 'POST',
    url: geminiUrlExpr,
    sendHeaders: true,
    headerParameters: geminiHeaders,
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  contents: [{
    parts: [{
      text: "Write founder-level, human, non-salesy outreach for CognixAI Labs. Return STRICT JSON only with keys: linkedin_opener, email_subject, email_body, followup_1, followup_2, breakup_email, personalization_notes. Max 120 words per email. No markdown fences.\\n\\nLead context: " + JSON.stringify({
        company_name: $json.company_name,
        website: $json.website,
        pain_points: $json.likely_pain_points,
        icp_score: $json.icp_score,
        summary: $json.summary
      })
    }]
  }],
  generationConfig: { temperature: 0.65, responseMimeType: "application/json" }
}) }}`,
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Parse Personalization JSON', 'n8n-nodes-base.code', [4040, -560], {
    mode: 'runOnceForEachItem',
    jsCode: `${PARSE_GEMINI_HELPERS}
const lead = $('ICP Weighted Scoring').first().json;
const text = extractGeminiText($input.first().json);
let copy = parseStrictJson(text);
if (!copy || typeof copy !== 'object') {
  copy = {
    email_subject: 'Quick idea for ' + (lead.company_name || 'your team'),
    email_body: text || 'Hi — noticed operational complexity scaling at your company. Worth a brief chat?',
    followup_1: 'Following up in case this landed at a busy time.',
    followup_2: 'Last nudge — happy to share how similar teams reduced ops load.',
    breakup_email: 'Closing the loop — reach out anytime if timing improves.',
    linkedin_opener: 'Noticed your team scaling ops — curious how you handle workflow load.',
    personalization_notes: 'Gemini parse fallback used',
  };
}
return {
  json: {
    ...lead,
    ...copy,
    outreach_stage: lead.priority === 'high' ? 'ready_to_send' : 'nurture_queued',
    status: lead.priority === 'low' ? 'archived' : 'personalized',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('Handle Gemini Personalize Error', 'n8n-nodes-base.code', [4040, -420], {
    mode: 'runOnceForEachItem',
    jsCode: `const lead = $('ICP Weighted Scoring').first().json;
return {
  json: {
    ...lead,
    email_subject: 'Ops question for ' + (lead.company_name || 'your team'),
    email_body: 'Hi — sharing a quick thought on reducing workflow overhead for teams like yours.',
    outreach_stage: lead.priority === 'high' ? 'ready_to_send' : 'nurture_queued',
    status: 'personalized_fallback',
    error_log: $json.error?.message || 'Gemini personalization failed',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('Edit Fields - Lead Record', 'n8n-nodes-base.set', [4280, -560], {
    mode: 'manual',
    includeOtherFields: true,
    assignments: {
      assignments: [
        {
          id: uid(),
          name: 'contact_email',
          value:
            "={{ $json.contact_email || ('hello@' + String($json.website || '').replace(/^https?:\\/\\//,'').split('/')[0]) }}",
          type: 'string',
        },
        {
          id: uid(),
          name: 'route',
          value:
            '={{ $json.priority === "high" ? "immediate_outreach" : ($json.priority === "medium" ? "nurture" : "archive") }}',
          type: 'string',
        },
      ],
    },
  })
);
nodes.push(
  node('Archive Low ICP', 'n8n-nodes-base.set', [3560, -240], {
    mode: 'manual',
    assignments: {
      assignments: [
        { id: uid(), name: 'status', value: 'archived', type: 'string' },
        { id: uid(), name: 'outreach_stage', value: 'archived', type: 'string' },
      ],
    },
    includeOtherFields: true,
  })
);
nodes.push(
  node('Merge Outreach Paths', 'n8n-nodes-base.merge', [4520, -400], { mode: 'append', numberInputs: 2 })
);
nodes.push(
  node('Sheets Append Lead', 'n8n-nodes-base.googleSheets', [4760, -400], {
    operation: 'append',
    documentId: { __rl: true, value: '={{ $("Build Dedup Index").first().json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $("Build Dedup Index").first().json.sheetName }}', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        lead_id: '={{ $json.lead_id }}',
        company_name: '={{ $json.company_name }}',
        website: '={{ $json.website }}',
        linkedin_url: '={{ $json.linkedin_url }}',
        description: '={{ $json.description }}',
        contact_email: '={{ $json.contact_email }}',
        icp_score: '={{ $json.icp_score }}',
        priority: '={{ $json.priority }}',
        lead_quality: '={{ $json.lead_quality }}',
        ai_readiness_score: '={{ $json.ai_readiness_score }}',
        operational_complexity_score: '={{ $json.operational_complexity_score }}',
        buying_probability: '={{ $json.buying_probability }}',
        status: '={{ $json.status }}',
        outreach_stage: '={{ $json.outreach_stage }}',
        reply_detected: '={{ $json.reply_detected || false }}',
        linkedin_opener: '={{ $json.linkedin_opener }}',
        email_subject: '={{ $json.email_subject }}',
        email_body: '={{ $json.email_body }}',
        followup_1: '={{ $json.followup_1 }}',
        followup_2: '={{ $json.followup_2 }}',
        breakup_email: '={{ $json.breakup_email }}',
        last_contacted: '={{ $json.last_contacted || "" }}',
        personalization_notes: '={{ $json.personalization_notes }}',
        error_log: '={{ $json.error_log || "" }}',
        created_at: '={{ $json.created_at }}',
        updated_at: '={{ $json.updated_at }}',
      },
    },
    options: { cellFormat: 'USER_ENTERED' },
  })
);

// ============ OUTREACH ============
nodes.push(
  node('Loop Scrape Batches', 'n8n-nodes-base.code', [5000, -400], {
    mode: 'runOnceForAllItems',
    jsCode: 'return [{ json: { batch_continue: true } }];',
  })
);
nodes.push(
  node('Read Leads For Outreach', 'n8n-nodes-base.googleSheets', [5240, -400], {
    operation: 'read',
    documentId: { __rl: true, value: '={{ $("Build Dedup Index").first().json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $("Build Dedup Index").first().json.sheetName }}', mode: 'name' },
    options: { rangeDefinition: 'specifyRange', range: 'A:AA' },
  })
);
nodes.push(
  node('Filter Ready To Send', 'n8n-nodes-base.code', [5480, -400], {
    mode: 'runOnceForAllItems',
    jsCode: `return $input.all().filter((i) => {
  const r = i.json;
  const stage = String(r.outreach_stage || r['outreach_stage'] || '');
  const replied = r.reply_detected === true || r.reply_detected === 'TRUE';
  const last = r.last_contacted || r['last_contacted'] || '';
  const email = r.contact_email || r['contact_email'] || '';
  return stage === 'ready_to_send' && !replied && !last && String(email).includes('@');
});`,
  })
);
nodes.push(
  node('Split Outreach Batches', 'n8n-nodes-base.splitInBatches', [5720, -400], {
    batchSize: '={{ $("Build Dedup Index").first().json.outreachBatchSize || 5 }}',
    options: { reset: false },
  })
);
nodes.push(
  node('IF Not Already Contacted', 'n8n-nodes-base.if', [5960, -400], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ String($json.last_contacted || $json["last_contacted"] || "") }}',
          rightValue: '',
          operator: { type: 'string', operation: 'empty' },
        },
        {
          leftValue: '={{ $json.reply_detected === true || $json.reply_detected === "TRUE" }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals' },
        },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('Gmail Send Initial', 'n8n-nodes-base.gmail', [6200, -480], {
    resource: 'message',
    operation: 'send',
    sendTo: '={{ $json.contact_email || $json["contact_email"] }}',
    subject: '={{ $json.email_subject || ("Question about ops at " + ($json.company_name || "")) }}',
    emailType: 'text',
    message: '={{ $json.email_body || $json["email_body"] }}',
    options: {
      senderName: '={{ $("Workflow Config").first().json.senderName }}',
      replyTo: '={{ $("Workflow Config").first().json.fromEmail }}',
    },
  })
);
nodes.push(
  node('Sheets Update Contacted', 'n8n-nodes-base.googleSheets', [6440, -480], {
    operation: 'update',
    documentId: { __rl: true, value: '={{ $("Build Dedup Index").first().json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $("Build Dedup Index").first().json.sheetName }}', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        outreach_stage: 'initial_sent',
        status: 'contacted',
        last_contacted: '={{ $now.toISO() }}',
        updated_at: '={{ $now.toISO() }}',
      },
      matchingColumns: ['lead_id'],
    },
    options: { cellFormat: 'USER_ENTERED' },
  })
);
nodes.push(
  node('Run Follow-up Pass', 'n8n-nodes-base.code', [6680, -400], {
    mode: 'runOnceForAllItems',
    jsCode: `return [{ json: { ...$('Build Dedup Index').first().json, triggerFollowups: true } }];`,
  })
);

// ============ FOLLOW-UPS ============
nodes.push(
  node('Read Active Outreach Leads', 'n8n-nodes-base.googleSheets', [-2000, 400], {
    operation: 'read',
    documentId: { __rl: true, value: '={{ $json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $json.sheetName }}', mode: 'name' },
    options: { rangeDefinition: 'specifyRange', range: 'A:AA' },
  })
);
nodes.push(
  node('Filter Follow-up Candidates', 'n8n-nodes-base.code', [-1760, 400], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $('Detect Run Mode').first().json;
const now = Date.now();
const day = 86400000;
const items = $input.all().map((i) => i.json).filter((r) => {
  if (r.reply_detected === true || r.reply_detected === 'TRUE') return false;
  const stage = String(r.outreach_stage || '');
  if (!['initial_sent', 'followup_1_sent', 'followup_2_sent'].includes(stage)) return false;
  const last = Date.parse(r.last_contacted || r.updated_at || 0);
  if (!last) return false;
  const email = String(r.contact_email || r['contact_email'] || '');
  if (!email.includes('@')) return false;
  if (stage === 'initial_sent' && now - last >= 3 * day) return true;
  if (stage === 'followup_1_sent' && now - last >= 5 * day) return true;
  if (stage === 'followup_2_sent' && now - last >= 7 * day) return true;
  return false;
});
return items.map((json) => ({ json: { ...cfg, ...json } }));`,
  })
);
nodes.push(
  node('Split Follow-up Batches', 'n8n-nodes-base.splitInBatches', [-1520, 400], {
    batchSize: '={{ $("Workflow Config").first().json.followupBatchSize || 5 }}',
    options: { reset: false },
  })
);
nodes.push(
  node('Gmail Check Replies', 'n8n-nodes-base.gmail', [-1280, 400], {
    resource: 'message',
    operation: 'getAll',
    returnAll: false,
    limit: 5,
    filters: {
      q: '={{ "from:" + String($json.contact_email || $json["contact_email"] || "").trim() + " newer_than:14d in:inbox" }}',
    },
  })
);
nodes.push(
  node('IF Reply Detected', 'n8n-nodes-base.if', [-1040, 400], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [
        {
          leftValue: '={{ $input.all().length }}',
          rightValue: 0,
          operator: { type: 'number', operation: 'gt' },
        },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('Sheets Mark Replied', 'n8n-nodes-base.googleSheets', [-800, 280], {
    operation: 'update',
    documentId: {
      __rl: true,
      value: '={{ $("Split Follow-up Batches").first().json.spreadsheetId }}',
      mode: 'id',
    },
    sheetName: {
      __rl: true,
      value: '={{ $("Split Follow-up Batches").first().json.sheetName }}',
      mode: 'name',
    },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        reply_detected: true,
        status: 'replied',
        outreach_stage: 'stopped_reply',
        lead_quality: 'high_intent',
        updated_at: '={{ $now.toISO() }}',
      },
      matchingColumns: ['lead_id'],
    },
  })
);
nodes.push(
  node('Log High Intent Reply', 'n8n-nodes-base.code', [-560, 200], {
    mode: 'runOnceForEachItem',
    jsCode: `const lead = $('Split Follow-up Batches').first().json;
return {
  json: {
    ...lead,
    alert_logged: true,
    alert_message: 'High-intent reply from ' + (lead.company_name || lead.lead_id),
    alert_channel: 'sheets_and_execution_log',
    logged_at: new Date().toISOString(),
  },
};`,
  }, { notes: 'Default high-intent handling. No webhook required.' })
);
nodes.push(
  node('IF High Intent Webhook Enabled', 'n8n-nodes-base.if', [-560, 360], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $env.COGNIX_HIGH_INTENT_WEBHOOK_URL }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty' },
        },
      ],
      combinator: 'and',
    },
  }, { notes: 'Optional. Set COGNIX_HIGH_INTENT_WEBHOOK_URL to POST alerts.' })
);
nodes.push(
  node('HTTP Alert High Intent', 'n8n-nodes-base.httpRequest', [-320, 360], {
    method: 'POST',
    url: '={{ $env.COGNIX_HIGH_INTENT_WEBHOOK_URL }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ text: $json.alert_message, lead: $json }) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Switch Follow-up Stage', 'n8n-nodes-base.switch', [-800, 520], {
    mode: 'rules',
    rules: {
      values: [
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ $("Split Follow-up Batches").first().json.outreach_stage }}',
                rightValue: 'initial_sent',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'followup_1',
        },
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ $("Split Follow-up Batches").first().json.outreach_stage }}',
                rightValue: 'followup_1_sent',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'followup_2',
        },
      ],
    },
    options: { fallbackOutput: 'extra', fallbackOutputName: 'breakup' },
  })
);
nodes.push(
  node('Gmail Send Follow-up 1', 'n8n-nodes-base.gmail', [-560, 440], {
    resource: 'message',
    operation: 'send',
    sendTo: '={{ $json.contact_email || $json["contact_email"] }}',
    subject: '={{ "Re: " + ($json.email_subject || $json["email_subject"] || "following up") }}',
    emailType: 'text',
    message: '={{ $json.followup_1 || $json["followup_1"] }}',
  })
);
nodes.push(
  node('Sheets Update Follow-up 1', 'n8n-nodes-base.googleSheets', [-320, 440], {
    operation: 'update',
    documentId: { __rl: true, value: '={{ $json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $json.sheetName }}', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        outreach_stage: 'followup_1_sent',
        last_contacted: '={{ $now.toISO() }}',
        updated_at: '={{ $now.toISO() }}',
      },
      matchingColumns: ['lead_id'],
    },
  })
);
nodes.push(
  node('Gmail Send Follow-up 2', 'n8n-nodes-base.gmail', [-560, 640], {
    resource: 'message',
    operation: 'send',
    sendTo: '={{ $json.contact_email || $json["contact_email"] }}',
    subject: '={{ "Re: " + ($json.email_subject || "checking in") }}',
    emailType: 'text',
    message: '={{ $json.followup_2 || $json["followup_2"] }}',
  })
);
nodes.push(
  node('Sheets Update Follow-up 2', 'n8n-nodes-base.googleSheets', [-320, 640], {
    operation: 'update',
    documentId: { __rl: true, value: '={{ $json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $json.sheetName }}', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        outreach_stage: 'followup_2_sent',
        last_contacted: '={{ $now.toISO() }}',
        updated_at: '={{ $now.toISO() }}',
      },
      matchingColumns: ['lead_id'],
    },
  })
);
nodes.push(
  node('Gmail Send Breakup', 'n8n-nodes-base.gmail', [-560, 840], {
    resource: 'message',
    operation: 'send',
    sendTo: '={{ $json.contact_email || $json["contact_email"] }}',
    subject: '={{ "Closing the loop — " + ($json.company_name || "") }}',
    emailType: 'text',
    message: '={{ $json.breakup_email || $json["breakup_email"] }}',
  })
);
nodes.push(
  node('Sheets Update Breakup', 'n8n-nodes-base.googleSheets', [-320, 840], {
    operation: 'update',
    documentId: { __rl: true, value: '={{ $json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $json.sheetName }}', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        outreach_stage: 'breakup_sent',
        status: 'closed',
        last_contacted: '={{ $now.toISO() }}',
        updated_at: '={{ $now.toISO() }}',
      },
      matchingColumns: ['lead_id'],
    },
  })
);

// ============ ERROR HANDLING ============
nodes.push(node('Error Trigger', 'n8n-nodes-base.errorTrigger', [-3200, 600], {}));
nodes.push(
  node('Log Error Payload', 'n8n-nodes-base.code', [-2960, 600], {
    mode: 'runOnceForAllItems',
    jsCode: `const err = $input.first().json;
return [{
  json: {
    workflow: 'CognixAI Outbound Lead Intelligence',
    timestamp: new Date().toISOString(),
    execution_id: $execution.id,
    node: err.execution?.lastNodeExecuted || 'unknown',
    message: err.execution?.error?.message || JSON.stringify(err),
    stack: (err.execution?.error?.stack || '').toString().slice(0, 4000),
  },
}];`,
  })
);
nodes.push(
  node('Sheets Log Error', 'n8n-nodes-base.googleSheets', [-2720, 600], {
    operation: 'append',
    documentId: { __rl: true, value: '={{ $env.COGNIX_LEADS_SHEET_ID }}', mode: 'id' },
    sheetName: { __rl: true, value: 'ErrorLog', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        timestamp: '={{ $json.timestamp }}',
        execution_id: '={{ $json.execution_id }}',
        node: '={{ $json.node }}',
        message: '={{ $json.message }}',
        stack: '={{ $json.stack }}',
      },
    },
  })
);
nodes.push(
  node('IF Error Webhook Enabled', 'n8n-nodes-base.if', [-2480, 600], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $env.COGNIX_ERROR_WEBHOOK_URL }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty' },
        },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('HTTP Error Notify', 'n8n-nodes-base.httpRequest', [-2240, 600], {
    method: 'POST',
    url: '={{ $env.COGNIX_ERROR_WEBHOOK_URL }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Handle Serper Error', 'n8n-nodes-base.set', [-1040, -200], {
    mode: 'manual',
    assignments: {
      assignments: [
        { id: uid(), name: 'error_log', value: '={{ $json.error?.message || "Serper request failed" }}', type: 'string' },
        { id: uid(), name: 'status', value: 'discovery_failed', type: 'string' },
      ],
    },
    includeOtherFields: true,
  })
);
nodes.push(
  node('Loop Discovery Batches', 'n8n-nodes-base.code', [160, -560], {
    mode: 'runOnceForAllItems',
    jsCode: 'return [{ json: { loop: true } }];',
  })
);

nodes.push(
  node('NOTE Architecture', 'n8n-nodes-base.stickyNote', [-3400, -500], {
    content:
      '## CognixAI Outbound (Gemini)\n\nEnv: GEMINI_API_KEY, SERPER_API_KEY, FIRECRAWL_API_KEY, COGNIX_LEADS_SHEET_ID, COGNIX_FROM_EMAIL\nOptional: APIFY_API_TOKEN, COGNIX_HIGH_INTENT_WEBHOOK_URL, COGNIX_ERROR_WEBHOOK_URL\n\nAI: Gemini 2.0 Flash generateContent\nTriggers: Manual | Discovery Mon/Wed/Fri 06:00 | Follow-ups daily 09:00',
    height: 320,
    width: 520,
  })
);

// ============ CONNECTIONS ============
conn('Manual Trigger', 'Merge Triggers', 0, 0);
conn('Schedule - Discovery', 'Merge Triggers', 0, 1);
conn('Schedule - Follow-ups', 'Merge Triggers', 0, 2);
conn('Merge Triggers', 'Workflow Config');
conn('Workflow Config', 'Detect Run Mode');
conn('Detect Run Mode', 'Route Run Mode');

conn('Route Run Mode', 'Read Active Outreach Leads', 0, 0);
conn('Route Run Mode', 'Read Existing Leads', 1, 0);
conn('Route Run Mode', 'Read Existing Leads', 2, 0);

conn('Read Existing Leads', 'Build Dedup Index');
conn('Build Dedup Index', 'Build Discovery Queries');
conn('Build Discovery Queries', 'Split Discovery Batches');
conn('Split Discovery Batches', 'Serper Search');
conn('Serper Search', 'Wait Serper Rate Limit');
conn('Serper Search', 'Handle Serper Error', 1, 0);
conn('Wait Serper Rate Limit', 'Parse Serper Results');
conn('Parse Serper Results', 'IF More Serper Pages');
conn('IF More Serper Pages', 'Increment Serper Page', 0, 0);
conn('Increment Serper Page', 'Serper Search');
conn('IF More Serper Pages', 'Dedupe Companies', 1, 0);
conn('Dedupe Companies', 'IF Has New Companies');
conn('IF Has New Companies', 'IF Apify Enabled', 0, 0);
conn('IF Has New Companies', 'Loop Discovery Batches', 1, 0);
conn('IF Apify Enabled', 'Apify Optional Enrich', 0, 0);
conn('IF Apify Enabled', 'Skip Apify Pass-through', 1, 0);
conn('Apify Optional Enrich', 'Merge Apify Enrichment');
conn('Skip Apify Pass-through', 'Merge Apify Skip');
conn('Merge Apify Enrichment', 'Merge Enrich Paths', 0, 0);
conn('Merge Apify Skip', 'Merge Enrich Paths', 1, 0);
conn('Merge Enrich Paths', 'Split Scrape Batches');

conn('Split Scrape Batches', 'Attach Lead Context');
conn('Attach Lead Context', 'Firecrawl Homepage');
conn('Firecrawl Homepage', 'Wait Firecrawl Rate Limit');
conn('Wait Firecrawl Rate Limit', 'Firecrawl Careers');
conn('Firecrawl Careers', 'Firecrawl Product');
conn('Firecrawl Product', 'Extract Scrape Signals');
conn('Extract Scrape Signals', 'Wait Gemini Rate Limit');
conn('Wait Gemini Rate Limit', 'Gemini Lead Analysis');
conn('Gemini Lead Analysis', 'IF Gemini Analysis OK');
conn('Gemini Lead Analysis', 'Handle Gemini Analysis Error', 1, 0);
conn('IF Gemini Analysis OK', 'Parse AI Analysis JSON', 0, 0);
conn('IF Gemini Analysis OK', 'Handle Gemini Analysis Error', 1, 0);
conn('Parse AI Analysis JSON', 'ICP Weighted Scoring');
conn('Handle Gemini Analysis Error', 'ICP Weighted Scoring');
conn('ICP Weighted Scoring', 'Route ICP Priority');
conn('Route ICP Priority', 'Wait Gemini Personalize', 0, 0);
conn('Route ICP Priority', 'Wait Gemini Personalize', 1, 0);
conn('Route ICP Priority', 'Archive Low ICP', 2, 0);
conn('Wait Gemini Personalize', 'Gemini Personalization');
conn('Gemini Personalization', 'Parse Personalization JSON');
conn('Gemini Personalization', 'Handle Gemini Personalize Error', 1, 0);
conn('Parse Personalization JSON', 'Edit Fields - Lead Record');
conn('Handle Gemini Personalize Error', 'Edit Fields - Lead Record');
conn('Edit Fields - Lead Record', 'Merge Outreach Paths', 0, 0);
conn('Archive Low ICP', 'Merge Outreach Paths', 0, 1);
conn('Merge Outreach Paths', 'Sheets Append Lead');
conn('Sheets Append Lead', 'Loop Scrape Batches');
conn('Loop Scrape Batches', 'Split Scrape Batches');
conn('Split Scrape Batches', 'Read Leads For Outreach', 1, 0);

conn('Read Leads For Outreach', 'Filter Ready To Send');
conn('Filter Ready To Send', 'Split Outreach Batches');
conn('Split Outreach Batches', 'IF Not Already Contacted');
conn('Split Outreach Batches', 'Run Follow-up Pass', 1, 0);
conn('IF Not Already Contacted', 'Gmail Send Initial', 0, 0);
conn('Gmail Send Initial', 'Sheets Update Contacted');
conn('Sheets Update Contacted', 'Split Outreach Batches');
conn('Handle Serper Error', 'Loop Discovery Batches');
conn('Loop Discovery Batches', 'Split Discovery Batches');
conn('Run Follow-up Pass', 'Read Active Outreach Leads');

conn('Read Active Outreach Leads', 'Filter Follow-up Candidates');
conn('Filter Follow-up Candidates', 'Split Follow-up Batches');
conn('Split Follow-up Batches', 'Gmail Check Replies');
conn('Gmail Check Replies', 'IF Reply Detected');
conn('IF Reply Detected', 'Sheets Mark Replied', 0, 0);
conn('Sheets Mark Replied', 'Log High Intent Reply');
conn('Log High Intent Reply', 'IF High Intent Webhook Enabled');
conn('IF High Intent Webhook Enabled', 'HTTP Alert High Intent', 0, 0);
conn('IF High Intent Webhook Enabled', 'Split Follow-up Batches', 1, 0);
conn('HTTP Alert High Intent', 'Split Follow-up Batches');
conn('IF Reply Detected', 'Switch Follow-up Stage', 1, 0);
conn('Switch Follow-up Stage', 'Gmail Send Follow-up 1', 0, 0);
conn('Gmail Send Follow-up 1', 'Sheets Update Follow-up 1');
conn('Sheets Update Follow-up 1', 'Split Follow-up Batches');
conn('Switch Follow-up Stage', 'Gmail Send Follow-up 2', 1, 0);
conn('Gmail Send Follow-up 2', 'Sheets Update Follow-up 2');
conn('Sheets Update Follow-up 2', 'Split Follow-up Batches');
conn('Switch Follow-up Stage', 'Gmail Send Breakup', 2, 0);
conn('Gmail Send Breakup', 'Sheets Update Breakup');
conn('Sheets Update Breakup', 'Split Follow-up Batches');

conn('Error Trigger', 'Log Error Payload');
conn('Log Error Payload', 'Sheets Log Error');
conn('Sheets Log Error', 'IF Error Webhook Enabled');

const workflow = {
  name: 'CognixAI Labs - Outbound Lead Intelligence (Gemini)',
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
    instanceId: 'cognix-local-windows-gemini',
  },
  tags: [{ name: 'cognix' }, { name: 'outbound' }, { name: 'gemini' }, { name: 'production' }],
};

const outPath = new URL('./cognix-outbound-lead-intelligence.json', import.meta.url);
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
console.log('Written', outPath.pathname, 'nodes:', nodes.length, 'missing links:', missing);
