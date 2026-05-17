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
  parameters: [{ name: 'Content-Type', value: 'application/json' }],
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
nodes.push(node('Manual Trigger', 'n8n-nodes-base.manualTrigger', [-3400, 0], {}));
nodes.push(
  node('Schedule - Discovery', 'n8n-nodes-base.scheduleTrigger', [-3400, -220], {
    rule: { interval: [{ field: 'cronExpression', expression: '0 6 * * 1,3,5' }] },
  })
);
nodes.push(
  node('Schedule - LinkedIn Engagement', 'n8n-nodes-base.scheduleTrigger', [-3400, 220], {
    rule: { interval: [{ field: 'cronExpression', expression: '0 9,14 * * *' }] },
  }, { notes: 'Runs twice daily for human-paced LinkedIn stages (view → connect → message).' })
);
nodes.push(
  node('Merge Triggers', 'n8n-nodes-base.merge', [-3160, 0], { mode: 'append', numberInputs: 3 })
);
nodes.push(
  node('Workflow Config', 'n8n-nodes-base.set', [-2920, 0], {
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
            '=["AI SaaS company site:linkedin.com/company","B2B SaaS startup founder site:linkedin.com/in","recruitment agency workflow automation","agency scaling operations team","workflow-heavy SaaS company careers"]',
          type: 'array',
        },
        { id: uid(), name: 'discoveryBatchSize', value: 5, type: 'number' },
        { id: uid(), name: 'scrapeBatchSize', value: 2, type: 'number' },
        { id: uid(), name: 'engagementBatchSize', value: 3, type: 'number' },
        { id: uid(), name: 'serperWaitMs', value: 2000, type: 'number' },
        { id: uid(), name: 'firecrawlWaitMs', value: 3000, type: 'number' },
        { id: uid(), name: 'geminiWaitMs', value: 1200, type: 'number' },
        { id: uid(), name: 'maxScrapeChars', value: 8000, type: 'number' },
        { id: uid(), name: 'maxProfileViewsPerDay', value: 40, type: 'number' },
        { id: uid(), name: 'maxConnectionsPerDay', value: 20, type: 'number' },
        { id: uid(), name: 'connectionWaitHours', value: 2, type: 'number' },
        { id: uid(), name: 'messageWaitDays', value: 2, type: 'number' },
        { id: uid(), name: 'brandName', value: 'CognixAI Labs', type: 'string' },
      ],
    },
    options: {},
  }, {
    notes:
      'Env: GEMINI_API_KEY, SERPER_API_KEY, FIRECRAWL_API_KEY, COGNIX_LEADS_SHEET_ID. Optional: APIFY_API_TOKEN, COGNIX_PLAYWRIGHT_WEBHOOK_URL, COGNIX_ERROR_WEBHOOK_URL. No email vars.',
  })
);
nodes.push(
  node('Detect Run Mode', 'n8n-nodes-base.code', [-2680, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const config = $input.first().json;
if (!config.spreadsheetId) {
  throw new Error('COGNIX_LEADS_SHEET_ID is required.');
}
if (!$env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is required.');
}
const discoveryRan = $('Schedule - Discovery').isExecuted;
const engagementRan = $('Schedule - LinkedIn Engagement').isExecuted;
const manualRan = $('Manual Trigger').isExecuted;
let runMode = 'full';
if (engagementRan && !discoveryRan && !manualRan) runMode = 'linkedin_only';
else if (discoveryRan && !manualRan) runMode = 'discovery_pipeline';
else if (manualRan) runMode = 'full';
return [{ json: { ...config, runMode } }];`,
  })
);
nodes.push(
  node('Route Run Mode', 'n8n-nodes-base.switch', [-2440, 0], {
    mode: 'rules',
    rules: {
      values: [
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ $json.runMode }}',
                rightValue: 'linkedin_only',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'linkedin_only',
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
  node('Read Existing Leads', 'n8n-nodes-base.googleSheets', [-2200, -420], {
    operation: 'read',
    documentId: { __rl: true, value: '={{ $json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $json.sheetName }}', mode: 'name' },
    options: { rangeDefinition: 'specifyRange', range: 'A:AZ' },
  })
);
nodes.push(
  node('Build Dedup Index', 'n8n-nodes-base.code', [-1960, -420], {
    mode: 'runOnceForAllItems',
    jsCode: `const config = $('Detect Run Mode').first().json;
const rows = $input.all().map((i) => i.json).filter((r) => r.lead_id || r.company_name);
const seenDomains = new Set();
const seenNames = new Set();
const seenFounderUrls = new Set();
const today = new Date().toISOString().slice(0, 10);
let viewsToday = 0;
let connectionsToday = 0;
for (const r of rows) {
  const website = String(r.website || r.Website || '')
    .toLowerCase()
    .replace(/^https?:\\/\\//, '')
    .replace(/\\/$/, '')
    .split('/')[0];
  const name = String(r.company_name || r['Company Name'] || '').toLowerCase().trim();
  const founderUrl = String(r.founder_linkedin_url || r['founder_linkedin_url'] || '').toLowerCase().trim();
  if (website) seenDomains.add(website);
  if (name) seenNames.add(name);
  if (founderUrl) seenFounderUrls.add(founderUrl);
  if (String(r.viewed_at || '').startsWith(today)) viewsToday++;
  if (String(r.connection_requested_at || '').startsWith(today)) connectionsToday++;
}
return [{
  json: {
    ...config,
    seenDomains: [...seenDomains],
    seenNames: [...seenNames],
    seenFounderUrls: [...seenFounderUrls],
    existingRowCount: rows.length,
    viewsToday,
    connectionsToday,
    allRows: rows,
  },
}];`,
  })
);

// ============ DISCOVERY ============
nodes.push(
  node('Build Discovery Queries', 'n8n-nodes-base.code', [-1720, -420], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $input.first().json;
let queries = cfg.serperQueries;
if (typeof queries === 'string') {
  try { queries = JSON.parse(queries); } catch { queries = []; }
}
if (!Array.isArray(queries)) queries = [];
const items = queries.map((q, idx) => ({
  json: { ...cfg, searchQuery: q, page: 1, maxPages: 2, queryIndex: idx },
}));
return items.length
  ? items
  : [{ json: { ...cfg, searchQuery: 'B2B SaaS AI automation company site:linkedin.com/company', page: 1, maxPages: 1, queryIndex: 0 } }];`,
  })
);
nodes.push(
  node('Split Discovery Batches', 'n8n-nodes-base.splitInBatches', [-1480, -420], {
    batchSize: '={{ $json.discoveryBatchSize || 5 }}',
    options: { reset: false },
  })
);
nodes.push(
  node('Serper Search', 'n8n-nodes-base.httpRequest', [-1240, -420], {
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
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Wait Serper Rate Limit', 'n8n-nodes-base.wait', [-1000, -420], {
    resume: 'timeInterval',
    amount: '={{ $("Workflow Config").first().json.serperWaitMs || 2000 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Parse Serper Results', 'n8n-nodes-base.code', [-760, -420], {
    mode: 'runOnceForAllItems',
    jsCode: `const src = $('Split Discovery Batches').first().json;
const body = $input.first().json;
const organic = body.organic || [];
const companies = organic
  .map((r, i) => {
    const link = r.link || '';
    let website = link;
    let linkedin_company_url = '';
    if (link.includes('linkedin.com/company')) {
      linkedin_company_url = link.split('?')[0];
      website = (r.snippet || '').match(/https?:\\/\\/[^\\s)]+/)?.[0] || '';
    } else if (!link.includes('linkedin.com')) {
      website = link;
    }
    const domain = String(website).replace(/^https?:\\/\\//, '').split('/')[0];
    return {
      lead_id: 'cognix_' + Date.now() + '_' + src.queryIndex + '_' + i,
      company_name: (r.title || '').split('|')[0].split('-')[0].trim() || r.title || 'Unknown Company',
      website: website.startsWith('http') ? website : domain ? 'https://' + domain : '',
      linkedin_company_url,
      founder_name: '',
      founder_linkedin_url: '',
      description: r.snippet || '',
      source_query: src.searchQuery,
      status: 'discovered',
      replied: false,
      notes: '',
      created_at: new Date().toISOString(),
    };
  })
  .filter((c) => c.company_name);
return companies.map((json) => ({ json }));`,
  })
);
nodes.push(
  node('IF More Serper Pages', 'n8n-nodes-base.if', [-520, -540], {
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
  node('Increment Serper Page', 'n8n-nodes-base.set', [-280, -660], {
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
  node('Dedupe Companies', 'n8n-nodes-base.code', [-520, -420], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $('Build Dedup Index').first().json;
const seenDomains = new Set(cfg.seenDomains || []);
const seenNames = new Set(cfg.seenNames || []);
const unique = [];
const localDomains = new Set();
for (const item of $input.all()) {
  const c = item.json;
  const domain = String(c.website || '').toLowerCase().replace(/^https?:\\/\\//, '').replace(/\\/$/, '').split('/')[0];
  const name = String(c.company_name || '').toLowerCase().trim();
  if (!name) continue;
  if (domain && (seenDomains.has(domain) || localDomains.has(domain))) continue;
  if (seenNames.has(name)) continue;
  if (domain) { localDomains.add(domain); seenDomains.add(domain); }
  seenNames.add(name);
  unique.push({ json: c });
}
return unique;`,
  })
);
nodes.push(
  node('IF Has New Companies', 'n8n-nodes-base.if', [-280, -420], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [
        { leftValue: '={{ $input.all().length }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('IF Apify Enabled', 'n8n-nodes-base.if', [-160, -420], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        { leftValue: '={{ $env.APIFY_API_TOKEN }}', rightValue: '', operator: { type: 'string', operation: 'notEmpty' } },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('Apify Optional Enrich', 'n8n-nodes-base.httpRequest', [40, -500], {
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
  node('Skip Apify Pass-through', 'n8n-nodes-base.code', [40, -340], {
    mode: 'runOnceForEachItem',
    jsCode: 'return { json: { ...$json, apify_enriched: false } };',
  })
);
nodes.push(
  node('Merge Apify Enrichment', 'n8n-nodes-base.code', [160, -420], {
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
  node('Merge Apify Skip', 'n8n-nodes-base.code', [160, -340], {
    mode: 'runOnceForEachItem',
    jsCode: 'return { json: $json };',
  })
);
nodes.push(
  node('Merge Enrich Paths', 'n8n-nodes-base.merge', [280, -420], { mode: 'append', numberInputs: 2 })
);

// ============ FIRECRAWL ============
nodes.push(
  node('Split Scrape Batches', 'n8n-nodes-base.splitInBatches', [400, -420], {
    batchSize: '={{ $("Build Dedup Index").first().json.scrapeBatchSize || 2 }}',
    options: { reset: false },
  })
);
nodes.push(
  node('Attach Lead Context', 'n8n-nodes-base.code', [560, -420], {
    mode: 'runOnceForEachItem',
    jsCode: `const cfg = $('Build Dedup Index').first().json;
const lead = $json;
return { json: { ...cfg, ...lead, _lead_ref: lead.lead_id, website: lead.website || '' } };`,
  })
);
nodes.push(
  node('Firecrawl Homepage', 'n8n-nodes-base.httpRequest', [760, -420], {
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
  node('Wait Firecrawl Rate Limit', 'n8n-nodes-base.wait', [1000, -420], {
    resume: 'timeInterval',
    amount: '={{ $("Workflow Config").first().json.firecrawlWaitMs || 3000 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Firecrawl About', 'n8n-nodes-base.httpRequest', [1240, -420], {
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
  url: ($("Attach Lead Context").first().json.website || "").replace(/\\/$/, "") + "/about",
  formats: ["markdown"],
  onlyMainContent: true,
  timeout: 60000
}) }}`,
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Extract Scrape Signals', 'n8n-nodes-base.code', [1480, -420], {
    mode: 'runOnceForEachItem',
    jsCode: `const company = $('Attach Lead Context').first().json;
const maxChars = Number(company.maxScrapeChars) || 8000;
const slice = (v) => String(v || '').slice(0, maxChars);
const homepage = $('Firecrawl Homepage').first().json?.data?.markdown || $('Firecrawl Homepage').first().json?.markdown || '';
const about = $('Firecrawl About').first().json?.data?.markdown || '';
const combined = [homepage, about].join('\\n').toLowerCase();
const count = (term) => (combined.match(new RegExp(term, 'gi')) || []).length;
return {
  json: {
    lead_id: company.lead_id,
    company_name: company.company_name,
    website: company.website,
    linkedin_company_url: company.linkedin_company_url || '',
    founder_name: company.founder_name || '',
    founder_linkedin_url: company.founder_linkedin_url || '',
    description: company.description,
    source_query: company.source_query,
    scraped_homepage: slice(homepage),
    scraped_about: slice(about),
    signals: {
      ai_mentions: count('\\\\b(ai|artificial intelligence|llm|gemini|machine learning)\\\\b'),
      automation_mentions: count('\\\\b(automation|automate|workflow|orchestrat)\\\\b'),
      hiring_mentions: count('\\\\b(hiring|careers|founder|ceo|cto)\\\\b'),
      support_mentions: count('\\\\b(support|customer success|operations)\\\\b'),
    },
    status: 'scraped',
    replied: false,
    notes: company.notes || '',
    created_at: company.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
};`,
  })
);

// ============ GEMINI ANALYSIS ============
nodes.push(
  node('Wait Gemini Rate Limit', 'n8n-nodes-base.wait', [1720, -420], {
    resume: 'timeInterval',
    amount: '={{ $("Workflow Config").first().json.geminiWaitMs || 1200 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Gemini Company Analysis', 'n8n-nodes-base.httpRequest', [1960, -420], {
    method: 'POST',
    url: geminiUrlExpr,
    sendHeaders: true,
    headerParameters: geminiHeaders,
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  contents: [{
    parts: [{
      text: "You are a B2B relationship analyst for CognixAI Labs (warm networking, not sales spam). Return STRICT JSON only with keys: ai_readiness_score, operational_complexity_score, founder_fit_score, relationship_angle, likely_pain_points, workflow_complexity, summary. Scores 0-100 except founder_fit_score. No markdown.\\n\\nCompany: " + $json.company_name + "\\nWebsite: " + $json.website + "\\nLinkedIn company: " + ($json.linkedin_company_url || "") + "\\nDescription: " + ($json.description || "") + "\\nSignals: " + JSON.stringify($json.signals || {}) + "\\nHomepage: " + ($json.scraped_homepage || "").slice(0, 3500) + "\\nAbout: " + ($json.scraped_about || "").slice(0, 2000)
    }]
  }],
  generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
}) }}`,
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('IF Gemini Analysis OK', 'n8n-nodes-base.if', [2200, -420], {
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
  node('Parse AI Analysis JSON', 'n8n-nodes-base.code', [2440, -420], {
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
    founder_fit_score: 50,
    relationship_angle: 'shared interest in operational intelligence',
    likely_pain_points: [],
  };
}
return { json: { ...lead, ...analysis, status: 'analyzed', updated_at: new Date().toISOString() } };`,
  })
);
nodes.push(
  node('Handle Gemini Analysis Error', 'n8n-nodes-base.code', [2440, -240], {
    mode: 'runOnceForEachItem',
    jsCode: `const lead = $('Extract Scrape Signals').first().json;
return {
  json: {
    ...lead,
    error_log: $json.error?.message || 'Gemini analysis failed',
    status: 'analysis_failed',
    ai_readiness_score: 40,
    operational_complexity_score: 50,
    founder_fit_score: 45,
    relationship_angle: 'operational scaling',
    likely_pain_points: [],
    summary: 'Fallback scoring after Gemini error',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('ICP Weighted Scoring', 'n8n-nodes-base.code', [2680, -420], {
    mode: 'runOnceForEachItem',
    jsCode: `const l = $input.first().json;
const s = l.signals || {};
const norm = (v, max = 10) => Math.min(100, (Number(v) || 0) / max * 100);
const score =
  norm(s.ai_mentions) * 0.18 +
  norm(s.automation_mentions) * 0.15 +
  norm(s.hiring_mentions) * 0.12 +
  norm(s.support_mentions) * 0.1 +
  (Number(l.ai_readiness_score) || 50) * 0.15 +
  (Number(l.operational_complexity_score) || 50) * 0.1 +
  (Number(l.founder_fit_score) || 50) * 0.2;
const icp_score = Math.round(Math.min(100, Math.max(0, score)));
let priority = 'low';
if (icp_score >= 75) priority = 'high';
else if (icp_score >= 50) priority = 'medium';
const status = priority === 'low' ? 'archived' : 'scored';
return {
  json: {
    ...l,
    icp_score,
    priority,
    status,
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('Route ICP Priority', 'n8n-nodes-base.switch', [2920, -420], {
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

// ============ LINKEDIN URL + FOUNDER DISCOVERY ============
nodes.push(
  node('Serper Find LinkedIn', 'n8n-nodes-base.httpRequest', [3160, -560], {
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
      '={{ JSON.stringify({ q: $json.company_name + " site:linkedin.com/company OR site:linkedin.com/in founder CEO", num: 8 }) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Parse LinkedIn Serper', 'n8n-nodes-base.code', [3400, -560], {
    mode: 'runOnceForEachItem',
    jsCode: `const lead = $('ICP Weighted Scoring').first().json;
const organic = $input.first().json.organic || [];
let linkedin_company_url = lead.linkedin_company_url || '';
let founder_linkedin_url = lead.founder_linkedin_url || '';
let founder_name = lead.founder_name || '';
for (const r of organic) {
  const link = (r.link || '').split('?')[0];
  if (!linkedin_company_url && link.includes('linkedin.com/company')) linkedin_company_url = link;
  if (!founder_linkedin_url && link.includes('linkedin.com/in/')) {
    founder_linkedin_url = link;
    founder_name = founder_name || (r.title || '').split('|')[0].split('-')[0].trim();
  }
}
return {
  json: {
    ...lead,
    linkedin_company_url,
    founder_linkedin_url,
    founder_name,
    status: lead.status === 'archived' ? 'archived' : 'linkedin_resolved',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('Wait Gemini LinkedIn', 'n8n-nodes-base.wait', [3640, -560], {
    resume: 'timeInterval',
    amount: '={{ $("Workflow Config").first().json.geminiWaitMs || 1200 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Gemini Founder Resolve', 'n8n-nodes-base.httpRequest', [3880, -560], {
    method: 'POST',
    url: geminiUrlExpr,
    sendHeaders: true,
    headerParameters: geminiHeaders,
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  contents: [{
    parts: [{
      text: "Identify the best founder or decision-maker for warm LinkedIn networking (not sales). Return STRICT JSON only: founder_name, founder_title, founder_linkedin_url (full URL or empty), linkedin_company_url (full URL or empty), confidence (0-1), notes. Prefer CEO/founder/COO. No markdown.\\n\\nCompany: " + $json.company_name + "\\nWebsite: " + $json.website + "\\nKnown company LinkedIn: " + ($json.linkedin_company_url || "") + "\\nKnown founder URL: " + ($json.founder_linkedin_url || "") + "\\nSummary: " + ($json.summary || "")
    }]
  }],
  generationConfig: { temperature: 0.25, responseMimeType: "application/json" }
}) }}`,
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Parse Founder JSON', 'n8n-nodes-base.code', [4120, -560], {
    mode: 'runOnceForEachItem',
    jsCode: `${PARSE_GEMINI_HELPERS}
const lead = $('Parse LinkedIn Serper').first().json;
const text = extractGeminiText($input.first().json);
let f = parseStrictJson(text);
if (!f || typeof f !== 'object') f = {};
const founder_linkedin_url = f.founder_linkedin_url || lead.founder_linkedin_url || '';
const linkedin_company_url = f.linkedin_company_url || lead.linkedin_company_url || '';
if (!founder_linkedin_url && lead.priority !== 'low') {
  return { json: { ...lead, ...f, linkedin_company_url, status: 'needs_manual_founder', notes: (lead.notes || '') + ' | Founder URL not found' } };
}
return {
  json: {
    ...lead,
    founder_name: f.founder_name || lead.founder_name || '',
    founder_linkedin_url,
    linkedin_company_url,
    notes: [lead.notes, f.notes].filter(Boolean).join(' | '),
    status: lead.status === 'archived' ? 'archived' : 'queued',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('Gemini LinkedIn Copy', 'n8n-nodes-base.httpRequest', [4360, -560], {
    method: 'POST',
    url: geminiUrlExpr,
    sendHeaders: true,
    headerParameters: geminiHeaders,
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  contents: [{
    parts: [{
      text: "Write warm, founder-level LinkedIn relationship copy for CognixAI Labs. NO sales pitch. Return STRICT JSON only: connection_note (max 280 chars, optional note for connection request), relationship_message (max 500 chars, send 2 days after connect, curious not pitchy), profile_view_context (1 sentence why view profile), notes. No markdown.\\n\\nContext: " + JSON.stringify({
        company_name: $json.company_name,
        founder_name: $json.founder_name,
        relationship_angle: $json.relationship_angle,
        icp_score: $json.icp_score,
        summary: $json.summary,
        likely_pain_points: $json.likely_pain_points
      })
    }]
  }],
  generationConfig: { temperature: 0.55, responseMimeType: "application/json" }
}) }}`,
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Parse LinkedIn Copy JSON', 'n8n-nodes-base.code', [4600, -560], {
    mode: 'runOnceForEachItem',
    jsCode: `${PARSE_GEMINI_HELPERS}
const lead = $('Parse Founder JSON').first().json;
if (lead.status === 'archived' || lead.status === 'needs_manual_founder') {
  return { json: lead };
}
const text = extractGeminiText($input.first().json);
let copy = parseStrictJson(text);
if (!copy || typeof copy !== 'object') {
  copy = {
    connection_note: 'Hi ' + (lead.founder_name || 'there') + ' — enjoyed learning about ' + (lead.company_name || 'your work') + '. Would love to connect.',
    relationship_message: 'Thanks for connecting. Curious how you are thinking about operational workflows as you scale — always learning from founders building in this space.',
    profile_view_context: 'Researching founders building AI-forward ops teams.',
    notes: 'Gemini copy fallback',
  };
}
return {
  json: {
    ...lead,
    ...copy,
    status: 'queued',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('Archive Low ICP', 'n8n-nodes-base.set', [3160, -240], {
    mode: 'manual',
    assignments: {
      assignments: [
        { id: uid(), name: 'status', value: 'archived', type: 'string' },
        { id: uid(), name: 'priority', value: 'low', type: 'string' },
      ],
    },
    includeOtherFields: true,
  })
);
nodes.push(
  node('Merge Scored Paths', 'n8n-nodes-base.merge', [4840, -420], { mode: 'append', numberInputs: 2 })
);
nodes.push(
  node('Sheets Append Lead', 'n8n-nodes-base.googleSheets', [5080, -420], {
    operation: 'append',
    documentId: { __rl: true, value: '={{ $("Build Dedup Index").first().json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $("Build Dedup Index").first().json.sheetName }}', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        lead_id: '={{ $json.lead_id }}',
        company_name: '={{ $json.company_name }}',
        website: '={{ $json.website }}',
        linkedin_company_url: '={{ $json.linkedin_company_url }}',
        founder_name: '={{ $json.founder_name }}',
        founder_linkedin_url: '={{ $json.founder_linkedin_url }}',
        icp_score: '={{ $json.icp_score }}',
        priority: '={{ $json.priority }}',
        status: '={{ $json.status }}',
        viewed_at: '={{ $json.viewed_at || "" }}',
        connection_requested_at: '={{ $json.connection_requested_at || "" }}',
        relationship_message_sent_at: '={{ $json.relationship_message_sent_at || "" }}',
        replied: '={{ $json.replied || false }}',
        notes: '={{ $json.notes || "" }}',
        connection_note: '={{ $json.connection_note || "" }}',
        relationship_message: '={{ $json.relationship_message || "" }}',
        profile_view_context: '={{ $json.profile_view_context || "" }}',
        summary: '={{ $json.summary || "" }}',
        error_log: '={{ $json.error_log || "" }}',
        created_at: '={{ $json.created_at }}',
        updated_at: '={{ $json.updated_at }}',
      },
    },
    options: { cellFormat: 'USER_ENTERED' },
  })
);
nodes.push(
  node('Loop Scrape Batches', 'n8n-nodes-base.code', [5320, -420], {
    mode: 'runOnceForAllItems',
    jsCode: 'return [{ json: { batch_continue: true } }];',
  })
);
nodes.push(
  node('Loop Discovery Batches', 'n8n-nodes-base.code', [0, -580], {
    mode: 'runOnceForAllItems',
    jsCode: 'return [{ json: { loop: true } }];',
  })
);
nodes.push(
  node('Handle Serper Error', 'n8n-nodes-base.set', [-1240, -200], {
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
  node('Start LinkedIn Engagement Pass', 'n8n-nodes-base.code', [5560, -420], {
    mode: 'runOnceForAllItems',
    jsCode: `return [{ json: { ...$('Build Dedup Index').first().json, triggerLinkedIn: true } }];`,
  })
);

// ============ LINKEDIN ENGAGEMENT ============
nodes.push(
  node('Read Leads For Engagement', 'n8n-nodes-base.googleSheets', [-2200, 420], {
    operation: 'read',
    documentId: { __rl: true, value: '={{ $json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $json.sheetName }}', mode: 'name' },
    options: { rangeDefinition: 'specifyRange', range: 'A:AZ' },
  })
);
nodes.push(
  node('Compute Daily Limits', 'n8n-nodes-base.code', [-1960, 420], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $('Detect Run Mode').first().json;
const rows = $input.all().map((i) => i.json);
const today = new Date().toISOString().slice(0, 10);
let viewsToday = 0;
let connectionsToday = 0;
for (const r of rows) {
  if (String(r.viewed_at || r['viewed_at'] || '').startsWith(today)) viewsToday++;
  if (String(r.connection_requested_at || r['connection_requested_at'] || '').startsWith(today)) connectionsToday++;
}
return [{
  json: {
    ...cfg,
    viewsToday,
    connectionsToday,
    viewsRemaining: Math.max(0, (cfg.maxProfileViewsPerDay || 40) - viewsToday),
    connectionsRemaining: Math.max(0, (cfg.maxConnectionsPerDay || 20) - connectionsToday),
    allRows: rows,
  },
}];`,
  })
);
nodes.push(
  node('Filter Stage - View Profile', 'n8n-nodes-base.code', [-1720, 280], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $('Compute Daily Limits').first().json;
if (cfg.viewsRemaining <= 0) return [];
const seen = new Set(cfg.allRows.map((r) => String(r.founder_linkedin_url || '').toLowerCase()).filter(Boolean));
const items = (cfg.allRows || []).filter((r) => {
  const status = String(r.status || '');
  const url = String(r.founder_linkedin_url || r['founder_linkedin_url'] || '');
  const viewed = r.viewed_at || r['viewed_at'] || '';
  const replied = r.replied === true || r.replied === 'TRUE';
  if (replied || !url.includes('linkedin.com/in')) return false;
  if (!['queued', 'scored', 'linkedin_resolved'].includes(status)) return false;
  if (viewed) return false;
  if (seen.has(url.toLowerCase()) && viewed) return false;
  return (Number(r.icp_score) || 0) >= 50;
});
return items.slice(0, cfg.engagementBatchSize || 3).map((json) => ({ json: { ...cfg, ...json, linkedin_action: 'view_profile' } }));`,
  })
);
nodes.push(
  node('Filter Stage - Connection Request', 'n8n-nodes-base.code', [-1720, 420], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $('Compute Daily Limits').first().json;
if (cfg.connectionsRemaining <= 0) return [];
const waitMs = (cfg.connectionWaitHours || 2) * 3600000;
const now = Date.now();
const items = (cfg.allRows || []).filter((r) => {
  const status = String(r.status || '');
  const viewedAt = Date.parse(r.viewed_at || r['viewed_at'] || 0);
  const connAt = r.connection_requested_at || r['connection_requested_at'] || '';
  const replied = r.replied === true || r.replied === 'TRUE';
  if (replied || connAt) return false;
  if (status !== 'viewed') return false;
  if (!viewedAt || now - viewedAt < waitMs) return false;
  return String(r.founder_linkedin_url || '').includes('linkedin.com/in');
});
return items.slice(0, cfg.engagementBatchSize || 3).map((json) => ({ json: { ...cfg, ...json, linkedin_action: 'connection_request' } }));`,
  })
);
nodes.push(
  node('Filter Stage - Relationship Message', 'n8n-nodes-base.code', [-1720, 560], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $('Compute Daily Limits').first().json;
const waitMs = (cfg.messageWaitDays || 2) * 86400000;
const now = Date.now();
const items = (cfg.allRows || []).filter((r) => {
  const status = String(r.status || '');
  const connAt = Date.parse(r.connection_requested_at || r['connection_requested_at'] || 0);
  const msgAt = r.relationship_message_sent_at || r['relationship_message_sent_at'] || '';
  const replied = r.replied === true || r.replied === 'TRUE';
  if (replied || msgAt) return false;
  if (status !== 'connection_requested') return false;
  if (!connAt || now - connAt < waitMs) return false;
  return String(r.founder_linkedin_url || '').includes('linkedin.com/in');
});
return items.slice(0, cfg.engagementBatchSize || 3).map((json) => ({ json: { ...cfg, ...json, linkedin_action: 'relationship_message' } }));`,
  })
);
nodes.push(
  node('Merge Engagement Queues', 'n8n-nodes-base.merge', [-1480, 420], { mode: 'append', numberInputs: 3 })
);
nodes.push(
  node('IF Has Engagement Items', 'n8n-nodes-base.if', [-1240, 420], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [
        { leftValue: '={{ $input.all().length }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('Split Engagement Batches', 'n8n-nodes-base.splitInBatches', [-1000, 420], {
    batchSize: 1,
    options: { reset: false },
  })
);
nodes.push(
  node('Random Human Delay', 'n8n-nodes-base.code', [-760, 420], {
    mode: 'runOnceForEachItem',
    jsCode: `const minMs = 45000;
const maxMs = 120000;
const delayMs = Math.floor(minMs + Math.random() * (maxMs - minMs));
return { json: { ...$json, delayMs, jitter_note: 'Randomized delay for LinkedIn safety' } };`,
  })
);
nodes.push(
  node('Wait Human Pacing', 'n8n-nodes-base.wait', [-520, 420], {
    resume: 'timeInterval',
    amount: '={{ $json.delayMs }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Route LinkedIn Action', 'n8n-nodes-base.switch', [-280, 420], {
    mode: 'rules',
    rules: {
      values: [
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ $json.linkedin_action }}',
                rightValue: 'view_profile',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'view_profile',
        },
        {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
            conditions: [
              {
                leftValue: '={{ $json.linkedin_action }}',
                rightValue: 'connection_request',
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: 'connection_request',
        },
      ],
    },
    options: { fallbackOutput: 'extra', fallbackOutputName: 'relationship_message' },
  })
);

// LinkedIn browser actions via external webhook (COGNIX_PLAYWRIGHT_WEBHOOK_URL)
const playwrightPayload = (action) =>
  `={{ JSON.stringify({
  action: "${action}",
  lead_id: $json.lead_id,
  founder_name: $json.founder_name,
  founder_linkedin_url: $json.founder_linkedin_url,
  linkedin_company_url: $json.linkedin_company_url,
  connection_note: $json.connection_note || "",
  relationship_message: $json.relationship_message || "",
  profile_view_context: $json.profile_view_context || "",
  company_name: $json.company_name,
  callback_secret: $env.COGNIX_PLAYWRIGHT_CALLBACK_SECRET || ""
}) }}`;

nodes.push(
  node('IF Playwright Webhook Enabled', 'n8n-nodes-base.if', [-40, 280], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $env.COGNIX_PLAYWRIGHT_WEBHOOK_URL }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty' },
        },
      ],
      combinator: 'and',
    },
  }, { notes: 'POST to external Playwright runner when COGNIX_PLAYWRIGHT_WEBHOOK_URL is set.' })
);
nodes.push(
  node('Webhook Playwright View', 'n8n-nodes-base.httpRequest', [200, 200], {
    method: 'POST',
    url: '={{ $env.COGNIX_PLAYWRIGHT_WEBHOOK_URL }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Content-Type', value: 'application/json' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: playwrightPayload('view_profile'),
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Sheets Update Viewed', 'n8n-nodes-base.googleSheets', [440, 280], {
    operation: 'update',
    documentId: { __rl: true, value: '={{ $("Compute Daily Limits").first().json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $("Compute Daily Limits").first().json.sheetName }}', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        status: 'viewed',
        viewed_at: '={{ $now.toISO() }}',
        notes: '={{ ($json.notes || "") + " | profile viewed" }}',
        updated_at: '={{ $now.toISO() }}',
      },
      matchingColumns: ['lead_id'],
    },
    options: { cellFormat: 'USER_ENTERED' },
  })
);

nodes.push(
  node('IF Playwright Webhook Connect', 'n8n-nodes-base.if', [-40, 420], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $env.COGNIX_PLAYWRIGHT_WEBHOOK_URL }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty' },
        },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('Webhook Playwright Connect', 'n8n-nodes-base.httpRequest', [200, 340], {
    method: 'POST',
    url: '={{ $env.COGNIX_PLAYWRIGHT_WEBHOOK_URL }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Content-Type', value: 'application/json' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: playwrightPayload('connection_request'),
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Sheets Update Connection Requested', 'n8n-nodes-base.googleSheets', [440, 420], {
    operation: 'update',
    documentId: { __rl: true, value: '={{ $("Compute Daily Limits").first().json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $("Compute Daily Limits").first().json.sheetName }}', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        status: 'connection_requested',
        connection_requested_at: '={{ $now.toISO() }}',
        notes: '={{ ($json.notes || "") + " | connection requested" }}',
        updated_at: '={{ $now.toISO() }}',
      },
      matchingColumns: ['lead_id'],
    },
    options: { cellFormat: 'USER_ENTERED' },
  })
);

nodes.push(
  node('IF Playwright Webhook Message', 'n8n-nodes-base.if', [-40, 560], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $env.COGNIX_PLAYWRIGHT_WEBHOOK_URL }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty' },
        },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('Webhook Playwright Message', 'n8n-nodes-base.httpRequest', [200, 480], {
    method: 'POST',
    url: '={{ $env.COGNIX_PLAYWRIGHT_WEBHOOK_URL }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Content-Type', value: 'application/json' }],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: playwrightPayload('relationship_message'),
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Sheets Update Message Sent', 'n8n-nodes-base.googleSheets', [440, 560], {
    operation: 'update',
    documentId: { __rl: true, value: '={{ $("Compute Daily Limits").first().json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $("Compute Daily Limits").first().json.sheetName }}', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        status: 'awaiting_reply',
        relationship_message_sent_at: '={{ $now.toISO() }}',
        notes: '={{ ($json.notes || "") + " | relationship message sent — await manual reply" }}',
        updated_at: '={{ $now.toISO() }}',
      },
      matchingColumns: ['lead_id'],
    },
    options: { cellFormat: 'USER_ENTERED' },
  })
);
nodes.push(
  node('Merge Engagement Updates', 'n8n-nodes-base.merge', [920, 420], { mode: 'append', numberInputs: 3 })
);
nodes.push(
  node('Loop Engagement Batches', 'n8n-nodes-base.code', [1160, 420], {
    mode: 'runOnceForAllItems',
    jsCode: 'return [{ json: { loop: true } }];',
  })
);

// ============ ERROR HANDLING ============
nodes.push(node('Error Trigger', 'n8n-nodes-base.errorTrigger', [-3400, 720], {}));
nodes.push(
  node('Log Error Payload', 'n8n-nodes-base.code', [-3160, 720], {
    mode: 'runOnceForAllItems',
    jsCode: `return [{
  json: {
    workflow: 'CognixAI LinkedIn Relationship Intelligence',
    timestamp: new Date().toISOString(),
    execution_id: $execution.id,
    node: $input.first().json.execution?.lastNodeExecuted || 'unknown',
    message: $input.first().json.execution?.error?.message || JSON.stringify($input.first().json),
    stack: String($input.first().json.execution?.error?.stack || '').slice(0, 4000),
  },
}];`,
  })
);
nodes.push(
  node('Sheets Log Error', 'n8n-nodes-base.googleSheets', [-2920, 720], {
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
  node('IF Error Webhook Enabled', 'n8n-nodes-base.if', [-2680, 720], {
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
  node('HTTP Error Notify', 'n8n-nodes-base.httpRequest', [-2440, 720], {
    method: 'POST',
    url: '={{ $env.COGNIX_ERROR_WEBHOOK_URL }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);

nodes.push(
  node('NOTE Architecture', 'n8n-nodes-base.stickyNote', [-3600, -520], {
    content:
      '## CognixAI LinkedIn Relationship (Gemini)\n\nEnv: GEMINI_API_KEY, SERPER_API_KEY, FIRECRAWL_API_KEY, COGNIX_LEADS_SHEET_ID\nOptional: APIFY_API_TOKEN, COGNIX_PLAYWRIGHT_WEBHOOK_URL, COGNIX_PLAYWRIGHT_CALLBACK_SECRET, COGNIX_ERROR_WEBHOOK_URL\n\nNO EMAIL. Stages: view → wait 2h → connect → wait 2d → message → manual reply\nLimits: 40 views/day, 20 connections/day\nTriggers: Manual | Discovery Mon/Wed/Fri 06:00 | Engagement 09:00 & 14:00',
    height: 340,
    width: 560,
  })
);

// ============ CONNECTIONS ============
conn('Manual Trigger', 'Merge Triggers', 0, 0);
conn('Schedule - Discovery', 'Merge Triggers', 0, 1);
conn('Schedule - LinkedIn Engagement', 'Merge Triggers', 0, 2);
conn('Merge Triggers', 'Workflow Config');
conn('Workflow Config', 'Detect Run Mode');
conn('Detect Run Mode', 'Route Run Mode');

conn('Route Run Mode', 'Read Leads For Engagement', 0, 0);
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
conn('Wait Firecrawl Rate Limit', 'Firecrawl About');
conn('Firecrawl About', 'Extract Scrape Signals');
conn('Extract Scrape Signals', 'Wait Gemini Rate Limit');
conn('Wait Gemini Rate Limit', 'Gemini Company Analysis');
conn('Gemini Company Analysis', 'IF Gemini Analysis OK');
conn('Gemini Company Analysis', 'Handle Gemini Analysis Error', 1, 0);
conn('IF Gemini Analysis OK', 'Parse AI Analysis JSON', 0, 0);
conn('IF Gemini Analysis OK', 'Handle Gemini Analysis Error', 1, 0);
conn('Parse AI Analysis JSON', 'ICP Weighted Scoring');
conn('Handle Gemini Analysis Error', 'ICP Weighted Scoring');
conn('ICP Weighted Scoring', 'Route ICP Priority');
conn('Route ICP Priority', 'Serper Find LinkedIn', 0, 0);
conn('Route ICP Priority', 'Serper Find LinkedIn', 1, 0);
conn('Route ICP Priority', 'Archive Low ICP', 2, 0);
conn('Serper Find LinkedIn', 'Parse LinkedIn Serper');
conn('Parse LinkedIn Serper', 'Wait Gemini LinkedIn');
conn('Wait Gemini LinkedIn', 'Gemini Founder Resolve');
conn('Gemini Founder Resolve', 'Parse Founder JSON');
conn('Parse Founder JSON', 'Gemini LinkedIn Copy');
conn('Gemini LinkedIn Copy', 'Parse LinkedIn Copy JSON');
conn('Parse LinkedIn Copy JSON', 'Merge Scored Paths', 0, 0);
conn('Archive Low ICP', 'Merge Scored Paths', 0, 1);
conn('Merge Scored Paths', 'Sheets Append Lead');
conn('Sheets Append Lead', 'Loop Scrape Batches');
conn('Loop Scrape Batches', 'Split Scrape Batches');
conn('Split Scrape Batches', 'Start LinkedIn Engagement Pass', 1, 0);
conn('Start LinkedIn Engagement Pass', 'Read Leads For Engagement');
conn('Handle Serper Error', 'Loop Discovery Batches');
conn('Loop Discovery Batches', 'Split Discovery Batches');

conn('Read Leads For Engagement', 'Compute Daily Limits');
conn('Compute Daily Limits', 'Filter Stage - View Profile');
conn('Compute Daily Limits', 'Filter Stage - Connection Request');
conn('Compute Daily Limits', 'Filter Stage - Relationship Message');
conn('Filter Stage - View Profile', 'Merge Engagement Queues', 0, 0);
conn('Filter Stage - Connection Request', 'Merge Engagement Queues', 0, 1);
conn('Filter Stage - Relationship Message', 'Merge Engagement Queues', 0, 2);
conn('Merge Engagement Queues', 'IF Has Engagement Items');
conn('IF Has Engagement Items', 'Split Engagement Batches', 0, 0);
conn('IF Has Engagement Items', 'Loop Engagement Batches', 1, 0);
conn('Split Engagement Batches', 'Random Human Delay');
conn('Random Human Delay', 'Wait Human Pacing');
conn('Wait Human Pacing', 'Route LinkedIn Action');

conn('Route LinkedIn Action', 'IF Playwright Webhook Enabled', 0, 0);
conn('IF Playwright Webhook Enabled', 'Webhook Playwright View', 0, 0);
conn('IF Playwright Webhook Enabled', 'Loop Engagement Batches', 1, 0);
conn('Webhook Playwright View', 'Sheets Update Viewed');

conn('Route LinkedIn Action', 'IF Playwright Webhook Connect', 1, 0);
conn('IF Playwright Webhook Connect', 'Webhook Playwright Connect', 0, 0);
conn('IF Playwright Webhook Connect', 'Loop Engagement Batches', 1, 0);
conn('Webhook Playwright Connect', 'Sheets Update Connection Requested');

conn('Route LinkedIn Action', 'IF Playwright Webhook Message', 2, 0);
conn('IF Playwright Webhook Message', 'Webhook Playwright Message', 0, 0);
conn('IF Playwright Webhook Message', 'Loop Engagement Batches', 1, 0);
conn('Webhook Playwright Message', 'Sheets Update Message Sent');

conn('Sheets Update Viewed', 'Merge Engagement Updates', 0, 0);
conn('Sheets Update Connection Requested', 'Merge Engagement Updates', 0, 1);
conn('Sheets Update Message Sent', 'Merge Engagement Updates', 0, 2);
conn('Merge Engagement Updates', 'Loop Engagement Batches');
conn('Loop Engagement Batches', 'Split Engagement Batches');

conn('Error Trigger', 'Log Error Payload');
conn('Log Error Payload', 'Sheets Log Error');
conn('Sheets Log Error', 'IF Error Webhook Enabled');

const workflow = {
  name: 'CognixAI Labs - LinkedIn Relationship Intelligence (Gemini)',
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
    instanceId: 'cognix-local-windows-linkedin-gemini',
  },
  tags: [{ name: 'cognix' }, { name: 'linkedin' }, { name: 'gemini' }, { name: 'relationship' }],
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
console.log('Written', outPath.pathname, 'nodes:', nodes.length, 'missing links:', missing);
