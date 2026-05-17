# CognixAI Outbound Lead Intelligence (n8n)

Production-grade unified n8n workflow for AI-powered outbound lead discovery, website intelligence, ICP scoring, personalized outreach, and automated follow-ups.

Built for **local n8n on Windows** (not Docker). Uses official n8n nodes only. **AI: Google Gemini 2.0 Flash** (not OpenAI).

## Contents

| File | Description |
|------|-------------|
| `workflows/cognix-outbound-lead-intelligence.json` | Importable n8n workflow (69 nodes) |
| `workflows/generate-workflow.mjs` | Generator script to rebuild the JSON |

## Quick start

1. Import `workflows/cognix-outbound-lead-intelligence.json` into n8n.
2. Set environment variables (see below).
3. Create Google Sheet tabs `Leads` and `ErrorLog`.
4. Connect **Google Sheets** and **Gmail** OAuth credentials in n8n.
5. Run **Manual Trigger** with small batch sizes, then activate the workflow.

Regenerate workflow JSON:

```bash
node workflows/generate-workflow.mjs
```

## Environment variables

| Variable | Required |
|----------|----------|
| `GEMINI_API_KEY` | Yes |
| `SERPER_API_KEY` | Yes |
| `FIRECRAWL_API_KEY` | Yes |
| `COGNIX_LEADS_SHEET_ID` | Yes |
| `COGNIX_FROM_EMAIL` | Recommended (Gmail reply-to) |
| `APIFY_API_TOKEN` | Optional |
| `COGNIX_HIGH_INTENT_WEBHOOK_URL` | Optional (only used if set; no fake defaults) |
| `COGNIX_ERROR_WEBHOOK_URL` | Optional (only used if set) |

## Triggers

- **Manual** — full pipeline (discovery + outreach + follow-up pass)
- **Schedule** — discovery Mon/Wed/Fri 06:00 ET
- **Schedule** — follow-ups daily 09:00 ET

## License

Proprietary — CognixAI Labs.
