import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';

const uid = () => randomUUID();

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
    'n8n-nodes-base.executeWorkflow': 1.2,
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
  retry: { enabled: true, maxTries: 3, waitBetween: 2000 },
  timeout: 120000,
};

const httpRetry = {
  options: retryOptions,
};

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
    rule: {
      interval: [{ field: 'cronExpression', expression: '0 6 * * 1,3,5' }],
    },
  })
);
nodes.push(
  node('Schedule - Follow-ups', 'n8n-nodes-base.scheduleTrigger', [-3200, 200], {
    rule: {
      interval: [{ field: 'cronExpression', expression: '0 9 * * *' }],
    },
  })
);
nodes.push(
  node('Merge Triggers', 'n8n-nodes-base.merge', [-2960, 0], {
    mode: 'append',
    numberInputs: 3,
  })
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
          value: "={{ $env.COGNIX_LEADS_SHEET_ID || 'REPLACE_WITH_GOOGLE_SHEET_ID' }}",
          type: 'string',
        },
        { id: uid(), name: 'sheetName', value: 'Leads', type: 'string' },
        {
          id: uid(),
          name: 'industries',
          value:
            '=["AI SaaS","B2B SaaS","recruitment agencies","workflow automation","operations-heavy B2B"]',
          type: 'array',
        },
        {
          id: uid(),
          name: 'serperQueries',
          value:
            '=["AI SaaS company site:linkedin.com/company","B2B SaaS startup hiring operations","recruitment agency workflow automation","agency scaling operations team","workflow-heavy SaaS company careers"]',
          type: 'array',
        },
        { id: uid(), name: 'discoveryBatchSize', value: 5, type: 'number' },
        { id: uid(), name: 'scrapeBatchSize', value: 3, type: 'number' },
        { id: uid(), name: 'outreachBatchSize', value: 10, type: 'number' },
        { id: uid(), name: 'serperWaitMs', value: 2000, type: 'number' },
        { id: uid(), name: 'firecrawlWaitMs', value: 3000, type: 'number' },
        { id: uid(), name: 'openaiWaitMs', value: 1500, type: 'number' },
        { id: uid(), name: 'fromEmail', value: "={{ $env.COGNIX_FROM_EMAIL || 'founder@cognixailabs.com' }}", type: 'string' },
        { id: uid(), name: 'senderName', value: 'CognixAI Labs', type: 'string' },
      ],
    },
    options: {},
  })
);
nodes.push(
  node('Detect Run Mode', 'n8n-nodes-base.code', [-2480, 0], {
    mode: 'runOnceForAllItems',
    jsCode: `const config = $input.first().json;
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
    options: { rangeDefinition: 'specifyRange', range: 'A:Z' },
  })
);
nodes.push(
  node('Build Dedup Index', 'n8n-nodes-base.code', [-1760, -400], {
    mode: 'runOnceForAllItems',
    jsCode: `const config = $('Detect Run Mode').first().json;
const rows = $input.all().map(i => i.json);
const seenDomains = new Set();
const seenNames = new Set();
for (const r of rows) {
  const website = (r.website || r.Website || '').toString().toLowerCase().replace(/^https?:\\/\\//,'').replace(/\\/$/,'');
  const name = (r.company_name || r['Company Name'] || '').toString().toLowerCase().trim();
  if (website) seenDomains.add(website);
  if (name) seenNames.add(name);
}
return [{ json: { ...config, seenDomains: [...seenDomains], seenNames: [...seenNames], existingRows: rows } }];`,
  })
);

// ============ DISCOVERY ============
nodes.push(
  node('Build Discovery Queries', 'n8n-nodes-base.code', [-1520, -400], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $input.first().json;
const queries = Array.isArray(cfg.serperQueries) ? cfg.serperQueries : JSON.parse(cfg.serperQueries || '[]');
const items = queries.map((q, idx) => ({
  json: {
    ...cfg,
    searchQuery: q,
    page: 1,
    maxPages: 3,
    queryIndex: idx,
  },
}));
return items.length ? items : [{ json: { ...cfg, searchQuery: 'B2B SaaS AI automation company', page: 1, maxPages: 1, queryIndex: 0 } }];`,
  })
);
nodes.push(
  node('Split Discovery Batches', 'n8n-nodes-base.splitInBatches', [-1280, -400], {
    batchSize: '={{ $json.discoveryBatchSize || 5 }}',
    options: {},
  })
);
nodes.push(
  node('Serper Search', 'n8n-nodes-base.httpRequest', [-1040, -400], {
    method: 'POST',
    url: 'https://google.serper.dev/search',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-API-KEY', value: "={{ $env.SERPER_API_KEY }}" },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody:
      '={{ JSON.stringify({ q: $json.searchQuery, num: 10, page: $json.page || 1, gl: "us", hl: "en" }) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput', notes: 'Serper company discovery. Credential: HTTP Header Auth with X-API-KEY or use env.' })
);
nodes.push(
  node('Wait Serper Rate Limit', 'n8n-nodes-base.wait', [-800, -400], {
    resume: 'timeInterval',
    amount: '={{ $("Build Discovery Queries").first().json.serperWaitMs || 2000 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Parse Serper Results', 'n8n-nodes-base.code', [-560, -400], {
    mode: 'runOnceForEachItem',
    jsCode: `const src = $('Split Discovery Batches').item.json;
const body = $input.item.json;
const organic = body.organic || [];
const companies = organic.map((r, i) => {
  const link = r.link || '';
  let website = link;
  if (link.includes('linkedin.com')) website = (r.snippet || '').match(/https?:\\/\\/[^\\s)]+/)?.[0] || '';
  const domain = website.replace(/^https?:\\/\\//,'').split('/')[0];
  return {
    lead_id: \`cognix_\${Date.now()}_\${src.queryIndex}_\${i}\`,
    company_name: r.title?.split('|')[0]?.split('-')[0]?.trim() || r.title || 'Unknown Company',
    website: website.startsWith('http') ? website : (domain ? \`https://\${domain}\` : ''),
    linkedin_url: link.includes('linkedin.com') ? link : '',
    description: r.snippet || '',
    source_query: src.searchQuery,
    discovery_page: src.page,
    status: 'discovered',
    outreach_stage: 'none',
    reply_detected: false,
    created_at: new Date().toISOString(),
  };
}).filter(c => c.company_name);
return companies.map(json => ({ json }));`,
  })
);
nodes.push(
  node('IF More Serper Pages', 'n8n-nodes-base.if', [-320, -520], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [
        {
          leftValue: '={{ $("Split Discovery Batches").item.json.page }}',
          rightValue: '={{ $("Split Discovery Batches").item.json.maxPages }}',
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
          value: '={{ $("Split Discovery Batches").item.json.page + 1 }}',
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
  const domain = (c.website || '').toLowerCase().replace(/^https?:\\/\\//,'').replace(/\\/$/,'').split('/')[0];
  const name = (c.company_name || '').toLowerCase().trim();
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
  node('Apify Optional Enrich', 'n8n-nodes-base.httpRequest', [80, -400], {
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
    options: { ...retryOptions },
  }, { onError: 'continueRegularOutput', notes: 'Optional enrichment when APIFY_API_TOKEN is set. On failure, passes through original company item.' })
);
nodes.push(
  node('Merge Apify Enrichment', 'n8n-nodes-base.code', [120, -400], {
    mode: 'runOnceForEachItem',
    jsCode: `const base = $('Dedupe Companies').all()[$itemIndex]?.json || {};
const apify = $input.item.json;
let website = base.website;
if (Array.isArray(apify) && apify[0]?.url) website = apify[0].url;
if (apify?.organic?.[0]?.link) website = apify.organic[0].link;
return { json: { ...base, website: website || base.website, apify_enriched: Boolean($env.APIFY_API_TOKEN) } };`,
  })
);

// ============ FIRECRAWL SCRAPING ============
nodes.push(
  node('Split Scrape Batches', 'n8n-nodes-base.splitInBatches', [160, -400], {
    batchSize: '={{ $("Build Dedup Index").first().json.scrapeBatchSize || 3 }}',
  })
);
nodes.push(
  node('Firecrawl Homepage', 'n8n-nodes-base.httpRequest', [400, -400], {
    method: 'POST',
    url: 'https://api.firecrawl.dev/v1/scrape',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
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
      '={{ JSON.stringify({ url: $json.website, formats: ["markdown"], onlyMainContent: true, timeout: 60000 }) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Wait Firecrawl Rate Limit', 'n8n-nodes-base.wait', [640, -400], {
    resume: 'timeInterval',
    amount: '={{ $("Build Dedup Index").first().json.firecrawlWaitMs || 3000 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('Firecrawl Careers', 'n8n-nodes-base.httpRequest', [880, -400], {
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
      '={{ JSON.stringify({ url: ($json.website || "").replace(/\\/$/,"") + "/careers", formats: ["markdown"], onlyMainContent: true, timeout: 60000 }) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Firecrawl Product', 'n8n-nodes-base.httpRequest', [1120, -400], {
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
      '={{ JSON.stringify({ url: ($json.website || "").replace(/\\/$/,"") + "/product", formats: ["markdown"], onlyMainContent: true, timeout: 60000 }) }}',
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Extract Scrape Signals', 'n8n-nodes-base.code', [1360, -400], {
    mode: 'runOnceForEachItem',
    jsCode: `const company = $('Split Scrape Batches').item.json;
const homepage = $('Firecrawl Homepage').item.json?.data?.markdown || $('Firecrawl Homepage').item.json?.markdown || '';
const careers = $('Firecrawl Careers').item.json?.data?.markdown || '';
const product = $('Firecrawl Product').item.json?.markdown || $('Firecrawl Product').item.json?.data?.markdown || '';
const combined = [homepage, careers, product].join('\\n').toLowerCase();
const count = (term) => (combined.match(new RegExp(term, 'gi')) || []).length;
return {
  json: {
    ...company,
    scraped_homepage: homepage.slice(0, 12000),
    scraped_careers: careers.slice(0, 8000),
    scraped_product: product.slice(0, 8000),
    signals: {
      ai_mentions: count('\\\\b(ai|artificial intelligence|llm|gpt|machine learning)\\\\b'),
      automation_mentions: count('\\\\b(automation|automate|workflow|orchestrat)\\\\b'),
      hiring_mentions: count('\\\\b(hiring|careers|open roles|we\\\\'re hiring)\\\\b'),
      support_mentions: count('\\\\b(support|customer success|helpdesk|ticket)\\\\b'),
    },
    status: 'scraped',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);

// ============ OPENAI ANALYSIS ============
nodes.push(
  node('Wait OpenAI Rate Limit', 'n8n-nodes-base.wait', [1600, -400], {
    resume: 'timeInterval',
    amount: '={{ $("Build Dedup Index").first().json.openaiWaitMs || 1500 }}',
    unit: 'milliseconds',
  })
);
nodes.push(
  node('OpenAI Lead Analysis', 'n8n-nodes-base.httpRequest', [1840, -400], {
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: '={{ "Bearer " + $env.OPENAI_API_KEY }}' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  model: "gpt-4o-mini",
  temperature: 0.2,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: "You are a B2B GTM analyst for CognixAI Labs. Return STRICT JSON only with keys: ai_readiness_score, operational_complexity_score, buying_probability, likely_pain_points, workflow_complexity, internal_tooling_needs, onboarding_complexity, support_burden, scaling_signals, summary." },
    { role: "user", content: "Company: " + $json.company_name + "\\nWebsite: " + $json.website + "\\nDescription: " + $json.description + "\\nSignals: " + JSON.stringify($json.signals) + "\\nHomepage excerpt: " + ($json.scraped_homepage || "").slice(0, 4000) + "\\nCareers excerpt: " + ($json.scraped_careers || "").slice(0, 2500) }
  ]
}) }}`,
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('IF OpenAI Analysis OK', 'n8n-nodes-base.if', [2080, -400], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $json.choices?.[0]?.message?.content }}',
          rightValue: '',
          operator: { type: 'string', operation: 'notEmpty' },
        },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('Parse AI Analysis JSON', 'n8n-nodes-base.code', [2320, -400], {
    mode: 'runOnceForEachItem',
    jsCode: `const lead = $('Extract Scrape Signals').item.json;
const content = $input.item.json.choices?.[0]?.message?.content || '{}';
let analysis = {};
try { analysis = JSON.parse(content); } catch (e) {
  analysis = { summary: content, ai_readiness_score: 50, operational_complexity_score: 50, buying_probability: 0.3 };
}
return { json: { ...lead, ...analysis, status: 'analyzed', updated_at: new Date().toISOString() } };`,
  })
);
nodes.push(
  node('ICP Weighted Scoring', 'n8n-nodes-base.code', [2560, -400], {
    mode: 'runOnceForEachItem',
    jsCode: `const l = $input.item.json;
const s = l.signals || {};
const weights = {
  ai: 0.2,
  automation: 0.15,
  hiring: 0.15,
  support: 0.1,
  ai_readiness: 0.15,
  complexity: 0.1,
  buying: 0.15,
};
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
const route = priority === 'high' ? 'immediate_outreach' : priority === 'medium' ? 'nurture' : 'archive';
return {
  json: {
    ...l,
    icp_score,
    priority,
    route,
    lead_quality: priority,
    status: priority === 'low' ? 'archived' : 'scored',
    updated_at: new Date().toISOString(),
  },
};`,
  })
);
nodes.push(
  node('Route ICP Priority', 'n8n-nodes-base.switch', [2800, -400], {
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

// ============ PERSONALIZATION ============
nodes.push(
  node('OpenAI Personalization', 'n8n-nodes-base.httpRequest', [3040, -560], {
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: '={{ "Bearer " + $env.OPENAI_API_KEY }}' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
  model: "gpt-4o-mini",
  temperature: 0.7,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: "Write founder-level, human, non-salesy outreach for CognixAI Labs. Return STRICT JSON: linkedin_opener, email_subject, email_body, followup_1, followup_2, breakup_email, personalization_notes. Max 120 words per email. Operationally intelligent tone." },
    { role: "user", content: JSON.stringify({ company_name: $json.company_name, website: $json.website, pain_points: $json.likely_pain_points, icp_score: $json.icp_score, summary: $json.summary }) }
  ]
}) }}`,
    options: retryOptions,
  }, { onError: 'continueErrorOutput' })
);
nodes.push(
  node('Parse Personalization JSON', 'n8n-nodes-base.code', [3280, -560], {
    mode: 'runOnceForEachItem',
    jsCode: `const lead = $('ICP Weighted Scoring').item.json;
const content = $input.item.json.choices?.[0]?.message?.content || '{}';
let copy = {};
try { copy = JSON.parse(content); } catch (e) { copy = { email_subject: 'Quick idea for ' + lead.company_name, email_body: content }; }
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
  node('Edit Fields - Lead Record', 'n8n-nodes-base.set', [3400, -560], {
    mode: 'manual',
    includeOtherFields: true,
    assignments: {
      assignments: [
        { id: uid(), name: 'contact_email', value: "={{ $json.contact_email || 'hello@' + ($json.website || '').replace(/^https?:\\/\\//,'').split('/')[0] }}", type: 'string' },
        { id: uid(), name: 'route', value: '={{ $json.priority === "high" ? "immediate_outreach" : ($json.priority === "medium" ? "nurture" : "archive") }}', type: 'string' },
      ],
    },
  })
);
nodes.push(
  node('Merge Outreach Paths', 'n8n-nodes-base.merge', [3520, -400], {
    mode: 'append',
    numberInputs: 2,
  })
);
nodes.push(
  node('Archive Low ICP', 'n8n-nodes-base.set', [3040, -240], {
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

// ============ GOOGLE SHEETS UPSERT ============
nodes.push(
  node('Sheets Append Lead', 'n8n-nodes-base.googleSheets', [3760, -400], {
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

// ============ OUTREACH SEND ============
nodes.push(
  node('Read Leads For Outreach', 'n8n-nodes-base.googleSheets', [4000, -400], {
    operation: 'read',
    documentId: { __rl: true, value: '={{ $("Build Dedup Index").first().json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $("Build Dedup Index").first().json.sheetName }}', mode: 'name' },
    options: { rangeDefinition: 'specifyRange', range: 'A:Z' },
  })
);
nodes.push(
  node('Filter Ready To Send', 'n8n-nodes-base.code', [4120, -400], {
    mode: 'runOnceForAllItems',
    jsCode: `return $input.all().filter(i => {
  const r = i.json;
  const stage = (r.outreach_stage || r['outreach_stage'] || '').toString();
  const replied = r.reply_detected === true || r.reply_detected === 'TRUE';
  const last = r.last_contacted || r['last_contacted'] || '';
  return stage === 'ready_to_send' && !replied && !last;
});`,
  })
);
nodes.push(
  node('Split Outreach Batches', 'n8n-nodes-base.splitInBatches', [4240, -400], {
    batchSize: '={{ $("Build Dedup Index").first().json.outreachBatchSize || 10 }}',
  })
);
nodes.push(
  node('IF Not Already Contacted', 'n8n-nodes-base.if', [4480, -400], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          leftValue: '={{ $json.last_contacted || $json["last_contacted"] || "" }}',
          rightValue: '',
          operator: { type: 'string', operation: 'empty' },
        },
        {
          leftValue: '={{ $json.reply_detected || $json["reply_detected"] }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'notEquals' },
        },
      ],
      combinator: 'and',
    },
  })
);
nodes.push(
  node('Gmail Send Initial', 'n8n-nodes-base.gmail', [4720, -480], {
    resource: 'message',
    operation: 'send',
    sendTo: "={{ $json.contact_email || $env.COGNIX_DEFAULT_CONTACT_EMAIL || 'ops@' + ($json.website || '').replace(/^https?:\\/\\//,'').split('/')[0] }}",
    subject: '={{ $json.email_subject || ("Question about ops at " + ($json.company_name || $json["company_name"])) }}',
    emailType: 'text',
    message: '={{ $json.email_body || $json["email_body"] }}',
    options: {
      senderName: '={{ $("Build Dedup Index").first().json.senderName }}',
      replyTo: '={{ $("Build Dedup Index").first().json.fromEmail }}',
    },
  })
);
nodes.push(
  node('Sheets Update Contacted', 'n8n-nodes-base.googleSheets', [4960, -480], {
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

// ============ FOLLOW-UP AUTOMATION ============
nodes.push(
  node('Read Active Outreach Leads', 'n8n-nodes-base.googleSheets', [-2000, 400], {
    operation: 'read',
    documentId: { __rl: true, value: '={{ $json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $json.sheetName }}', mode: 'name' },
    options: { rangeDefinition: 'specifyRange', range: 'A:Z' },
  })
);
nodes.push(
  node('Filter Follow-up Candidates', 'n8n-nodes-base.code', [-1760, 400], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $('Detect Run Mode').first().json;
const now = Date.now();
const day = 86400000;
const items = $input.all().map(i => i.json).filter(r => {
  if (r.reply_detected === true || r.reply_detected === 'TRUE') return false;
  const stage = (r.outreach_stage || '').toString();
  if (!['initial_sent','followup_1_sent','followup_2_sent'].includes(stage)) return false;
  const last = Date.parse(r.last_contacted || r.updated_at || 0);
  if (!last) return false;
  if (stage === 'initial_sent' && now - last >= 3 * day) return true;
  if (stage === 'followup_1_sent' && now - last >= 5 * day) return true;
  if (stage === 'followup_2_sent' && now - last >= 7 * day) return true;
  return false;
});
return items.map(json => ({ json: { ...cfg, ...json } }));`,
  })
);
nodes.push(
  node('Split Follow-up Batches', 'n8n-nodes-base.splitInBatches', [-1520, 400], {
    batchSize: 5,
  })
);
nodes.push(
  node('Gmail Check Replies', 'n8n-nodes-base.gmail', [-1280, 400], {
    resource: 'message',
    operation: 'getAll',
    returnAll: false,
    limit: 5,
    filters: {
      q: '={{ "from:" + ($json.contact_email || "") + " newer_than:14d in:inbox" }}',
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
    documentId: { __rl: true, value: '={{ $("Split Follow-up Batches").item.json.spreadsheetId }}', mode: 'id' },
    sheetName: { __rl: true, value: '={{ $("Split Follow-up Batches").item.json.sheetName }}', mode: 'name' },
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
  node('Route High Intent Lead', 'n8n-nodes-base.set', [-560, 280], {
    mode: 'manual',
    assignments: {
      assignments: [
        { id: uid(), name: 'route_target', value: 'founder_slack_webhook', type: 'string' },
        { id: uid(), name: 'alert_message', value: '={{ "High-intent reply from " + $json.company_name }}', type: 'string' },
      ],
    },
    includeOtherFields: true,
  })
);
nodes.push(
  node('HTTP Alert High Intent', 'n8n-nodes-base.httpRequest', [-320, 280], {
    method: 'POST',
    url: "={{ $env.COGNIX_HIGH_INTENT_WEBHOOK_URL || 'https://hooks.example.com/cognix/high-intent' }}",
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ text: $json.alert_message, lead: $json }) }}',
    options: { ...retryOptions },
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
                leftValue: '={{ $("Split Follow-up Batches").item.json.outreach_stage }}',
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
                leftValue: '={{ $("Split Follow-up Batches").item.json.outreach_stage }}',
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
    sendTo: "={{ $json.contact_email || 'ops@' + ($json.website || '').replace(/^https?:\\/\\//,'').split('/')[0] }}",
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
    sendTo: "={{ $json.contact_email || 'ops@' + ($json.website || '').replace(/^https?:\\/\\//,'').split('/')[0] }}",
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
    sendTo: "={{ $json.contact_email || 'ops@' + ($json.website || '').replace(/^https?:\\/\\//,'').split('/')[0] }}",
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
nodes.push(
  node('Error Trigger', 'n8n-nodes-base.errorTrigger', [-3200, 600], {})
);
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
    stack: err.execution?.error?.stack || '',
  }
}];`,
  })
);
nodes.push(
  node('Sheets Log Error', 'n8n-nodes-base.googleSheets', [-2720, 600], {
    operation: 'append',
    documentId: { __rl: true, value: "={{ $env.COGNIX_LEADS_SHEET_ID || 'REPLACE_WITH_GOOGLE_SHEET_ID' }}", mode: 'id' },
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
  node('HTTP Error Notify', 'n8n-nodes-base.httpRequest', [-2480, 600], {
    method: 'POST',
    url: "={{ $env.COGNIX_ERROR_WEBHOOK_URL || 'https://hooks.example.com/cognix/errors' }}",
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json) }}',
    options: retryOptions,
  })
);

// Serper error fallback
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
  node('Handle OpenAI Error', 'n8n-nodes-base.set', [2320, -200], {
    mode: 'manual',
    assignments: {
      assignments: [
        { id: uid(), name: 'error_log', value: '={{ $json.error?.message || "OpenAI analysis failed" }}', type: 'string' },
        { id: uid(), name: 'status', value: 'analysis_failed', type: 'string' },
        { id: uid(), name: 'ai_readiness_score', value: 40, type: 'number' },
        { id: uid(), name: 'operational_complexity_score', value: 50, type: 'number' },
        { id: uid(), name: 'buying_probability', value: 0.25, type: 'number' },
      ],
    },
    includeOtherFields: true,
  })
);

// Loop backs for batches
nodes.push(
  node('Loop Discovery Batches', 'n8n-nodes-base.code', [160, -560], {
    mode: 'runOnceForAllItems',
    jsCode: 'return [{ json: { loop: true } }];',
  })
);
nodes.push(
  node('Run Follow-up Pass', 'n8n-nodes-base.code', [5200, -400], {
    mode: 'runOnceForAllItems',
    jsCode: `const cfg = $('Build Dedup Index').first().json;
return [{ json: { ...cfg, triggerFollowups: true } }];`,
  })
);
nodes.push(
  node('Loop Scrape Batches', 'n8n-nodes-base.code', [3760, -560], {
    mode: 'runOnceForAllItems',
    jsCode: 'return $input.all();',
  })
);

// Sticky notes
nodes.push(
  node('NOTE Architecture', 'n8n-nodes-base.stickyNote', [-3400, -500], {
    content:
      '## CognixAI Unified Outbound Platform\n\nTriggers: Manual | Discovery cron (Mon/Wed/Fri 06:00) | Follow-up cron (daily 09:00)\n\nPipeline: Serper discovery -> Apify enrich (optional) -> Firecrawl scrape -> OpenAI analysis -> ICP score -> personalize -> Google Sheets -> Gmail outreach -> follow-ups (3/5/7 days via date filter)\n\nError branch: wire workflow Settings > Error Workflow to a clone containing only Error Trigger nodes, OR rely on inline continueOnFail paths.\n\nWindows env vars: SERPER_API_KEY, FIRECRAWL_API_KEY, OPENAI_API_KEY, APIFY_API_TOKEN (optional), COGNIX_LEADS_SHEET_ID, COGNIX_FROM_EMAIL, COGNIX_HIGH_INTENT_WEBHOOK_URL, COGNIX_ERROR_WEBHOOK_URL',
    height: 380,
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

// Route: followups_only -> follow-up path
conn('Route Run Mode', 'Read Active Outreach Leads', 0, 0); // followups_only output 0
// discovery + full -> read existing
conn('Route Run Mode', 'Read Existing Leads', 1, 0); // discovery_pipeline
conn('Route Run Mode', 'Read Existing Leads', 2, 0); // full_pipeline fallback

conn('Read Existing Leads', 'Build Dedup Index');
conn('Build Dedup Index', 'Build Discovery Queries');
conn('Build Discovery Queries', 'Split Discovery Batches');
conn('Split Discovery Batches', 'Serper Search');
conn('Serper Search', 'Wait Serper Rate Limit');
conn('Serper Search', 'Handle Serper Error', 1, 0); // error output
conn('Wait Serper Rate Limit', 'Parse Serper Results');
conn('Parse Serper Results', 'IF More Serper Pages');
conn('IF More Serper Pages', 'Increment Serper Page', 0, 0); // true - more pages
conn('Increment Serper Page', 'Serper Search');
conn('IF More Serper Pages', 'Dedupe Companies', 1, 0); // false
conn('Dedupe Companies', 'IF Has New Companies');
conn('IF Has New Companies', 'Apify Optional Enrich', 0, 0);
conn('IF Has New Companies', 'Loop Discovery Batches', 1, 0);
conn('Apify Optional Enrich', 'Merge Apify Enrichment');
conn('Merge Apify Enrichment', 'Split Scrape Batches');
conn('Split Scrape Batches', 'Firecrawl Homepage');
conn('Firecrawl Homepage', 'Wait Firecrawl Rate Limit');
conn('Wait Firecrawl Rate Limit', 'Firecrawl Careers');
conn('Firecrawl Careers', 'Firecrawl Product');
conn('Firecrawl Product', 'Extract Scrape Signals');
conn('Extract Scrape Signals', 'Wait OpenAI Rate Limit');
conn('Wait OpenAI Rate Limit', 'OpenAI Lead Analysis');
conn('OpenAI Lead Analysis', 'IF OpenAI Analysis OK');
conn('OpenAI Lead Analysis', 'Handle OpenAI Error', 1, 0);
conn('IF OpenAI Analysis OK', 'Parse AI Analysis JSON', 0, 0);
conn('Handle OpenAI Error', 'ICP Weighted Scoring');
conn('IF OpenAI Analysis OK', 'Handle OpenAI Error', 1, 0);
conn('Parse AI Analysis JSON', 'ICP Weighted Scoring');
conn('ICP Weighted Scoring', 'Route ICP Priority');
conn('Route ICP Priority', 'OpenAI Personalization', 0, 0); // high
conn('Route ICP Priority', 'OpenAI Personalization', 1, 0); // medium
conn('Route ICP Priority', 'Archive Low ICP', 2, 0); // low
conn('OpenAI Personalization', 'Parse Personalization JSON');
conn('Parse Personalization JSON', 'Edit Fields - Lead Record');
conn('Edit Fields - Lead Record', 'Merge Outreach Paths', 0, 0);
conn('Archive Low ICP', 'Merge Outreach Paths', 0, 1);
conn('Merge Outreach Paths', 'Sheets Append Lead');
conn('Sheets Append Lead', 'Loop Scrape Batches');
conn('Loop Scrape Batches', 'Split Scrape Batches');
conn('Split Scrape Batches', 'Read Leads For Outreach', 1, 0); // done
conn('Read Leads For Outreach', 'Filter Ready To Send');
conn('Filter Ready To Send', 'Split Outreach Batches');
conn('Handle Serper Error', 'Loop Discovery Batches');
conn('Loop Discovery Batches', 'Split Discovery Batches');
conn('Split Outreach Batches', 'Run Follow-up Pass', 1, 0);
conn('Split Outreach Batches', 'IF Not Already Contacted');
conn('IF Not Already Contacted', 'Gmail Send Initial', 0, 0);
conn('Gmail Send Initial', 'Sheets Update Contacted');
conn('Sheets Update Contacted', 'Split Outreach Batches');

// Follow-up path
conn('Read Active Outreach Leads', 'Filter Follow-up Candidates');
conn('Filter Follow-up Candidates', 'Split Follow-up Batches');
conn('Split Follow-up Batches', 'Gmail Check Replies');
conn('Gmail Check Replies', 'IF Reply Detected');
conn('IF Reply Detected', 'Sheets Mark Replied', 0, 0);
conn('Sheets Mark Replied', 'Route High Intent Lead');
conn('Route High Intent Lead', 'HTTP Alert High Intent');
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
conn('Run Follow-up Pass', 'Read Active Outreach Leads');

// Error workflow
conn('Error Trigger', 'Log Error Payload');
conn('Log Error Payload', 'Sheets Log Error');
conn('Sheets Log Error', 'HTTP Error Notify');

const workflow = {
  name: 'CognixAI Labs - Outbound Lead Intelligence Platform (Unified)',
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
    instanceId: 'cognix-local-windows',
  },
  tags: [
    { name: 'cognix' },
    { name: 'outbound' },
    { name: 'production' },
  ],
};

const outPath = new URL('./cognix-outbound-lead-intelligence.json', import.meta.url);
writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');
console.log('Written', outPath.pathname, 'nodes:', nodes.length);
