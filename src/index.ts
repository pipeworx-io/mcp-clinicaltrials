interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * ClinicalTrials MCP — wraps ClinicalTrials.gov API v2 (free, no auth)
 *
 * Tools:
 * - ct_search: search clinical trials by keyword, status, phase, sponsor
 * - ct_get_study: get full study details by NCT ID
 * - ct_count_by_condition: count trials by condition/disease area
 * - ct_sponsor_trials: list trials by sponsor/company
 * - ct_recent_updates: recently updated/posted trials
 */


const BASE = 'https://clinicaltrials.gov/api/v2/studies';

/* ── Types ─────────────────────────────────────────────────────────── */

type Study = {
  protocolSection?: {
    identificationModule?: {
      nctId?: string;
      briefTitle?: string;
      officialTitle?: string;
      organization?: { fullName?: string };
    };
    statusModule?: {
      overallStatus?: string;
      startDateStruct?: { date?: string };
      primaryCompletionDateStruct?: { date?: string };
      completionDateStruct?: { date?: string };
    };
    designModule?: {
      phases?: string[];
      enrollmentInfo?: { count?: number; type?: string };
    };
    conditionsModule?: {
      conditions?: string[];
      keywords?: string[];
    };
    armsInterventionsModule?: {
      interventions?: {
        type?: string;
        name?: string;
        description?: string;
      }[];
    };
    sponsorCollaboratorsModule?: {
      leadSponsor?: { name?: string; class?: string };
      collaborators?: { name?: string; class?: string }[];
    };
  };
};

type StudiesResponse = {
  totalCount?: number;
  studies?: Study[];
};

/* ── Tool definitions ──────────────────────────────────────────────── */

const tools: McpToolExport['tools'] = [
  {
    name: 'ct_search',
    description:
      'Search clinical trials by keyword, status, phase, or sponsor. Returns study count and array of matching trials with key metadata.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search term (e.g., "GLP-1 receptor agonist", "breast cancer immunotherapy")',
        },
        status: {
          type: 'string',
          description:
            'Filter by overall status: RECRUITING, ACTIVE_NOT_RECRUITING, COMPLETED, TERMINATED, WITHDRAWN, ENROLLING_BY_INVITATION, SUSPENDED, NOT_YET_RECRUITING',
        },
        phase: {
          type: 'string',
          description: 'Filter by phase: EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4',
        },
        sponsor: {
          type: 'string',
          description: 'Filter by sponsor name (e.g., "Pfizer", "Novo Nordisk")',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ct_get_study',
    description:
      'Get full study details for a clinical trial by its NCT ID. Returns the complete protocol section including eligibility, outcomes, and results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nct_id: {
          type: 'string',
          description: 'ClinicalTrials.gov NCT identifier (e.g., "NCT05462717")',
        },
      },
      required: ['nct_id'],
    },
  },
  {
    name: 'ct_count_by_condition',
    description:
      'Count the number of clinical trials for a condition or disease area. Useful for landscape analysis and competitive intelligence.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        condition: {
          type: 'string',
          description: 'Condition or disease (e.g., "breast cancer", "diabetes", "Alzheimer")',
        },
        status: {
          type: 'string',
          description: 'Optional status filter: RECRUITING, COMPLETED, etc.',
        },
        phase: {
          type: 'string',
          description: 'Optional phase filter: PHASE1, PHASE2, PHASE3, PHASE4',
        },
      },
      required: ['condition'],
    },
  },
  {
    name: 'ct_sponsor_trials',
    description:
      'List clinical trials run by a specific sponsor or pharmaceutical company. Useful for pipeline analysis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sponsor: {
          type: 'string',
          description: 'Sponsor or company name (e.g., "Pfizer", "Novo Nordisk", "Moderna")',
        },
        status: {
          type: 'string',
          description: 'Optional status filter',
        },
        phase: {
          type: 'string',
          description: 'Optional phase filter',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 20)',
        },
      },
      required: ['sponsor'],
    },
  },
  {
    name: 'ct_recent_updates',
    description:
      'Get recently updated or posted clinical trials, sorted by last update date. Good for monitoring pipeline changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Optional search term to narrow results',
        },
        limit: {
          type: 'number',
          description: 'Number of results (1-100, default 20)',
        },
      },
    },
  },
];

/* ── Helpers ───────────────────────────────────────────────────────── */

function formatStudy(s: Study) {
  const id = s.protocolSection?.identificationModule;
  const status = s.protocolSection?.statusModule;
  const design = s.protocolSection?.designModule;
  const conds = s.protocolSection?.conditionsModule;
  const arms = s.protocolSection?.armsInterventionsModule;
  const spon = s.protocolSection?.sponsorCollaboratorsModule;

  return {
    nct_id: id?.nctId ?? null,
    title: id?.briefTitle ?? null,
    official_title: id?.officialTitle ?? null,
    status: status?.overallStatus ?? null,
    phase: design?.phases?.join(', ') ?? null,
    enrollment: design?.enrollmentInfo?.count ?? null,
    enrollment_type: design?.enrollmentInfo?.type ?? null,
    conditions: conds?.conditions ?? [],
    interventions:
      arms?.interventions?.map((i) => ({
        type: i.type ?? null,
        name: i.name ?? null,
        description: i.description ?? null,
      })) ?? [],
    sponsor: spon?.leadSponsor?.name ?? null,
    sponsor_class: spon?.leadSponsor?.class ?? null,
    collaborators: spon?.collaborators?.map((c) => c.name) ?? [],
    start_date: status?.startDateStruct?.date ?? null,
    primary_completion_date: status?.primaryCompletionDateStruct?.date ?? null,
    completion_date: status?.completionDateStruct?.date ?? null,
  };
}

