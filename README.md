# ClinicalTrials.gov — Clinical Trial Registry

The NIH-operated public registry of clinical trials worldwide. Every interventional study (and most observational ones) registered with the FDA must be filed here. ~470,000 studies covering Phase 1–4, conditions across the medical spectrum, and post-market safety surveillance. Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Why this matters for AI agents

If your agent is answering anything about drug development, clinical research, or medical product safety, ClinicalTrials.gov is the source of truth for *what's being studied*. The data is structured: NCT IDs, phases, statuses, sponsors, conditions, interventions, primary/secondary outcomes, results.

Three core flows:

**1. Search.** "What's being studied for Alzheimer's?" → `ct_search({query: "Alzheimer's disease"})` → studies matching, with NCT IDs, phase, status.

**2. Specific study.** "Tell me about this trial." → `ct_get_study({nct_id: "NCT04280705"})` → full structured record including protocol, results, references.

**3. Sponsor / volume.** "How many trials does Pfizer run?" → `ct_sponsor_trials({sponsor: "Pfizer"})` → enumerated by phase and status.

**4. Sponsor comparison.** "Who has more recruiting Phase 3 obesity trials, Novo Nordisk or Eli Lilly?" → `ct_compare_sponsors({sponsors: ["Novo Nordisk", "Eli Lilly and Company"], condition: "obesity", status: "RECRUITING", phase: "PHASE3"})` → lead-sponsor counts ranked under identical filters with sample NCT records.

For drug-level synthesis (combining trials with FDA approvals and adverse events), use [`pharma_drug_profile`](https://pipeworx.io/docs/concepts/compound-tools) compound or [`compare_entities({type: "drug", values: [...]})`].

## Citable URI

```
pipeworx://clinicaltrials/study/{nct_id}
```

NCT IDs are stable forever. Once issued, never reused. Embed in agent output as the canonical study reference.

## Status filtering

When users ask about "active" trials, they usually mean one of two things:

- **Currently recruiting**: `status=Recruiting` — open to new participants
- **In progress**: `status=Recruiting OR Active, not recruiting OR Enrolling by invitation`

The default `ct_search` returns all statuses; filter on `status` field of results for the meaning you want. Common confusion: "Completed" trials are studies that finished collecting data, not necessarily ones with published results.

## Update cadence

- Sponsors are required to update studies at least once per year, more often for material changes (status transitions, completion).
- Primary results must be posted within 12 months of primary completion date.
- Pipeworx caches per-study responses with a 24-hour TTL. Most studies don't change daily; this is fine for almost all use cases.

## Common pitfalls

- **Results vs. results.** "Has results" means primary outcome data is posted on ClinicalTrials.gov. Many completed trials publish papers in peer-reviewed journals but never post here. For literature, cross-reference with `semantic-scholar` or `crossref`.
- **Phase confusion.** A "Phase 2/3" trial counts as both phases. Filtering by phase requires careful boolean logic.
- **Sponsor name normalization.** "Pfizer Inc." and "Pfizer" return different result counts in `ct_sponsor_trials`. Try the more permissive form first.
- **Lead sponsor versus collaborator.** `ct_compare_sponsors` deliberately counts the registered lead-sponsor field so collaborator records do not inflate a head-to-head comparison. Registered corporate spellings and subsidiaries can still divide a company portfolio; inspect the returned lead-sponsor names.
- **Geographic scope.** ClinicalTrials.gov is US-based but registers studies worldwide if any US site is involved. For purely-foreign studies, use the WHO ICTRP — not currently in Pipeworx.
- **Recently terminated trials.** "Terminated" means the study stopped before completion. Look at `whyStopped` in the full study record for context (safety signal vs. enrollment problems vs. funding).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "clinicaltrials": {
      "url": "https://gateway.pipeworx.io/clinicaltrials/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/clinicaltrials/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Clinicaltrials data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ct_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"GLP-1 receptor agonist","status":"RECRUITING","phase":"PHASE2","limit":20}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ct_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
