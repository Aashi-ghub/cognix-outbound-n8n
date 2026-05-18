/**
 * Lean workflow QA — run: node workflows/workflow-qa-test.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const workflow = JSON.parse(
  readFileSync(join(join(dirname(fileURLToPath(import.meta.url)), 'cognix-linkedin-relationship-intelligence.json')), 'utf8')
);

const nodesByName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const connections = workflow.connections;
const issues = [];

function fail(id, msg) {
  issues.push({ id, message: msg });
}
function ok(msg) {
  console.log('  OK', msg);
}

function getOutgoing(name) {
  return (connections[name]?.main || []).flatMap((outs, i) =>
    (outs || []).map((l) => ({ ...l, fromOutput: i }))
  );
}

function canReach(from, to) {
  const q = [from];
  const seen = new Set();
  while (q.length) {
    const c = q.shift();
    if (c === to) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    for (const l of getOutgoing(c)) q.push(l.node);
  }
  return false;
}

console.log('Lean Workflow QA\n');

const split = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.splitInBatches');
if (split.length) fail('ARCH', `SplitInBatches still present: ${split.map((n) => n.name).join(', ')}`);
else ok('No SplitInBatches (no recursive loops)');

for (const [from, c] of Object.entries(connections)) {
  for (const outs of c.main || []) {
    for (const l of outs || []) {
      if (l.node === from) fail('LOOP', `Loop-back: ${from} -> ${l.node}`);
    }
  }
}
if (!issues.some((i) => i.id === 'LOOP')) ok('No loop-back connections detected');

const loopNodes = ['Loop Discovery Batches', 'Loop Scrape Batches', 'Loop Engagement Batches'];
for (const n of loopNodes) {
  if (nodesByName[n]) fail('OLD', `Old loop node still exists: ${n}`);
}
if (!issues.some((i) => i.id === 'OLD')) ok('Old loop nodes removed');

if (!canReach('Manual Trigger', 'Sheets Append Leads')) fail('PATH', 'Cannot reach Sheets Append Leads');
else ok('Manual Trigger reaches Sheets Append Leads');

if (!canReach('Manual Trigger', 'Gemini Unified Intelligence')) fail('PATH', 'Cannot reach Gemini');
else ok('Gemini path reachable');

const geminiNodes = workflow.nodes.filter((n) => n.name.includes('Gemini') && n.type.includes('httpRequest'));
if (geminiNodes.length !== 1) fail('GEMINI', `Expected 1 Gemini HTTP node, found ${geminiNodes.length}`);
else ok('Single Gemini HTTP call per lead');

const serperNodes = workflow.nodes.filter(
  (n) => n.type.includes('httpRequest') && n.parameters?.url?.includes('serper')
);
if (serperNodes.length !== 2) fail('SERPER', `Expected 2 Serper nodes (discovery + founder), found ${serperNodes.length}`);
else ok('Serper discovery + Serper Founder Lookup present');

const mergeNodes = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.merge');
if (mergeNodes.length) fail('MERGE', `Unsafe merge nodes remain: ${mergeNodes.map((n) => n.name).join(', ')}`);
else ok('No combineByPosition merge nodes — lead_id/queryKey Code merges only');

if (!nodesByName['Serper Founder Lookup']) fail('FOUNDER', 'Serper Founder Lookup missing');
else ok('Founder Serper lookup node present');

if (!nodesByName['Parse Founder Result']) fail('FOUNDER', 'Parse Founder Result missing');
else ok('Parse Founder Result present');

if (!canReach('Manual Trigger', 'Serper Founder Lookup')) fail('PATH', 'Founder lookup not reachable');
else ok('Founder lookup on main path');

console.log(`\nNodes: ${workflow.nodes.length}`);
if (issues.length) {
  console.log('\nFAILED:');
  issues.forEach((i) => console.log(`  [${i.id}] ${i.message}`));
  process.exit(1);
}
console.log('\nAll lean architecture checks passed.');
process.exit(0);