function buildFilters(status?: string, phase?: string): string[] {
  const filters: string[] = [];
  if (status) filters.push(`filter.overallStatus=${encodeURIComponent(status)}`);
  if (phase) filters.push(`filter.advanced=AREA[Phase]${encodeURIComponent(phase)}`);
  return filters;
}

/* ── Tool implementations ──────────────────────────────────────────── */

async function ctSearch(
  query: string,
  status?: string,
  phase?: string,
  sponsor?: string,
  limit?: number,
) {
  const pageSize = Math.min(100, Math.max(1, limit ?? 10));
  const params: string[] = [
    `query.term=${encodeURIComponent(query)}`,
    `countTotal=true`,
    `pageSize=${pageSize}`,
  ];
  if (sponsor) params.push(`query.spons=${encodeURIComponent(sponsor)}`);
  params.push(...buildFilters(status, phase));

  const res = await fetch(`${BASE}?${params.join('&')}`);
  if (!res.ok) throw new Error(`ClinicalTrials.gov API error: ${res.status}`);

  const data = (await res.json()) as StudiesResponse;
  return {
    total_count: data.totalCount ?? 0,
    studies: (data.studies ?? []).map(formatStudy),
  };
}

async function ctGetStudy(nctId: string) {
  const id = nctId.trim().toUpperCase();
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Study not found: ${id}`);
    throw new Error(`ClinicalTrials.gov API error: ${res.status}`);
  }
  return await res.json();
}

async function ctCountByCondition(condition: string, status?: string, phase?: string) {
  const params: string[] = [
    `query.cond=${encodeURIComponent(condition)}`,
    `countTotal=true`,
    `pageSize=0`,
  ];
  params.push(...buildFilters(status, phase));

  const res = await fetch(`${BASE}?${params.join('&')}`);
  if (!res.ok) throw new Error(`ClinicalTrials.gov API error: ${res.status}`);

  const data = (await res.json()) as StudiesResponse;
  return {
    condition,
    status_filter: status ?? 'all',
    phase_filter: phase ?? 'all',
    total_count: data.totalCount ?? 0,
  };
}

async function ctSponsorTrials(
  sponsor: string,
  status?: string,
  phase?: string,
  limit?: number,
) {
  const pageSize = Math.min(100, Math.max(1, limit ?? 20));
  const params: string[] = [
    `query.spons=${encodeURIComponent(sponsor)}`,
    `countTotal=true`,
    `pageSize=${pageSize}`,
  ];
  params.push(...buildFilters(status, phase));

  const res = await fetch(`${BASE}?${params.join('&')}`);
  if (!res.ok) throw new Error(`ClinicalTrials.gov API error: ${res.status}`);

  const data = (await res.json()) as StudiesResponse;
  return {
    sponsor,
    total_count: data.totalCount ?? 0,
    studies: (data.studies ?? []).map(formatStudy),
  };
}

async function ctRecentUpdates(query?: string, limit?: number) {
  const pageSize = Math.min(100, Math.max(1, limit ?? 20));
  const params: string[] = [
    `sort=LastUpdatePostDate:desc`,
    `countTotal=true`,
    `pageSize=${pageSize}`,
  ];
  if (query) params.push(`query.term=${encodeURIComponent(query)}`);

  const res = await fetch(`${BASE}?${params.join('&')}`);
  if (!res.ok) throw new Error(`ClinicalTrials.gov API error: ${res.status}`);

  const data = (await res.json()) as StudiesResponse;
  return {
    total_count: data.totalCount ?? 0,
    studies: (data.studies ?? []).map(formatStudy),
  };
}

/* ── callTool dispatcher ───────────────────────────────────────────── */

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ct_search':
      return ctSearch(
        args.query as string,
        args.status as string | undefined,
        args.phase as string | undefined,
        args.sponsor as string | undefined,
        args.limit as number | undefined,
      );
    case 'ct_get_study':
      return ctGetStudy(args.nct_id as string);
    case 'ct_count_by_condition':
      return ctCountByCondition(
        args.condition as string,
        args.status as string | undefined,
        args.phase as string | undefined,
      );
    case 'ct_sponsor_trials':
      return ctSponsorTrials(
        args.sponsor as string,
        args.status as string | undefined,
        args.phase as string | undefined,
        args.limit as number | undefined,
      );
    case 'ct_recent_updates':
      return ctRecentUpdates(
        args.query as string | undefined,
        args.limit as number | undefined,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
