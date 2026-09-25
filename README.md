# ClinicalTrials.gov — Clinical Trial Registry

The NIH-operated public registry of clinical trials worldwide. Every interventional study (and most observational ones) registered with the FDA must be filed here. ~470,000 studies covering Phase 1–4, conditions across the medical spectrum, and post-market safety surveillance. Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Why this matters for AI agents

If your agent is answering anything about drug development, clinical research, or medical product safety, ClinicalTrials.gov is the source of truth for *what's being studied*. The data is structured: NCT IDs, phases, statuses, sponsors, conditions, interventions, primary/secondary outcomes, results.

Three core flows:

**1. Search.** "What's being studied for Alzheimer's?" → `ct_search({query: "Alzheimer's disease"})` → studies matching, with NCT IDs, phase, status.

**2. Specific study.** "Tell me about this trial." → `ct_get_study({nct_id: "NCT04280705"})` → full structured record including protocol, results, references.

**3. Sponsor / volume.** "How many trials does Pfizer run?" → `ct_sponsor_trials({sponsor: "Pfizer"})` → enumerated by phase and status. See [What `sponsor` means](#what-sponsor-means) — it is the trials Pfizer *leads*, not every trial its drugs appear in.

**4. Sponsor comparison.** "Who has more recruiting Phase 3 obesity trials, Novo Nordisk or Eli Lilly?" → `ct_compare_sponsors({sponsors: ["Novo Nordisk", "Eli Lilly and Company"], condition: "obesity", status: "RECRUITING", phase: "PHASE3"})` → lead-sponsor counts ranked under identical filters with sample NCT records.

For drug-level synthesis (combining trials with FDA approvals and adverse events), use [`pharma_drug_profile`](https://pipeworx.io/docs/concepts/compound-tools) compound or [`compare_entities({type: "drug", values: [...]})`].

## Citable URI

```
pipeworx://clinicaltrials/study/{nct_id}
```

NCT IDs are stable forever. Once issued, never reused. Embed in agent output as the canonical study reference.

## What `sponsor` means

Every tool that takes a `sponsor` matches the **registered lead sponsor** — the
organisation that filed and runs the trial. That is what "what is Merck about to
read out" means, and it is the default everywhere.

It is deliberately narrower than it looks. A university's study of
pembrolizumab is *not* a Merck trial; Merck made the drug, someone else is
running the study. To include those, pass `sponsor_match`:

| `sponsor_match` | Matches | Merck Sharp & Dohme LLC |
|---|---|---|
| `lead` (default) | registered lead sponsor only | 2,175 studies |
| `lead_or_collaborator` | also trials listing the company as a collaborator | 4,280 studies |

Every returned study carries **`sponsor_match_field`** (`lead_sponsor` or
`collaborator`), so a caller can always see *why* a given trial came back.

Until 2026-08-29 these tools filtered with the registry's `query.spons`
parameter, which is not a sponsor filter at all — it is a broad search that also
matches collaborators and free text. A Merck query returned 4,282 studies led by
the University of Utah, Weill Cornell and others, with no indication in the
response that anything was wrong. If you have cached counts from before that
date, they are the broad number, not the lead-sponsor one.

## Status filtering

When users ask about "active" trials, they usually mean one of two things:

- **Currently recruiting**: `status=Recruiting` — open to new participants
- **In progress**: `status=Recruiting OR Active, not recruiting OR Enrolling by invitation`

The default `ct_search` returns all statuses; filter on `status` field of results for the meaning you want. Common confusion: "Completed" trials are studies that finished collecting data, not necessarily ones with published results.

## Phase transition rates (`ct_phase_transition_rates`)

The public analog of a probability-of-technical-success (PTRS) benchmark — the
kind of number Evaluate Omnium and BioMedTracker sell. It measures how often a
drug for a given disease actually advances from one clinical phase to the next,
derived from the registry itself.

```
ct_phase_transition_rates({ condition: "non-small cell lung cancer" })
```

Returns Phase 1→2 and Phase 2→3 as **numerator / denominator / rate**, the
censoring rule in plain words, the matching **BIO/Informa/QLS 2011-2020**
published benchmark, and the top 20 interventions with their phase path so the
rate is auditable.

**Method.** Industry-sponsored interventional trials for the condition are
grouped by normalized intervention name (lowercased; dose, route and
formulation tokens stripped; compound code names preserved intact so
`PF-06463922` stays distinct from `PF-06439535`). Combination arms are split and
counted under each component. An intervention *transitioned* from phase N to
N+1 if it has a **completed** phase-N trial for the condition and any phase-N+1
trial for the same condition that **started after** that completion.

**Censoring.** `censor_years` (default 3) is the follow-up an asset must have
had to count. An intervention only enters the denominator if its completed
earlier-phase trial finished at least that many years before `to_year`;
otherwise it has not had time to advance and counting it as a failure would
understate the rate. Raising it demands more follow-up and shrinks the
denominator — on NSCLC, `censor_years: 3` gives a Phase 2→3 denominator of 410
and `censor_years: 8` gives 301.

Fewer than 10 eligible interventions returns an explicit `insufficient_data`
status with a reason, **not** a rate.

### What this number is not

It counts **trial existence in a registry**, not outcomes. An asset that entered
Phase 3 and failed still counts as a transition, so the result is an **upper
bound on technical success**, never a probability of approval. Three further
caveats ship in the response's `limitations` array:

- ClinicalTrials.gov has no asset identifier, so assets are reconstructed from
  free-text intervention names. A drug filed under inconsistent spellings reads
  as several assets that each failed.
- Ubiquitous chemotherapy backbones (carboplatin, cisplatin, paclitaxel) are
  genuine registered interventions and no registry field marks an arm as
  background therapy. They appear in every phase and transition almost always,
  which biases the rate **upward** — they are visibly the top rows of the NSCLC
  audit list.
- The BIO comparison is a *different measurement*: analyst-curated
  advance-or-suspend decisions per programme, at broad therapeutic-area
  granularity. It anchors the order of magnitude, not the exact quantity.

Expect the registry-derived rate to run **below** the published one, because it
requires the next-phase trial to have been publicly registered.

### `otherNames` is not a synonym list

Worth knowing if you build anything similar. Sponsors use
`interventions[].otherNames` for genuine synonyms (`lorlatinib` ↔
`PF-06463922`) **and** for the other drugs in the regimen: `AK112 Injection`
carries `["Pemetrexed", "Carboplatin"]`, and `Standard of care neoadjuvant
therapy` lists six chemotherapies. Merging those naively pulled all 306
pemetrexed trials into a key called `ak112`, which then reported 76 Phase 2
trials under Eli Lilly for an Akeso antibody — with no error and a still-plausible
rate. Two guards prevent it: a name that appears as a primary intervention
anywhere in the corpus can never be absorbed as someone else's alias, and an arm
listing more than two `otherNames` is treated as a regimen list and ignored.
Both err toward splitting one asset in two (which understates the rate) rather
than fusing two assets (which corrupts it).

## Update cadence

- Sponsors are required to update studies at least once per year, more often for material changes (status transitions, completion).
- Primary results must be posted within 12 months of primary completion date.
- Pipeworx caches per-study responses with a 24-hour TTL. Most studies don't change daily; this is fine for almost all use cases.

## Common pitfalls

- **Results vs. results.** "Has results" means primary outcome data is posted on ClinicalTrials.gov. Many completed trials publish papers in peer-reviewed journals but never post here. For literature, cross-reference with `semantic-scholar` or `crossref`.
- **Phase confusion.** A "Phase 2/3" trial counts as both phases. Filtering by phase requires careful boolean logic.
- **Sponsor name normalization.** "Pfizer Inc." and "Pfizer" return different result counts in `ct_sponsor_trials`. Try the more permissive form first. On a suspiciously low count the tools probe the registry and hand back `did_you_mean` with the registered spellings that actually exist.
- **Lead sponsor versus collaborator.** All sponsor tools count the registered lead-sponsor field, so collaborator records cannot inflate a portfolio or a head-to-head comparison. Registered corporate spellings and subsidiaries can still divide a company's trials across several names; inspect the returned lead-sponsor names. See [What `sponsor` means](#what-sponsor-means).
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

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ct_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"GLP-1 receptor agonist","status":"RECRUITING","phase":"PHASE2","limit":20}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ct_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "clinicaltrials": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-clinicaltrials"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-clinicaltrials
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

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
