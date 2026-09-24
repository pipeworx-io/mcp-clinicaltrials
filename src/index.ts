interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Search and analyze ClinicalTrials.gov: trials by keyword/condition/drug/status/phase, one study's full design and results, counts by condition, trials by location, and recently updated trials, plus a sponsor-analytics suite (a sponsor's trials, pipeline, and activity, and head-to-head sponsor comparison), catalyst calendars, competitive-landscape summaries, enrollment-watch, results summaries, and phase-transition rates.
 *
 * Tools:
 * - ct_search: search clinical trials by keyword, status, phase, sponsor
 * - ct_get_study: get full study details by NCT ID
 * - ct_count_by_condition: count trials by condition/disease area
 * - ct_sponsor_trials: list trials by sponsor/company
 * - ct_recent_updates: recently updated/posted trials
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Clinicaltrials');
}


const BASE = 'https://clinicaltrials.gov/api/v2/studies';

/* ── Types ─────────────────────────────────────────────────────────── */

type Study = {
  hasResults?: boolean;
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
      primaryCompletionDateStruct?: { date?: string; type?: string };
      completionDateStruct?: { date?: string; type?: string };
      studyFirstPostDateStruct?: { date?: string };
      lastUpdatePostDateStruct?: { date?: string };
      resultsFirstPostDateStruct?: { date?: string };
      whyStopped?: string;
    };
    designModule?: {
      studyType?: string;
      phases?: string[];
      designInfo?: { primaryPurpose?: string };
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
        otherNames?: string[];
      }[];
    };
    sponsorCollaboratorsModule?: {
      leadSponsor?: { name?: string; class?: string };
      collaborators?: { name?: string; class?: string }[];
    };
    outcomesModule?: {
      primaryOutcomes?: { measure?: string; description?: string; timeFrame?: string }[];
      secondaryOutcomes?: { measure?: string; description?: string; timeFrame?: string }[];
    };
    contactsLocationsModule?: {
      overallOfficials?: { name?: string; affiliation?: string; role?: string }[];
      locations?: { facility?: string; city?: string; state?: string; country?: string; status?: string }[];
    };
  };
  resultsSection?: {
    outcomeMeasuresModule?: { outcomeMeasures?: ResultOutcome[] };
    adverseEventsModule?: {
      frequencyThreshold?: string;
      timeFrame?: string;
      description?: string;
      eventGroups?: { id?: string; title?: string; deathsNumAffected?: number; seriousNumAffected?: number; otherNumAffected?: number }[];
    };
  };
};

type ResultOutcome = {
  title?: string; type?: string; reportingStatus?: string; timeFrame?: string;
  description?: string; paramType?: string; dispersionType?: string; unitOfMeasure?: string;
  groups?: { id?: string; title?: string; description?: string }[];
  analyses?: { groupIds?: string[]; pValue?: string; pValueComment?: string; paramType?: string; paramValue?: string; ciPctValue?: string; ciLowerLimit?: string; ciUpperLimit?: string }[];
  classes?: { title?: string; categories?: { title?: string; measurements?: { groupId?: string; value?: string; spread?: string; lowerLimit?: string; upperLimit?: string }[] }[] }[];
};

type StudiesResponse = {
  totalCount?: number;
  studies?: Study[];
};

/* ── Tool definitions ──────────────────────────────────────────────── */

type SponsorMatch = 'lead' | 'lead_or_collaborator';

const SPONSOR_MATCH_DESCRIPTION =
  'Which sponsor role the name must fill. "lead" (the default) returns only trials whose registered LEAD sponsor is that company. "lead_or_collaborator" also returns trials led by someone else that list the company as a collaborator — typically academic trials of the company\'s drug. Every returned study carries sponsor_match_field naming which one matched.';

const tools: McpToolExport['tools'] = [
  {
    name: 'ct_search',
    description:
      'Search ClinicalTrials.gov for clinical trials — find trials and look up a NAMED trial by keyword, condition, drug/therapy, status (e.g. \'Recruiting\'), or phase (e.g. \'Phase 2\'). Use for "clinical trials for <disease/drug>", or to locate a specific study like "the FLOW trial", "semaglutide kidney outcomes trial" (use ct_get_study for its full design/results). Returns NCT IDs, titles, status, enrollment, and sponsor info.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'The SUBJECT of the search — a condition, drug, or keyword (e.g., "GLP-1 receptor agonist", "breast cancer immunotherapy"). Prefer the topic alone over a full sentence: put status in `status` and phase in `phase` rather than in the text. Conversational framing is stripped automatically, and the term actually searched is echoed back as `query_used`.',
        },
        status: {
          type: 'string',
          description:
            'Filter by overall status: RECRUITING, ACTIVE_NOT_RECRUITING, COMPLETED, TERMINATED, WITHDRAWN, ENROLLING_BY_INVITATION, SUSPENDED, NOT_YET_RECRUITING. Several may be combined as a comma-separated union, e.g. "RECRUITING,NOT_YET_RECRUITING".',
        },
        phase: {
          type: 'string',
          description: 'Filter by phase: EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4 (or NA). Roman numerals ("Phase III") and comma-separated unions ("PHASE2,PHASE3") are accepted.',
        },
        sponsor_match: { type: 'string', enum: ['lead', 'lead_or_collaborator'], description: SPONSOR_MATCH_DESCRIPTION },
        sponsor: {
          type: 'string',
          description: 'Filter by the trial\'s registered LEAD sponsor (e.g., "Pfizer", "Novo Nordisk"). Widen to trials the company only partners on with sponsor_match: "lead_or_collaborator".',
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
      'Get full trial details by NCT ID (e.g., \'NCT04567890\'). Returns protocol, eligibility criteria, primary outcomes, sponsor, locations, and results.',
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
      'Count clinical trials for a condition or disease, broken down by recruitment status and by trial phase — how many are recruiting, completed, terminated, and how many are Phase 1, 2, 3 or 4. Use for landscape questions about how much trial activity a disease has and where it sits in development. Filtering by status or phase returns the filtered total without the breakdown.',
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
      'List the trials a company LEADS on ClinicalTrials.gov, by sponsor or organization name. Returns status, phase, and conditions to map a research pipeline. Matches the registered lead-sponsor field, so trials another organisation runs using the company\'s drug are excluded unless sponsor_match asks for them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sponsor_match: { type: 'string', enum: ['lead', 'lead_or_collaborator'], description: SPONSOR_MATCH_DESCRIPTION },
        sponsor: {
          type: 'string',
          description: 'Sponsor or company name (e.g., "Pfizer", "Novo Nordisk", "Moderna"). Matched against the registered LEAD sponsor by default.',
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
    name: 'ct_compare_sponsors',
    description:
      'Compare 2–5 NAMED lead sponsors on ClinicalTrials.gov under identical condition, recruitment-status, and phase filters. Returns full matching counts, a ranked comparison, and a small study sample for each sponsor. Use for questions like "who has more recruiting Phase 3 obesity trials, Novo Nordisk or Eli Lilly?" For an open "who are the TOP sponsors of X trials" question with no names given: the registry API has no group-by, so a true ranking is not computable — NEVER invent a candidate list to fake one; say the registry cannot rank sponsors and offer to compare specific named sponsors. Counts use the registered lead-sponsor field; registry records do not establish asset ownership, pipeline value, or probability of success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sponsors: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 5,
          description: 'Two to five sponsor names to compare under the same filters.',
        },
        condition: { type: 'string', description: 'Optional condition or disease, such as "obesity".' },
        status: { type: 'string', description: 'Optional status or comma-separated status union, such as RECRUITING.' },
        phase: { type: 'string', description: 'Optional phase or comma-separated phase union, such as PHASE3.' },
        sample_limit: { type: 'number', description: 'Representative studies per sponsor (0-10, default 3).' },
      },
      required: ['sponsors'],
    },
  },
  {
    name: 'ct_recent_updates',
    description:
      'Track recent ClinicalTrials.gov activity by a specific event class within a verifiable date window. Three DISTINCT recency events, chosen via date_type: "last_update" (any edit to a study, ~5k/week — the default), "first_posted" (a study newly REGISTERED, ~1.3k/week), or "results_posted" (RESULTS first posted, ~140/week). Pass `since` (and optional `until`, YYYY-MM-DD) to bound a window — e.g. the last 7 days — and the returned total_count is the exact number of studies in that window so you can verify a weekly count from the output. Every study returns all THREE dates separately (first_posted_date, last_update_post_date, results_first_post_date) plus the design fields a screen needs (study_type, primary_purpose, phase, status, enrollment, conditions, interventions, sponsor). Sorted by the chosen event date, newest first. Use for "new trials registered this week", "trials that posted results in the last month", "recently updated diabetes studies".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date_type: {
          type: 'string',
          description: 'Which recency event to track/sort/window by: "last_update" (any edit, default), "first_posted" (new registration), "results_posted" (results first posted). These are different event classes with very different volumes — pick deliberately.',
          enum: ['last_update', 'first_posted', 'results_posted'],
        },
        since: { type: 'string', description: 'Window start (inclusive), YYYY-MM-DD. e.g. for a weekly review pass 7 days ago. Applies to the chosen date_type.' },
        until: { type: 'string', description: 'Optional window end (inclusive), YYYY-MM-DD. Omit for open-ended (up to today).' },
        status: { type: 'string', description: 'Optional overall-status filter (validated; e.g. RECRUITING, or a comma-union like "RECRUITING,COMPLETED").' },
        query: { type: 'string', description: 'Optional search term (condition/drug/keyword) to narrow results.' },
        limit: { type: 'number', description: 'Number of results per page (1-100, default 20). total_count reports the full window size regardless of limit.' },
      },
    },
  },
  {
    name: 'ct_trials_by_location',
    description:
      'Find clinical trials near a LOCATION. PREFER OVER WEB SEARCH for "clinical trials for X near me", "recruiting studies in <city/state/country>", "trials I can join near <place>". Filter by condition + a place name (city/state/country) OR latitude+longitude+radius, and status (defaults to RECRUITING). Returns matching trials (NCT id, title, status, phase, conditions, sponsor). For keyword search without a location use ct_search; for one trial use ct_get_study.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        condition: { type: 'string', description: 'Condition/disease (e.g. "diabetes", "breast cancer immunotherapy"). Optional but recommended.' },
        location: { type: 'string', description: 'Place name — city, state, or country (e.g. "Boston", "California", "Germany"). Use this OR lat+lon.' },
        lat: { type: 'number', description: 'Latitude for a geo-radius search (pair with lon).' },
        lon: { type: 'number', description: 'Longitude (pair with lat).' },
        radius_mi: { type: 'number', description: 'Radius in miles for a lat/lon search (1-500, default 50).' },
        status: { type: 'string', description: 'Overall status filter (default RECRUITING). e.g. RECRUITING, NOT_YET_RECRUITING, ACTIVE_NOT_RECRUITING, COMPLETED.' },
        limit: { type: 'number', description: 'Max trials to return (1-100, default 15).' },
      },
    },
  },
  {
    name: 'ct_catalyst_calendar',
    description: 'Find trials with sponsor-entered primary-completion or study-completion dates in a specified window. These registry dates may be estimated or revised and are planning signals—not guaranteed data readouts, conference presentations, or regulatory events.',
    inputSchema: { type: 'object' as const, properties: {
      query: { type: 'string', description: 'Optional condition, intervention, or keyword.' },
      sponsor: { type: 'string', description: 'Optional company name. Matched against the registered LEAD sponsor by default.' },
      sponsor_match: { type: 'string', enum: ['lead', 'lead_or_collaborator'], description: SPONSOR_MATCH_DESCRIPTION },
      event_type: { type: 'string', enum: ['primary_completion', 'study_completion'] },
      from_date: { type: 'string', description: 'YYYY-MM-DD, inclusive.' }, to_date: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
      status: { type: 'string' }, phase: { type: 'string' }, limit: { type: 'number' },
    }, required: ['from_date', 'to_date'] },
  },
  {
    name: 'ct_sponsor_pipeline',
    description: 'Summarize a sponsor’s ClinicalTrials.gov portfolio by phase, status, condition, and intervention from a bounded relevance-ranked sample, while reporting the full matching count. Registration does not establish asset ownership, probability of success, or commercial value.',
    inputSchema: { type: 'object' as const, properties: {
      sponsor: { type: 'string', description: 'Company name, matched against the registered LEAD sponsor by default.' },
      sponsor_match: { type: 'string', enum: ['lead', 'lead_or_collaborator'], description: SPONSOR_MATCH_DESCRIPTION },
      status: { type: 'string' }, phase: { type: 'string' }, sample_size: { type: 'number' },
    }, required: ['sponsor'] },
  },
  {
    name: 'ct_competitive_landscape',
    description: 'Map registered interventional trials for a condition and optional intervention across sponsors, phases, statuses, and interventions. The output reflects a bounded registry sample, not market share, scientific differentiation, or an exhaustive private pipeline.',
    inputSchema: { type: 'object' as const, properties: {
      condition: { type: 'string' }, intervention: { type: 'string' }, status: { type: 'string' },
      phase: { type: 'string' }, sample_size: { type: 'number' },
    }, required: ['condition'] },
  },
  {
    name: 'ct_enrollment_watch',
    description: 'Route active trials for enrollment follow-up using registry status, enrollment type, dates, last update, and site counts. Flags are mechanical review hints—not predictions of recruitment success, trial failure, or data timing.',
    inputSchema: { type: 'object' as const, properties: {
      query: { type: 'string' },
      sponsor: { type: 'string', description: 'Optional company name. Matched against the registered LEAD sponsor by default.' },
      sponsor_match: { type: 'string', enum: ['lead', 'lead_or_collaborator'], description: SPONSOR_MATCH_DESCRIPTION },
      phase: { type: 'string' }, limit: { type: 'number' },
    }},
  },
  {
    name: 'ct_results_summary',
    description: 'Project posted ClinicalTrials.gov results for one NCT ID, including registered endpoints, reported outcome measures, statistical analyses, and adverse-event group counts. Registry results are not an FDA conclusion, peer review, or investment recommendation.',
    inputSchema: { type: 'object' as const, properties: {
      nct_id: { type: 'string' }, max_outcomes: { type: 'number', description: 'Reported outcomes returned (1-50, default 20).' },
    }, required: ['nct_id'] },
  },
  {
    name: 'ct_phase_transition_rates',
    description:
      'Measure how often drugs for a disease actually advance from one clinical phase to the next — the registry-derived analog of a probability-of-technical-success (PTRS) benchmark. Groups industry-sponsored interventional trials for the condition by normalized intervention (drug) name, then reports observed Phase 1→Phase 2 and Phase 2→Phase 3 transition rates as numerator/denominator with an explicit censoring rule, alongside the published BIO/Informa/QLS 2011-2020 benchmark for the matching therapeutic area. Answers "what fraction of Phase 2 assets in NSCLC reach Phase 3", "how does attrition in Alzheimer compare to lung cancer", "what is the probability of success for this indication". Returns the top interventions with their per-phase trial path so the rate is auditable. Counts trial EXISTENCE in the registry, not efficacy readouts or approvals, so it is an upper bound on technical success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        condition: { type: 'string', description: 'Disease or condition, e.g. "non-small cell lung cancer", "Alzheimer disease", "type 2 diabetes".' },
        sponsor_class: { type: 'string', enum: ['industry', 'all'], description: 'Which sponsors to count. "industry" (default) restricts to company-led trials, matching how commercial PTRS benchmarks are built; "all" adds academic, NIH and other sponsors, which raises the count and lowers the rate.' },
        from_year: { type: 'number', description: 'Optional earliest year for the EARLIER-phase completion date (e.g. 2010). Omit for no floor.' },
        to_year: { type: 'number', description: 'Analysis end year; the censoring window is measured back from here. Defaults to the current year.' },
        censor_years: { type: 'number', description: 'Years an earlier-phase trial must have been completed before to_year to enter the denominator (1-15, default 3). Raising it demands more follow-up time, shrinking the denominator; lowering it admits assets that have not yet had time to advance and depresses the rate.' },
        max_pages: { type: 'number', description: 'Upstream pages of 1000 studies to pull (1-5, default 5). The response reports truncated: true when the cap cut off the match set.' },
      },
      required: ['condition'],
    },
  },
  {
    name: 'ct_sponsor_activity',
    description: 'Track a sponsor’s newly registered studies, first-posted results, or study updates within a verifiable date window. Registry activity is not necessarily a corporate disclosure or material event.',
    inputSchema: { type: 'object' as const, properties: {
      sponsor: { type: 'string', description: 'Company name, matched against the registered LEAD sponsor by default.' },
      sponsor_match: { type: 'string', enum: ['lead', 'lead_or_collaborator'], description: SPONSOR_MATCH_DESCRIPTION },
      date_type: { type: 'string', enum: ['last_update', 'first_posted', 'results_posted'] },
      since: { type: 'string' }, until: { type: 'string' }, limit: { type: 'number' },
    }, required: ['sponsor', 'since'] },
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
    collaborators: spon?.collaborators?.map((c) => c.name).filter(isString) ?? [],
    start_date: status?.startDateStruct?.date ?? null,
    primary_completion_date: status?.primaryCompletionDateStruct?.date ?? null,
    completion_date: status?.completionDateStruct?.date ?? null,
  };
}

// Valid ClinicalTrials.gov v2 overallStatus enum. Chaining a status that isn't
// here — or mixing status across the API's `filter.overallStatus` and
// `aggFilters` mechanisms — makes the API AND the constraints and silently
// return HTTP 200 with totalCount 0 (a trial has exactly one status, so the
// intersection is always empty). That empty result reads as a real "zero
// trials" finding when it is actually a malformed filter. We defend against it.
const CT_STATUS_CODES = new Set([
  'ACTIVE_NOT_RECRUITING', 'COMPLETED', 'ENROLLING_BY_INVITATION', 'NOT_YET_RECRUITING',
  'RECRUITING', 'SUSPENDED', 'TERMINATED', 'WITHDRAWN', 'AVAILABLE', 'NO_LONGER_AVAILABLE',
  'TEMPORARILY_NOT_AVAILABLE', 'APPROVED_FOR_MARKETING', 'WITHHELD', 'UNKNOWN',
]);

/**
 * Normalize a status argument to the API's comma-separated UNION form. Accepts
 * one status, or several as a comma / pipe / space-separated list. Every token
 * is validated against the enum: an unknown code THROWS a clear error rather
 * than letting the API return a wrong or zero count. Multiple statuses always
 * become a union (OR) — never the impossible intersection that silently zeroes.
 */
function normalizeStatus(status: string): string {
  const tokens = status.split(/[,|]+/).map((t) => t.trim().toUpperCase().replace(/\s+/g, '_')).filter(Boolean);
  const invalid = tokens.filter((t) => !CT_STATUS_CODES.has(t));
  if (invalid.length) {
    throw new Error(
      `Invalid trial status ${invalid.map((s) => `"${s}"`).join(', ')}. ` +
      `Valid statuses: ${[...CT_STATUS_CODES].join(', ')}. ` +
      `To count several, pass a comma-separated union, e.g. status: "RECRUITING,ACTIVE_NOT_RECRUITING" — never chained as separate constraints, which the API intersects to 0.`,
    );
  }
  return [...new Set(tokens)].join(',');
}

// Valid `AREA[Phase]` enum. Unlike overallStatus, the phase area accepts loose
// spacing ("Phase 2" works) but REJECTS roman numerals ("Phase III") and
// comma-unions ("PHASE2,PHASE3") with an HTTP 400 — both of which are exactly
// what a model writes. Normalize to the enum instead of forwarding raw text.
const CT_PHASE_CODES = new Set(['NA', 'EARLY_PHASE1', 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4']);
const ROMAN_PHASE: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4' };

function normalizePhase(phase: string): string[] {
  const parts = String(phase).split(/[,|]+/).map((p) => p.trim()).filter(Boolean);
  const codes = parts.map((p) => {
    const t = p.toUpperCase().replace(/[\s_-]+/g, '');
    if (/^EARLYPHASE(I|1)$/.test(t)) return 'EARLY_PHASE1';
    const m = t.match(/^(?:PHASE)?(IV|III|II|I|1|2|3|4)$/);
    if (m) return `PHASE${ROMAN_PHASE[m[1].toLowerCase()] ?? m[1]}`;
    if (t === 'NA' || t === 'N/A') return 'NA';
    return t;
  });
  const invalid = codes.filter((c) => !CT_PHASE_CODES.has(c));
  if (invalid.length) {
    throw new Error(
      `Invalid trial phase ${invalid.map((s) => `"${s}"`).join(', ')}. ` +
      `Valid phases: EARLY_PHASE1, PHASE1, PHASE2, PHASE3, PHASE4, NA. ` +
      `Roman numerals ("Phase III") and comma-unions ("PHASE2,PHASE3") are accepted and converted.`,
    );
  }
  return [...new Set(codes)];
}

/**
 * Conversational framing and document-universal meta nouns.
 *
 * `query.term` is an Essie expression that ANDs every token across the whole
 * study document. So a natural-language question — which is what an agent
 * forwards when the user asks one — ANDs 6-10 filler tokens onto the two that
 * matter and collapses the match set to zero. The API answers HTTP 200 with
 * totalCount 0, so it books as a legitimate "no trials found" when the truth is
 * thousands of trials ("Show me recruiting Phase 3 trials for obesity" returned
 * 0; "obesity" + the two filters returns 101). Strip the framing so the search
 * runs on the subject of the question, not on the way it was phrased.
 */
const CT_FRAMING_TOKENS = new Set([
  // interrogative / imperative framing
  'what', 'whats', 'which', 'who', 'whom', 'where', 'when', 'why', 'how', 'show', 'me', 'my',
  'mine', 'find', 'get', 'list', 'tell', 'give', 'us', 'i', 'we', 'our', 'you', 'your', 'want',
  'wanna', 'need', 'know', 'about', 'can', 'could', 'would', 'should', 'please', 'is', 'are',
  'am', 'was', 'were', 'be', 'been', 'being', 'there', 'any', 'some', 'all', 'do', 'does', 'did',
  'have', 'has', 'had', 'looking', 'look', 'searching', 'search', 'seeking', 'seek', 'like',
  'help', 'currently', 'current', 'ongoing', 'latest', 'newest', 'recent', 'new', 'available',
  'existing',
  // articles / prepositions / conjunctions
  'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'with', 'and', 'or', 'from', 'by', 'as',
  'that', 'this', 'these', 'those', 'it', 'its', 'their', 'info', 'information', 'data',
  'anyone', 'anybody', 'someone', 'somebody', 'everyone', 'anything', 'something',
  // meta nouns that appear in essentially every study document, so they filter nothing
  // but still AND into the expression
  'trial', 'trials', 'study', 'studies', 'studying', 'clinical', 'research', 'testing', 'test',
  'trail', 'trails', 'patient', 'patients', 'participant', 'participants', 'people', 'person',
  'volunteer', 'volunteers', 'subjects',
  // temporal framing — a question's "right now" is about the STATUS filter, not
  // words in the document
  'right', 'now', 'today', 'still', 'underway', 'happening', 'going', 'anymore', 'yet',
]);

// Status/phase intent expressed inside the free-text query. Lifted OUT of the
// term and INTO the real filters (which is both more accurate and cheaper than
// leaving them to AND against the document text) — but only when the caller
// didn't pass the corresponding argument explicitly.
const CT_STATUS_PHRASES: [RegExp, string][] = [
  [/\bnot\s+yet\s+recruiting\b/gi, 'NOT_YET_RECRUITING'],
  [/\bactive[,\s]+not\s+recruiting\b/gi, 'ACTIVE_NOT_RECRUITING'],
  [/\benrolling\s+by\s+invitation\b/gi, 'ENROLLING_BY_INVITATION'],
  [/\brecruiting\b/gi, 'RECRUITING'],
  // "enrolling" / "accepting patients" mean RECRUITING to a person asking the
  // question; as free text they AND against words most study documents don't
  // contain. Ordered AFTER enrolling-by-invitation, which consumes its phrase
  // first, so the narrower status still wins.
  [/\b(?:actively\s+|currently\s+|now\s+)?enroll(?:ing|s|ed)?\b/gi, 'RECRUITING'],
  [/\baccepting\s+(?:new\s+)?(?:patients|participants|volunteers)\b/gi, 'RECRUITING'],
  [/\bopen\s+for\s+enrollment\b/gi, 'RECRUITING'],
  [/\bcompleted\b/gi, 'COMPLETED'],
  [/\bterminated\b/gi, 'TERMINATED'],
  [/\bwithdrawn\b/gi, 'WITHDRAWN'],
  [/\bsuspended\b/gi, 'SUSPENDED'],
];
const CT_PHASE_PHRASE = /\b(?:early\s+)?phase\s*(iv|iii|ii|i|1|2|3|4)\b/gi;

type ParsedQuery = {
  term: string;
  tokens: string[];
  inferredStatus: string[];
  inferredPhase: string[];
};

function parseQueryText(raw: string, hasStatus: boolean, hasPhase: boolean): ParsedQuery {
  let text = String(raw ?? '');
  const inferredStatus: string[] = [];
  const inferredPhase: string[] = [];

  if (!hasStatus) {
    for (const [re, code] of CT_STATUS_PHRASES) {
      re.lastIndex = 0;
      if (re.test(text)) {
        inferredStatus.push(code);
        re.lastIndex = 0;
        text = text.replace(re, ' ');
      }
    }
  }
  if (!hasPhase) {
    CT_PHASE_PHRASE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CT_PHASE_PHRASE.exec(text)) !== null) {
      const digit = ROMAN_PHASE[m[1].toLowerCase()] ?? m[1];
      inferredPhase.push(/early/i.test(m[0]) ? 'EARLY_PHASE1' : `PHASE${digit}`);
    }
    if (inferredPhase.length) text = text.replace(CT_PHASE_PHRASE, ' ');
  }

  const cleaned = text.replace(/[?!]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(' ').filter(Boolean);
  const kept = tokens.filter(
    (t) => !CT_FRAMING_TOKENS.has(t.toLowerCase().replace(/^[^\w-]+|[^\w-]+$/g, '')),
  );

  return {
    // If the query was ALL framing, keep it verbatim rather than degrading to a
    // match-everything wildcard.
    term: kept.length ? kept.join(' ') : cleaned,
    tokens: kept,
    inferredStatus: [...new Set(inferredStatus)],
    inferredPhase: [...new Set(inferredPhase)],
  };
}

/** Surface the API's own error message (it returns a descriptive plain-text
 * body, e.g. "Invalid value in parameter `overallStatus`: `FOO`") instead of a
 * bare status code, so malformed filters fail loudly and actionably. */
async function ctError(res: Response): Promise<never> {
  const body = (await res.text().catch(() => '')).trim().slice(0, 300);
  throw new Error(`ClinicalTrials.gov API error ${res.status}${body ? `: ${body}` : ''}`);
}

// Parenthesised OR union — the API rejects the comma form outright.
function phaseClause(phases: string[]): string {
  return `AREA[Phase](${phases.join(' OR ')})`;
}

/**
 * The API accepts exactly ONE `filter.advanced`. A second copy is rejected
 * outright — "`filter.advanced` is single value parameter, but request has 2
 * values" — rather than merged, so every advanced clause has to be collected
 * and AND-joined into a single param. That is why the helpers around here hand
 * back clauses instead of finished params.
 */
function advancedParam(clauses: string[]): string[] {
  return clauses.length ? [`filter.advanced=${encodeURIComponent(clauses.join(' AND '))}`] : [];
}

function sponsorMatchArg(value: unknown): SponsorMatch {
  const raw = value == null ? 'lead' : String(value).trim().toLowerCase();
  if (raw === 'lead' || raw === 'lead_or_collaborator') return raw;
  throw new Error(
    `sponsor_match must be "lead" (the default — registered lead sponsor only) or "lead_or_collaborator"; got ${JSON.stringify(value)}`,
  );
}

/**
 * Filter on the sponsor the caller actually named.
 *
 * Every sponsor-taking tool here used `query.spons` until 2026-08-29, which is
 * not a sponsor filter at all — it is a broad search that also matches
 * collaborators and free text. Measured against the live API:
 * `query.spons=Merck Sharp & Dohme LLC` returns 4,282 studies, led by the
 * University of Utah and Weill Cornell among others, where the registered lead
 * sponsor is Merck on 2,175 of them. A caller asking what Merck is about to
 * read out got a clean 200 in which most rows belonged to other organisations
 * (fleet #658).
 */
function sponsorClause(sponsor: string, match: SponsorMatch): string {
  const phrase = advancedPhrase(sponsor);
  return match === 'lead_or_collaborator'
    ? `(AREA[LeadSponsorName]${phrase} OR AREA[CollaboratorName]${phrase})`
    : `AREA[LeadSponsorName]${phrase}`;
}

/**
 * Which field earned a study its place in a sponsor-filtered result. Under
 * `lead` that is always the lead sponsor; under the broad mode a caller
 * otherwise cannot tell why a Baylor-led trial came back for a Merck query.
 */
function sponsorMatchField(
  study: { sponsor: string | null; collaborators: string[] },
  sponsor: string,
): 'lead_sponsor' | 'collaborator' | null {
  const want = normalizeSponsorToken(sponsor);
  const hit = (name: string | null | undefined) => {
    if (!name || !want) return false;
    const norm = normalizeSponsorToken(name);
    return norm.includes(want) || want.includes(norm);
  };
  if (hit(study.sponsor)) return 'lead_sponsor';
  if (study.collaborators.some(hit)) return 'collaborator';
  return null;
}

/** Tag each study with the field that matched, when a sponsor filter was applied. */
function withSponsorMatch<T extends { sponsor: string | null; collaborators: string[] }>(
  studies: T[],
  sponsor: string | null | undefined,
): T[] | Array<T & { sponsor_match_field: 'lead_sponsor' | 'collaborator' | null }> {
  if (!sponsor) return studies;
  return studies.map((study) => ({ ...study, sponsor_match_field: sponsorMatchField(study, sponsor) }));
}

/** Does the relevance-ranked first page of an OR relaxation actually answer the
 * question? True when at least one study mentions two or more of the asked-for
 * tokens — searchable text only (title/conditions/interventions), not the whole
 * record, so a token appearing in boilerplate doesn't count. */
function relaxedIsRelevant(data: StudiesResponse, tokens: string[]): boolean {
  const wanted = [...new Set(tokens.map((t) => t.toLowerCase().replace(/^[^\w-]+|[^\w-]+$/g, '')))]
    .filter(Boolean);
  if (wanted.length < 2) return true;
  for (const study of (data.studies ?? []).slice(0, 5)) {
    const p = study.protocolSection ?? {};
    const hay = [
      p.identificationModule?.briefTitle,
      p.identificationModule?.officialTitle,
      ...(p.conditionsModule?.conditions ?? []),
      ...(p.armsInterventionsModule?.interventions ?? []).map((i) => i?.name),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (wanted.filter((t) => hay.includes(t)).length >= 2) return true;
  }
  return false;
}

function buildFilters(status?: string, phase?: string): { params: string[]; clauses: string[] } {
  const params: string[] = [];
  const clauses: string[] = [];
  if (status) params.push(`filter.overallStatus=${encodeURIComponent(normalizeStatus(status))}`);
  if (phase) clauses.push(phaseClause(normalizePhase(phase)));
  return { params, clauses };
}

/* ── Tool implementations ──────────────────────────────────────────── */

async function ctSearch(
  query: string,
  status?: string,
  phase?: string,
  sponsor?: string,
  limit?: number,
  sponsorMatchRaw?: unknown,
) {
  const sponsorMatch = sponsorMatchArg(sponsorMatchRaw);
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error(
      'Required argument "query" is missing or empty. Pass a condition, drug, or keyword like "semaglutide obesity".',
    );
  }
  const pageSize = Math.min(100, Math.max(1, limit ?? 10));
  const parsed = parseQueryText(query, !!status, !!phase);

  const statusCsv = status
    ? normalizeStatus(status)
    : parsed.inferredStatus.join(',');
  const phases = phase ? normalizePhase(phase) : parsed.inferredPhase;

  const advanced: string[] = [];
  if (sponsor) advanced.push(sponsorClause(sponsor, sponsorMatch));
  if (phases.length) advanced.push(phaseClause(phases));

  const baseParams: string[] = [`countTotal=true`, `pageSize=${pageSize}`];
  if (statusCsv) baseParams.push(`filter.overallStatus=${encodeURIComponent(statusCsv)}`);
  baseParams.push(...advancedParam(advanced));

  const fetchTerm = async (term: string, byRelevance = false): Promise<StudiesResponse> => {
    const url = `${BASE}?query.term=${encodeURIComponent(term)}&${baseParams.join('&')}${
      byRelevance ? '&sort=%40relevance' : ''
    }`;
    const res = await pwFetch(url);
    if (!res.ok) await ctError(res);
    return (await res.json()) as StudiesResponse;
  };

  let termUsed = parsed.term;
  let matchMode: 'all_terms' | 'any_term' = 'all_terms';
  let data = await fetchTerm(termUsed);

  // Last-resort relaxation. query.term ANDs its tokens, so a multi-word query
  // can still miss even after framing is stripped. Only fires when we would
  // otherwise hand back an empty result that reads as "no such trials exist".
  //
  // Sorted by @relevance, unlike the AND path. An OR over N tokens matches
  // anything containing ANY of them — 150k studies for a three-token cancer
  // query — and in the API's default order the first page came back as acute
  // myeloid leukemia, neonatal cord clamping and stage III NSCLC for a
  // pancreatic-immunotherapy question. A confidently-wrong first page is worse
  // than the empty it replaced, so the relaxed path must rank.
  //
  // And it must still be allowed to say no. An OR is satisfied by ONE token, so
  // "zzqqx fictional syndrome" matches the ~100k studies containing "syndrome"
  // and comes back looking like an answer. Guard: accept the relaxation only if
  // some study on the ranked first page actually mentions at least TWO of the
  // asked-for tokens. A page where every hit matched one word is noise, and the
  // honest response to a query about a disease that doesn't exist is zero.
  if ((data.totalCount ?? 0) === 0 && parsed.tokens.length > 1) {
    const orTerm = parsed.tokens.join(' OR ');
    const relaxed = await fetchTerm(orTerm, true);
    if ((relaxed.totalCount ?? 0) > 0 && relaxedIsRelevant(relaxed, parsed.tokens)) {
      data = relaxed;
      termUsed = orTerm;
      matchMode = 'any_term';
    }
  }

  return {
    // Report what we actually searched — the caller asked for `query`, and if we
    // rewrote it they need to see that to judge the result.
    query_used: termUsed,
    match_mode: matchMode, // all_terms = every term matched; any_term = relaxed to OR
    filters_applied: {
      status: statusCsv || null,
      phase: phases.length ? phases.join(',') : null,
      sponsor: sponsor ?? null,
      sponsor_match: sponsor ? sponsorMatch : null,
      // true when we lifted status/phase out of the free-text query itself
      inferred_from_query: !status && parsed.inferredStatus.length > 0
        || !phase && parsed.inferredPhase.length > 0,
    },
    total_count: data.totalCount ?? 0,
    studies: withSponsorMatch((data.studies ?? []).map(formatStudy), sponsor),
  };
}

async function ctGetStudy(nctId: string) {
  if (typeof nctId !== 'string' || !nctId.trim()) {
    throw new Error('Required argument "nct_id" is missing or empty. Pass an NCT ID like "NCT04267848".');
  }
  const id = nctId.trim().toUpperCase();
  const res = await pwFetch(`${BASE}/${encodeURIComponent(id)}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error(`not_found: ClinicalTrials.gov has no study ${id} — that NCT id is not registered (or was withdrawn/never assigned). Search by condition/intervention with ct_search instead of guessing an id.`);
    throw await httpError(res, 'ClinicalTrials.gov API error');
  }
  return await res.json();
}

/**
 * The description has always promised "breakdown by status and phase"; the
 * implementation returned a bare total, so every landscape question got a
 * single number and a claim that it was a breakdown.
 *
 * ClinicalTrials.gov has no aggregation endpoint, so the breakdown is one
 * count per bucket, issued in parallel: 8 statuses + 6 phases is one round
 * trip, not fourteen. Fifteen counts is only affordable if a count is cheap,
 * and the obvious way to ask for one is a lie: the API ACCEPTS pageSize=0 and
 * ignores it, sending a full default page anyway. Measured live on 2026-08-21
 * for query.cond=melanoma, all three returning the identical totalCount=3745:
 *
 *   pageSize=0                -> 290,480 bytes
 *   pageSize=1                ->  14,456 bytes
 *   pageSize=1&fields=NCTId   ->     167 bytes
 *
 * So ctCount asks for one study and one field. The payload it discards is the
 * whole cost — at pageSize=0 this tool moved ~4 MB per call to read fifteen
 * integers, and a filtered bucket was worse, not better (AREA[Phase](PHASE3)
 * came back 484,144 bytes for the number 219).
 */
const CT_STATUSES = [
  'RECRUITING', 'NOT_YET_RECRUITING', 'ACTIVE_NOT_RECRUITING', 'COMPLETED',
  'TERMINATED', 'WITHDRAWN', 'SUSPENDED', 'ENROLLING_BY_INVITATION',
] as const;
const CT_PHASES = ['EARLY_PHASE1', 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4', 'NA'] as const;

async function ctCount(condition: string, status?: string, phase?: string): Promise<number> {
  // pageSize=1&fields=NCTId, not pageSize=0 — see the note above. fields= is
  // safe to narrow here because it only trims the returned study records;
  // totalCount is computed over the whole match set and was verified identical
  // under no filter, filter.overallStatus and filter.advanced.
  const params = [
    `query.cond=${encodeURIComponent(condition)}`,
    'countTotal=true',
    'pageSize=1',
    'fields=NCTId',
  ];
  const filters = buildFilters(status, phase);
  params.push(...filters.params, ...advancedParam(filters.clauses));
  const res = await pwFetch(`${BASE}?${params.join('&')}`);
  if (!res.ok) await ctError(res);
  const data = (await res.json()) as StudiesResponse;
  return data.totalCount ?? 0;
}

async function ctCountByCondition(condition: string, status?: string, phase?: string) {
  const total = await ctCount(condition, status, phase);

  // With a filter applied the buckets would just re-slice one bucket, which is
  // noise. Say why rather than returning a breakdown that means nothing.
  if (status || phase) {
    return {
      condition,
      status_filter: status ?? 'all',
      phase_filter: phase ?? 'all',
      total_count: total,
      note: 'Breakdown omitted because a status or phase filter is applied — call without filters for the full landscape.',
      source: 'ClinicalTrials.gov',
    };
  }

  const [statusCounts, phaseCounts] = await Promise.all([
    Promise.all(CT_STATUSES.map((st) => ctCount(condition, st).then((n) => [st, n] as const))),
    Promise.all(CT_PHASES.map((ph) => ctCount(condition, undefined, ph).then((n) => [ph, n] as const))),
  ]);

  const by_status = Object.fromEntries(statusCounts.filter(([, n]) => n > 0));
  const by_phase = Object.fromEntries(phaseCounts.filter(([, n]) => n > 0));

  return {
    condition,
    status_filter: 'all',
    phase_filter: 'all',
    total_count: total,
    by_status,
    by_phase,
    // Buckets are counted independently and a trial can carry more than one
    // phase label, so the parts do not have to sum to the whole. Saying so
    // beats a caller quietly concluding the numbers are wrong. The marginals
    // warning exists because a caller once quoted by_status.RECRUITING as the
    // answer to "recruiting Phase 3" — off by 14x from the true intersection.
    note: 'by_status and by_phase are independent marginals over ALL trials for this condition, unfiltered: by_status.RECRUITING spans every phase and by_phase.PHASE3 spans every status. To answer a combined question (e.g. recruiting Phase 3), re-call with both status and phase — the marginals cannot be intersected. Phase labels can overlap, so by_phase need not sum to total_count.',
    source: 'ClinicalTrials.gov',
  };
}

async function ctSponsorTrials(
  sponsor: string,
  status?: string,
  phase?: string,
  limit?: number,
  sponsorMatchRaw?: unknown,
) {
  const sponsorMatch = sponsorMatchArg(sponsorMatchRaw);
  const pageSize = Math.min(100, Math.max(1, limit ?? 20));
  const filters = buildFilters(status, phase);
  const params: string[] = [
    `countTotal=true`,
    `pageSize=${pageSize}`,
    ...filters.params,
    ...advancedParam([sponsorClause(sponsor, sponsorMatch), ...filters.clauses]),
  ];

  const res = await pwFetch(`${BASE}?${params.join('&')}`);
  if (!res.ok) await ctError(res);

  const data = (await res.json()) as StudiesResponse;
  return {
    sponsor,
    sponsor_match: sponsorMatch,
    total_count: data.totalCount ?? 0,
    ...(await sponsorYieldWarning(sponsor, data.totalCount ?? 0, sponsorMatch)),
    studies: withSponsorMatch((data.studies ?? []).map(formatStudy), sponsor),
  };
}

function advancedPhrase(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function ctCompareSponsors(args: Record<string, unknown>) {
  if (!Array.isArray(args.sponsors)) throw new Error('sponsors must be an array of 2 to 5 sponsor names');
  const sponsors = [...new Set(args.sponsors.map((value) => String(value).trim()).filter(Boolean))];
  if (sponsors.length < 2 || sponsors.length > 5) throw new Error('sponsors must contain 2 to 5 distinct non-empty names');
  const condition = stringArg(args.condition);
  const status = stringArg(args.status);
  const phase = stringArg(args.phase);
  const sampleLimit = intArg(args.sample_limit, 3, 0, 10);
  const statusFilter = status ? normalizeStatus(status) : null;
  const phaseFilter = phase ? normalizePhase(phase) : [];

  const comparisons = await Promise.all(sponsors.map(async (sponsor) => {
    const advanced = [sponsorClause(sponsor, 'lead')];
    if (phaseFilter.length) advanced.push(phaseClause(phaseFilter));
    const params = [
      'countTotal=true',
      `pageSize=${sampleLimit}`,
      ...advancedParam(advanced),
    ];
    if (condition) params.push(`query.cond=${encodeURIComponent(condition)}`);
    if (statusFilter) params.push(`filter.overallStatus=${encodeURIComponent(statusFilter)}`);
    const data = await boundedStudies(params);
    const studies = (data.studies ?? []).map(formatStudy);
    return {
      sponsor_requested: sponsor,
      total_count: data.totalCount ?? 0,
      registered_lead_sponsors_in_sample: [...new Set(studies.map((study) => study.sponsor).filter(isString))],
      studies,
      ...(await sponsorYieldWarning(sponsor, data.totalCount ?? 0)),
    };
  }));

  const ranked = comparisons
    .map((comparison) => ({ sponsor: comparison.sponsor_requested, total_count: comparison.total_count }))
    .sort((a, b) => b.total_count - a.total_count || a.sponsor.localeCompare(b.sponsor));
  let previousCount: number | null = null;
  let previousRank = 0;
  const ranking = ranked.map((row, index) => {
    const rank = previousCount === row.total_count ? previousRank : index + 1;
    previousCount = row.total_count;
    previousRank = rank;
    return { rank, ...row };
  });
  const highest = ranking[0]?.total_count ?? 0;

  return {
    filters: {
      condition: condition ?? null,
      status: statusFilter,
      phase: phaseFilter.length ? phaseFilter.join(',') : null,
      sponsor_role: 'lead sponsor',
    },
    leaders: ranking.filter((row) => row.total_count === highest).map((row) => row.sponsor),
    ranking,
    comparisons,
    interpretation: 'Counts apply identical filters to the registered lead-sponsor field. They describe public registry records, not asset ownership, trial quality, probability of success, market share, or commercial value.',
  };
}

// The three ClinicalTrials.gov "recency" events are DISTINCT classes with very
// different weekly volumes — first registration (~1.3k/wk), any edit to a study
// (~5k/wk), and results first posted (~140/wk). Collapsing them (as the old tool
// did — it sorted by last-update but returned no date at all) makes a weekly
// window unverifiable. Callers pick which event to track; all three dates are
// always returned so the window can be checked from the output itself.
const CT_DATE_FIELDS = {
  last_update: 'LastUpdatePostDate',
  first_posted: 'StudyFirstPostDate',
  results_posted: 'ResultsFirstPostDate',
} as const;
type CtDateType = keyof typeof CT_DATE_FIELDS;

const isoDateOrNull = (v?: string): string | null => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

async function ctRecentUpdates(args: Record<string, unknown>) {
  const pageSize = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const status = typeof args.status === 'string' ? args.status.trim() : '';

  const rawType = String(args.date_type ?? 'last_update').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!(rawType in CT_DATE_FIELDS)) {
    throw new Error(`Invalid date_type "${args.date_type}". Valid: last_update (any edit), first_posted (new registration), results_posted (results first posted).`);
  }
  const dateType = rawType as CtDateType;
  const area = CT_DATE_FIELDS[dateType];

  // Window: since (inclusive) .. until (default open). Both YYYY-MM-DD.
  const since = typeof args.since === 'string' ? args.since.trim() : '';
  const until = typeof args.until === 'string' ? args.until.trim() : '';
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (since && !dateRe.test(since)) throw new Error(`Invalid "since" date "${since}" — use YYYY-MM-DD.`);
  if (until && !dateRe.test(until)) throw new Error(`Invalid "until" date "${until}" — use YYYY-MM-DD.`);

  const params: string[] = [
    `sort=${area}:desc`,
    `countTotal=true`,
    `pageSize=${pageSize}`,
  ];
  if (query) params.push(`query.term=${encodeURIComponent(query)}`);
  if (status) params.push(...buildFilters(status).params);
  if (since || until) {
    const range = `RANGE[${since || 'MIN'},${until || 'MAX'}]`;
    params.push(...advancedParam([`AREA[${area}]${range}`]));
  }

  const res = await pwFetch(`${BASE}?${params.join('&')}`);
  if (!res.ok) await ctError(res);

  const data = (await res.json()) as StudiesResponse;
  const studies = (data.studies ?? []).map((s) => {
    const sm = s.protocolSection?.statusModule;
    const dm = s.protocolSection?.designModule;
    return {
      ...formatStudy(s),
      study_type: dm?.studyType ?? null,
      primary_purpose: dm?.designInfo?.primaryPurpose ?? null,
      // Three distinct recency events, kept separate:
      first_posted_date: isoDateOrNull(sm?.studyFirstPostDateStruct?.date),
      last_update_post_date: isoDateOrNull(sm?.lastUpdatePostDateStruct?.date),
      results_first_post_date: isoDateOrNull(sm?.resultsFirstPostDateStruct?.date),
    };
  });

  return {
    date_type: dateType,
    sorted_by: `${area} desc`,
    window: { since: since || null, until: until || null },
    total_count: data.totalCount ?? 0, // studies matching the window — verify your weekly count against this
    returned: studies.length,
    studies,
  };
}

/* ── callTool dispatcher ───────────────────────────────────────────── */

async function ctTrialsByLocation(args: Record<string, unknown>) {
  const condition = String(args.condition ?? '').trim();
  const location = String(args.location ?? '').trim();
  const lat = Number(args.lat), lon = Number(args.lon);
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lon);
  if (!location && !hasGeo) throw new Error('Provide either "location" (a city/state/country name) or "lat"+"lon".');
  const status = (String(args.status ?? 'RECRUITING').trim().toUpperCase()) || 'RECRUITING';
  const radius = Math.min(500, Math.max(1, Number(args.radius_mi) || 50));
  const pageSize = Math.min(100, Math.max(1, Number(args.limit) || 15));
  const params: string[] = ['countTotal=true', `pageSize=${pageSize}`, `filter.overallStatus=${encodeURIComponent(status)}`];
  if (condition) params.push(`query.cond=${encodeURIComponent(condition)}`);
  if (hasGeo) params.push(`filter.geo=${encodeURIComponent(`distance(${lat},${lon},${radius}mi)`)}`);
  else params.push(`query.locn=${encodeURIComponent(location)}`);
  const res = await pwFetch(`${BASE}?${params.join('&')}`);
  if (!res.ok) await ctError(res);
  const data = (await res.json()) as StudiesResponse;
  return {
    location: hasGeo ? `${lat},${lon} within ${radius}mi` : location,
    condition: condition || null,
    status,
    total_count: data.totalCount ?? 0,
    studies: (data.studies ?? []).map(formatStudy),
  };
}

const CT_CATALYST_FIELDS = {
  primary_completion: 'PrimaryCompletionDate',
  study_completion: 'CompletionDate',
} as const;

/**
 * Sponsor-name recovery.
 *
 * The sponsor filter matches the REGISTERED sponsor name, and registered names
 * are rarely what anyone types. ClinicalTrials.gov files Moderna as
 * "ModernaTX, Inc.", so a bare "Moderna" can come back near-empty and the
 * caller gets a well-formed, confident, completely wrong pipeline. A wrong
 * count reads as a business fact, which makes this worse than an error.
 *
 * Free-text search does find them (`query.term=Moderna` → 237), so on a suspiciously
 * low sponsor yield we probe that, tally lead-sponsor names, and hand back the
 * registered spellings that actually contain the caller's term. One extra request,
 * only on the path that was already about to mislead.
 */
const SPONSOR_LOW_YIELD = 5;

function normalizeSponsorToken(s: string): string {
  // Drop corporate suffixes and punctuation so "Moderna" matches "ModernaTX, Inc."
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
    .replace(/(incorporated|inc|llc|ltd|limited|corp|corporation|plc|gmbh|ag|sa|nv|co)$/,'');
}

async function suggestSponsorNames(sponsor: string): Promise<Array<{ registered_name: string; studies_in_sample: number }>> {
  const probe = [
    `query.term=${encodeURIComponent(sponsor)}`,
    'pageSize=200',
    'fields=protocolSection.sponsorCollaboratorsModule.leadSponsor.name',
  ];
  const res = await pwFetch(`${BASE}?${probe.join('&')}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const data = await boundedJson(res, 'ClinicalTrials.gov sponsor probe', 8_000_000) as StudiesResponse;

  const want = normalizeSponsorToken(sponsor);
  if (!want) return [];
  const tally = new Map<string, number>();
  for (const s of data.studies ?? []) {
    const name = s.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name;
    if (!name) continue;
    const norm = normalizeSponsorToken(name);
    // Substring either way: "moderna" ⊂ "modernatx", and a typed long form still
    // matches a shorter registered one.
    if (!norm.includes(want) && !want.includes(norm)) continue;
    if (norm === want) continue; // already what they asked for — not a suggestion
    tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([registered_name, studies_in_sample]) => ({ registered_name, studies_in_sample }));
}

/**
 * Attach a recovery hint to any sponsor-keyed result whose count is implausibly
 * low. Returns the fields to spread into the response, or {} when the result
 * looks healthy. Never throws — a failed probe must not break a working query.
 */
async function sponsorYieldWarning(
  sponsor: string | null | undefined,
  total: number,
  match: SponsorMatch = 'lead',
): Promise<Record<string, unknown>> {
  if (!sponsor || total >= SPONSOR_LOW_YIELD) return {};
  let suggestions: Array<{ registered_name: string; studies_in_sample: number }> = [];
  try {
    // A low count in THIS query may just mean narrow filters — a two-month window
    // or a single phase legitimately returns few rows for a correctly-named
    // sponsor. Check the sponsor's unfiltered total before blaming the name,
    // otherwise ct_sponsor_activity would cry wolf on every narrow window.
    const res = await pwFetch(
      `${BASE}?${advancedParam([sponsorClause(sponsor, match)]).join('&')}&countTotal=true&pageSize=1&fields=NCTId`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return {};
    const unfiltered = await boundedJson(res, 'ClinicalTrials.gov sponsor count', 1_000_000) as StudiesResponse;
    if ((unfiltered.totalCount ?? 0) >= SPONSOR_LOW_YIELD) return {}; // name is fine; the filters were narrow
    suggestions = await suggestSponsorNames(sponsor);
  } catch {
    return {};
  }
  if (suggestions.length === 0) return {};
  return {
    sponsor_name_warning:
      `Only ${total} match${total === 1 ? '' : 'es'} for sponsor "${sponsor}". ClinicalTrials.gov matches the REGISTERED sponsor name, which is often not the common name, so this count is probably not the sponsor's real activity. Re-run with one of did_you_mean before treating this as their pipeline.${match === 'lead' ? ` This counts trials "${sponsor}" LEADS; pass sponsor_match: "lead_or_collaborator" to also count trials it only partners on.` : ''}`,
    did_you_mean: suggestions,
  };
}

async function boundedStudies(params: string[]): Promise<StudiesResponse> {
  const res = await pwFetch(`${BASE}?${params.join('&')}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) await ctError(res);
  return await boundedJson(res, 'ClinicalTrials.gov studies response', 8_000_000) as StudiesResponse;
}

async function boundedStudy(nctId: string): Promise<Study> {
  const id = normalizeNctId(nctId);
  const res = await pwFetch(`${BASE}/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new Error(`not_found: ClinicalTrials.gov has no study ${id} — that NCT id is not registered (or was withdrawn/never assigned). Search by condition/intervention with ct_search instead of guessing an id.`);
  if (!res.ok) await ctError(res);
  return await boundedJson(res, 'ClinicalTrials.gov study response', 8_000_000) as Study;
}

async function boundedJson(res: Response, label: string, maxBytes: number): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`${label} exceeded size limit`);
  const text = await res.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error(`${label} exceeded size limit`);
  return JSON.parse(text);
}

async function ctCatalystCalendar(args: Record<string, unknown>) {
  const from = dateArg(args.from_date, 'from_date'), to = dateArg(args.to_date, 'to_date');
  if (from > to) throw new Error('from_date must not be after to_date');
  const eventType = String(args.event_type ?? 'primary_completion') as keyof typeof CT_CATALYST_FIELDS;
  if (!(eventType in CT_CATALYST_FIELDS)) throw new Error('event_type must be primary_completion or study_completion');
  const field = CT_CATALYST_FIELDS[eventType];
  const limit = intArg(args.limit, 50, 1, 100);
  const phase = stringArg(args.phase);
  const sponsorMatch = sponsorMatchArg(args.sponsor_match);
  const sponsorName = stringArg(args.sponsor);
  const advanced = [`AREA[${field}]RANGE[${from},${to}]`];
  if (sponsorName) advanced.push(sponsorClause(sponsorName, sponsorMatch));
  if (phase) advanced.push(phaseClause(normalizePhase(phase)));
  const params = [`countTotal=true`, `pageSize=${limit}`, `sort=${field}:asc`,
    ...advancedParam(advanced)];
  const query = stringArg(args.query), sponsor = stringArg(args.sponsor);
  if (query) params.push(`query.term=${encodeURIComponent(query)}`);
  const status = stringArg(args.status);
  if (status) params.push(`filter.overallStatus=${encodeURIComponent(normalizeStatus(status))}`);
  const data = await boundedStudies(params);
  const studies = (data.studies ?? []).map((study) => {
    const status = study.protocolSection?.statusModule;
    const event = eventType === 'primary_completion' ? status?.primaryCompletionDateStruct : status?.completionDateStruct;
    return { ...formatStudy(study), event_date: event?.date ?? null, event_date_type: event?.type ?? null,
      last_update_post_date: status?.lastUpdatePostDateStruct?.date ?? null };
  });
  return {
    event_type: eventType, window: { from, to },
    sponsor: sponsorName ?? null, sponsor_match: sponsorName ? sponsorMatch : null,
    total_count: data.totalCount ?? 0, returned: studies.length,
    studies: withSponsorMatch(studies, sponsorName),
    interpretation: 'Completion dates are sponsor- or investigator-entered registry fields and may be estimated, delayed, or revised. They are planning signals, not guaranteed data readouts, conference presentations, regulatory decisions, or material events.',
  };
}

async function ctSponsorPipeline(args: Record<string, unknown>) {
  const sponsor = requiredArg(args, 'sponsor');
  const sponsorMatch = sponsorMatchArg(args.sponsor_match);
  const size = intArg(args.sample_size, 100, 10, 100);
  const filters = buildFilters(stringArg(args.status) ?? undefined, stringArg(args.phase) ?? undefined);
  const params = ['countTotal=true', `pageSize=${size}`, 'sort=%40relevance', ...filters.params,
    ...advancedParam([sponsorClause(sponsor, sponsorMatch), ...filters.clauses])];
  const data = await boundedStudies(params);
  const studies = data.studies ?? [];
  return {
    sponsor, sponsor_match: sponsorMatch, total_count: data.totalCount ?? 0, sample_size: studies.length,
    ...(await sponsorYieldWarning(sponsor, data.totalCount ?? 0, sponsorMatch)),
    by_phase: frequency(studies.flatMap((s) => s.protocolSection?.designModule?.phases ?? ['NA'])),
    by_status: frequency(studies.map((s) => s.protocolSection?.statusModule?.overallStatus ?? 'UNKNOWN')),
    top_conditions: frequency(studies.flatMap((s) => s.protocolSection?.conditionsModule?.conditions ?? []), 20),
    top_interventions: frequency(studies.flatMap((s) => s.protocolSection?.armsInterventionsModule?.interventions?.map((i) => i.name).filter(isString) ?? []), 20),
    studies: withSponsorMatch(studies.map(formatStudy), sponsor),
    interpretation: 'Breakdowns describe the bounded relevance-ranked sample, while total_count describes all registry matches. Sponsor matching is a phrase match on the registered lead-sponsor name (or, under sponsor_match "lead_or_collaborator", the collaborator list too), so spelling variants of the same company can register separately; registration does not establish asset ownership, success probability, valuation, or commercial rights.',
  };
}

async function ctCompetitiveLandscape(args: Record<string, unknown>) {
  const condition = requiredArg(args, 'condition');
  const intervention = stringArg(args.intervention), size = intArg(args.sample_size, 100, 10, 100);
  const phase = stringArg(args.phase);
  const advanced = ['AREA[StudyType]INTERVENTIONAL'];
  if (phase) advanced.push(`AREA[Phase](${normalizePhase(phase).join(' OR ')})`);
  const params = [`query.cond=${encodeURIComponent(condition)}`, `filter.advanced=${encodeURIComponent(advanced.join(' AND '))}`,
    'countTotal=true', `pageSize=${size}`, 'sort=%40relevance'];
  if (intervention) params.push(`query.intr=${encodeURIComponent(intervention)}`);
  const status = stringArg(args.status);
  if (status) params.push(`filter.overallStatus=${encodeURIComponent(normalizeStatus(status))}`);
  const data = await boundedStudies(params);
  const studies = data.studies ?? [];
  return {
    condition, intervention: intervention ?? null, total_count: data.totalCount ?? 0, sample_size: studies.length,
    sponsors: frequency(studies.map((s) => s.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name ?? 'Unknown'), 25),
    phases: frequency(studies.flatMap((s) => s.protocolSection?.designModule?.phases ?? ['NA'])),
    statuses: frequency(studies.map((s) => s.protocolSection?.statusModule?.overallStatus ?? 'UNKNOWN')),
    interventions: frequency(studies.flatMap((s) => s.protocolSection?.armsInterventionsModule?.interventions?.map((i) => i.name).filter(isString) ?? []), 25),
    studies: studies.map(formatStudy),
    interpretation: 'Breakdowns describe a bounded relevance-ranked ClinicalTrials.gov sample. They are not market share, scientific differentiation, probability of success, or an exhaustive view of private/unregistered development.',
  };
}

async function ctEnrollmentWatch(args: Record<string, unknown>) {
  const query = stringArg(args.query), sponsor = stringArg(args.sponsor);
  if (!query && !sponsor) throw new Error('Provide query or sponsor');
  const sponsorMatch = sponsorMatchArg(args.sponsor_match);
  const limit = intArg(args.limit, 50, 1, 100);
  const params = ['countTotal=true', `pageSize=${limit}`,
    `filter.overallStatus=${encodeURIComponent('RECRUITING,NOT_YET_RECRUITING,ACTIVE_NOT_RECRUITING,ENROLLING_BY_INVITATION')}`];
  if (query) params.push(`query.term=${encodeURIComponent(query)}`);
  const advanced: string[] = [];
  if (sponsor) advanced.push(sponsorClause(sponsor, sponsorMatch));
  if (args.phase) advanced.push(phaseClause(normalizePhase(String(args.phase))));
  params.push(...advancedParam(advanced));
  const data = await boundedStudies(params);
  const today = new Date();
  const staleBefore = new Date(today.getTime() - 180 * 86_400_000).toISOString().slice(0, 10);
  const studies = (data.studies ?? []).map((study) => {
    const status = study.protocolSection?.statusModule;
    const design = study.protocolSection?.designModule;
    const locations = study.protocolSection?.contactsLocationsModule?.locations ?? [];
    const lastUpdate = status?.lastUpdatePostDateStruct?.date ?? null;
    const hints = [
      design?.enrollmentInfo?.type === 'ESTIMATED' ? 'estimated_enrollment' : null,
      lastUpdate && lastUpdate < staleBefore ? 'registry_not_updated_in_180_days' : null,
      locations.length === 0 ? 'no_locations_listed' : null,
      status?.overallStatus === 'NOT_YET_RECRUITING' ? 'not_yet_recruiting' : null,
    ].filter(isString);
    return { ...formatStudy(study), site_count: locations.length, last_update_post_date: lastUpdate,
      primary_completion_date_type: status?.primaryCompletionDateStruct?.type ?? null, review_hints: hints };
  });
  return {
    sponsor: sponsor ?? null, sponsor_match: sponsor ? sponsorMatch : null,
    total_count: data.totalCount ?? 0, returned: studies.length,
    studies: withSponsorMatch(studies, sponsor),
    ...(await sponsorYieldWarning(sponsor, data.totalCount ?? 0, sponsorMatch)),
    interpretation: 'review_hints are mechanical routing cues based only on registry fields. They do not predict enrollment performance, trial failure, data quality, completion timing, or materiality.',
  };
}

async function ctResultsSummary(args: Record<string, unknown>) {
  const study = await boundedStudy(requiredArg(args, 'nct_id'));
  const limit = intArg(args.max_outcomes, 20, 1, 50);
  const protocol = study.protocolSection;
  const reported = study.resultsSection?.outcomeMeasuresModule?.outcomeMeasures ?? [];
  const adverse = study.resultsSection?.adverseEventsModule;
  return {
    study: formatStudy(study), has_results: study.hasResults === true,
    registered_primary_outcomes: protocol?.outcomesModule?.primaryOutcomes ?? [],
    registered_secondary_outcomes: protocol?.outcomesModule?.secondaryOutcomes ?? [],
    reported_outcomes_total: reported.length,
    reported_outcomes: reported.slice(0, limit).map(projectResultOutcome),
    adverse_events: adverse ? {
      frequency_threshold: adverse.frequencyThreshold ?? null, time_frame: adverse.timeFrame ?? null,
      description: adverse.description ?? null, groups: adverse.eventGroups ?? [],
    } : null,
    interpretation: 'This projects sponsor-submitted registry results. It is not an FDA conclusion, peer review, a complete clinical interpretation, or investment advice. Review the protocol, analysis populations, missing data, amendments, publications, and regulatory materials.',
  };
}

async function ctSponsorActivity(args: Record<string, unknown>) {
  const sponsor = requiredArg(args, 'sponsor'), since = dateArg(args.since, 'since');
  const until = args.until == null ? 'MAX' : dateArg(args.until, 'until');
  if (until !== 'MAX' && since > until) throw new Error('since must not be after until');
  const rawType = String(args.date_type ?? 'last_update') as CtDateType;
  if (!(rawType in CT_DATE_FIELDS)) throw new Error('date_type must be last_update, first_posted, or results_posted');
  const field = CT_DATE_FIELDS[rawType], limit = intArg(args.limit, 50, 1, 100);
  const sponsorMatch = sponsorMatchArg(args.sponsor_match);
  const data = await boundedStudies(['countTotal=true', `pageSize=${limit}`, `sort=${field}:desc`,
    ...advancedParam([sponsorClause(sponsor, sponsorMatch), `AREA[${field}]RANGE[${since},${until}]`])]);
  const studies = (data.studies ?? []).map((study) => {
    const status = study.protocolSection?.statusModule;
    return { ...formatStudy(study), first_posted_date: status?.studyFirstPostDateStruct?.date ?? null,
      last_update_post_date: status?.lastUpdatePostDateStruct?.date ?? null,
      results_first_post_date: status?.resultsFirstPostDateStruct?.date ?? null };
  });
  return { sponsor, sponsor_match: sponsorMatch, date_type: rawType, window: { since, until: until === 'MAX' ? null : until },
    total_count: data.totalCount ?? 0, returned: studies.length,
    studies: withSponsorMatch(studies, sponsor),
    ...(await sponsorYieldWarning(sponsor, data.totalCount ?? 0, sponsorMatch)),
    interpretation: 'Registry posting or update activity is not necessarily a corporate disclosure, trial readout, regulatory milestone, or material event. Inspect the changed record and company disclosures before drawing conclusions.' };
}

/* ── ct_phase_transition_rates ─────────────────────────────────────────
 *
 * The registry-derived analog of a PTRS benchmark. Evaluate Omnium and
 * BioMedTracker build these from curated, per-ASSET development programmes;
 * ClinicalTrials.gov only knows about TRIALS, so the whole method here is
 * "reconstruct the asset from the intervention strings". Everything fragile
 * lives in that reconstruction, so it is written out rather than buried.
 *
 * Normalisation traps, both measured on the live NSCLC set (3,042 trials):
 *
 *  - STRIPPING BARE DIGITS DESTROYS CODE NAMES. A first pass removed every
 *    number, which turned PF-06463922, PF-06439535 and 76 other Pfizer
 *    compounds into one key "pf-", and 5-fluorouracil into "-fluorouracil".
 *    That does not merely lose data: it mints a fake super-asset that appears
 *    in every phase and therefore transitions with certainty, inflating the
 *    numerator. Only digits NOT fused to letters or hyphens are dropped.
 *  - THE SAME ASSET IS FILED UNDER CODE AND GENERIC NAME. `otherNames` carries
 *    lorlatinib ↔ PF-06463922, pemetrexed ↔ LY231514 (1,198 of the NSCLC
 *    interventions carry one). Left unmerged, an asset's Phase 2 sits under one
 *    key and its Phase 3 under another, and it reads as two assets that both
 *    failed. Aliases are merged into the primary name — but see below, because
 *    merging them naively is far more destructive than not merging at all.
 *  - `otherNames` IS NOT RELIABLY A SYNONYM LIST. Sponsors also use it to name
 *    the OTHER DRUGS IN THE REGIMEN. Measured: "AK112 Injection" carries
 *    otherNames ["Pemetrexed", "Carboplatin"] — co-administered agents, not
 *    synonyms — and "Standard of care neoadjuvant therapy" lists six separate
 *    chemotherapies. Trusting those merged all 306 pemetrexed trials into a key
 *    called "ak112", which then reported 76 Phase 2 trials under Eli Lilly for
 *    an Akeso antibody. Nothing errored; the rate stayed plausible and the audit
 *    list was quietly false. Two guards, both required: an alias is refused if
 *    that name ALSO appears as a primary intervention name on any other trial
 *    (pemetrexed is a primary on 306, so it can never be absorbed), and an arm
 *    listing more than two otherNames is treated as a regimen list and ignored.
 *    The guards err toward SPLITTING an asset in two, which understates the
 *    rate, rather than fusing two assets, which corrupts it.
 *
 * Comparator agents (placebo, saline, standard of care) are excluded outright:
 * they appear in every phase of every programme and would transition 100% of
 * the time. Ubiquitous chemotherapy BACKBONES (carboplatin, cisplatin) are NOT
 * excluded — they are genuine registered interventions and there is no
 * registry field that marks an arm as background therapy — so they inflate the
 * rate upward. That is disclosed in the response rather than silently patched.
 */

const PTRS_PHASE_RANK: Record<string, 1 | 2 | 3 | 4> = {
  EARLY_PHASE1: 1, PHASE1: 1, PHASE2: 2, PHASE3: 3, PHASE4: 4,
};
// Only asset-shaped intervention types. A PROCEDURE, DEVICE, BEHAVIORAL or
// DIETARY_SUPPLEMENT arm does not have a drug-development phase path, and
// counting them answers a different question than the one asked.
const PTRS_KEEP_TYPES = new Set(['DRUG', 'BIOLOGICAL', 'COMBINATION_PRODUCT', 'GENETIC']);

const PTRS_DOSE = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|ug|µg|g|kg|ml|l|iu|u|%)(?:\s*\/\s*(?:kg|m2|ml|day|d|hr|h))?\b/gi;
const PTRS_FORM = /\b(?:oral|orally|iv|intravenous(?:ly)?|subcutaneous(?:ly)?|intramuscular(?:ly)?|topical|inhaled|inhalation|injections?|injectable|infusions?|products?|tablets?|capsules?|solution|suspension|powder|cream|gel|patch|syrup|spray|drops?|film[- ]coated|coated|extended[- ]release|sustained[- ]release|immediate[- ]release|prefilled|syringe|vial|lyophilized|sterile)\b/gi;
const PTRS_FILLER = /\b(?:arm|group|cohort|dose|doses|dosing|escalation|expansion|level|part|cycle|treatment|therapy|regimen|monotherapy|single[- ]agent|active|experimental|comparator|control|standard|of|care|the|a|an|for|in|to|as|qd|bid|tid|q\dw)\b/gi;
const PTRS_COMBO_SPLIT = /\s*(?:\+|\/|,|\band\b|\bplus\b|\bwith\b)\s*/i;

const PTRS_NON_ASSET = new Set([
  'placebo', 'saline', 'normal saline', 'normal saline solution', 'vehicle', 'observation',
  'control', 'no intervention', 'standard of care', 'best supportive care', 'supportive care',
  'chemotherapy', 'radiotherapy', 'radiation', 'surgery', 'sham', 'water', 'dextrose',
  'blood draw', 'questionnaire', 'physician choice', 'investigator choice', 'investigators choice',
  'matching placebo', 'placebo comparator', 'none', 'usual care', 'conventional therapy',
  'active comparator', 'dietary supplement', 'saline solution', 'sugar pill',
  'neoadjuvant', 'adjuvant', 'doublet', 'platinum doublet', 'chemo', 'soc',
  'maintenance', 'induction', 'consolidation', 'radiation therapy',
]);
// Substring bans. No real asset name contains "chemotherapy" — but plenty of
// descriptive arm labels do ("platinum doublet chemotherapy", "1st line
// chemotherapy"), and each one would otherwise become a phantom asset that
// appears in every phase and transitions with certainty.
const PTRS_NON_ASSET_SUBSTR = [
  'placebo', 'saline', 'standard of care', 'best supportive care', 'sham ',
  'chemotherapy', 'supportive care', 'radiotherapy',
];

function ptrsClean(text: string): string {
  let n = text.toLowerCase().trim();
  n = n.replace(/\(.*?\)/g, ' ');           // parenthetical dose/brand asides
  n = n.replace(/[;:]+/g, ' ');
  n = n.replace(PTRS_DOSE, ' ');
  n = n.replace(PTRS_FORM, ' ');
  n = n.replace(PTRS_FILLER, ' ');
  // Standalone bare numbers only. A digit fused to a letter or hyphen is part
  // of a compound code (PF-06463922, AZD9291, 5-fluorouracil) and must survive.
  n = n.replace(/(?<![a-z0-9-])\d+(?:\.\d+)?(?![a-z0-9-])/g, ' ');
  n = n.replace(/[^a-z0-9\- ]+/g, ' ');
  n = n.replace(/\s*-\s*/g, '-').replace(/^-+|-+$/g, '');
  return n.replace(/\s+/g, ' ').trim();
}

/** One intervention string → the normalized asset names it names. Combination
 * arms ("pembrolizumab + carboplatin") yield one entry PER COMPONENT, so an
 * asset advanced as part of a doublet still counts; the response says so. */
function ptrsComponents(name: string): string[] {
  const raw = name.replace(/\bin combination with\b|\bcombined with\b/gi, ' and ');
  const out: string[] = [];
  for (const part of raw.split(PTRS_COMBO_SPLIT)) {
    const n = ptrsClean(part);
    if (!n || n.length < 3) continue;
    if (PTRS_NON_ASSET.has(n)) continue;
    if (PTRS_NON_ASSET_SUBSTR.some((s) => n.includes(s))) continue;
    // >4 words is descriptive arm prose ("abtl0812 in combination with
    // paclitaxel and carboplatin" survives the split; "1st line chemotherapy
    // per investigator discretion" does not), not an asset name.
    if (n.split(' ').length > 4) continue;
    out.push(n);
  }
  return [...new Set(out)];
}

/** YYYY | YYYY-MM | YYYY-MM-DD → comparable fractional year. The registry
 * publishes all three widths and a month-precision date must still be orderable
 * against a day-precision one. */
function ptrsYearOrd(date?: string | null): number | null {
  if (!date) return null;
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(date);
  if (!m) return null;
  return Number(m[1]) + (Number(m[2] ?? '6') - 1) / 12;
}

/**
 * BIO / Informa Pharma Intelligence / QLS Advisors,
 * "Clinical Development Success Rates and Contributing Factors 2011-2020"
 * (February 2021), Figure 2 — phase transition success rates by disease area,
 * from Biomedtracker® and Pharmapremia®. Transcribed verbatim from the
 * published report; `n` is the report's advanced-or-suspended count.
 */
const BIO_2011_2020: Record<string, { p1_to_p2: number; n1: number; p2_to_p3: number; n2: number }> = {
  Hematology: { p1_to_p2: 69.6, n1: 92, p2_to_p3: 48.1, n2: 106 },
  Metabolic: { p1_to_p2: 61.8, n1: 136, p2_to_p3: 45.0, n2: 149 },
  'Infectious disease': { p1_to_p2: 57.8, n1: 403, p2_to_p3: 38.4, n2: 414 },
  Ophthalmology: { p1_to_p2: 71.6, n1: 88, p2_to_p3: 35.5, n2: 200 },
  Gastroenterology: { p1_to_p2: 46.7, n1: 45, p2_to_p3: 34.2, n2: 73 },
  Autoimmune: { p1_to_p2: 55.2, n1: 413, p2_to_p3: 31.4, n2: 471 },
  Allergy: { p1_to_p2: 56.4, n1: 55, p2_to_p3: 28.3, n2: 92 },
  Psychiatry: { p1_to_p2: 52.7, n1: 150, p2_to_p3: 26.8, n2: 164 },
  Neurology: { p1_to_p2: 47.7, n1: 516, p2_to_p3: 26.8, n2: 504 },
  Endocrine: { p1_to_p2: 43.3, n1: 319, p2_to_p3: 26.6, n2: 293 },
  Oncology: { p1_to_p2: 48.8, n1: 1628, p2_to_p3: 24.6, n2: 1732 },
  Respiratory: { p1_to_p2: 55.9, n1: 179, p2_to_p3: 21.9, n2: 215 },
  Cardiovascular: { p1_to_p2: 50.0, n1: 214, p2_to_p3: 21.0, n2: 252 },
  Urology: { p1_to_p2: 40.9, n1: 22, p2_to_p3: 15.0, n2: 40 },
  'All indications': { p1_to_p2: 52.0, n1: 4414, p2_to_p3: 28.9, n2: 4933 },
};

// Longest/most specific patterns first — "lung cancer" must reach Oncology
// before "lung" could reach Respiratory.
const BIO_AREA_PATTERNS: [RegExp, string][] = [
  [/\b(cancer|carcinoma|tumou?r|neoplas|oncolog|sarcoma|melanoma|glioma|glioblastoma|myeloma|adenocarcinoma|mesothelioma|metasta)\b/i, 'Oncology'],
  [/\b(leukemia|leukaemia|lymphoma|anemia|anaemia|thalass|hemophil|haemophil|sickle cell|thrombocytopenia|myelodysplastic|neutropenia)\b/i, 'Hematology'],
  [/\b(alzheimer|parkinson|epilep|seizure|multiple sclerosis|migraine|neuropath|amyotrophic|als\b|huntington|dementia|stroke|spinal muscular|myasthenia|neurolog|narcolepsy)\b/i, 'Neurology'],
  [/\b(depress|schizophren|bipolar|anxiety|psychiatr|adhd|autism|ptsd|substance use|opioid use disorder|insomnia)\b/i, 'Psychiatry'],
  [/\b(diabet|obesity|obese|dyslipid|hyperlipid|hypercholesterol|metabolic syndrome|nash\b|nonalcoholic steatohepatitis|gout|phenylketonuria)\b/i, 'Metabolic'],
  [/\b(thyroid|acromegaly|cushing|growth hormone|osteoporosis|hypogonad|adrenal|endocrin|hyperparathyroid)\b/i, 'Endocrine'],
  [/\b(hiv|hepatitis|influenza|covid|sars-cov|tuberculosis|malaria|pneumonia|sepsis|infect|bacteri|viral|virus|vaccin|antibiotic|clostridi|rsv\b)\b/i, 'Infectious disease'],
  [/\b(rheumatoid|lupus|psoria|crohn|ulcerative colitis|inflammatory bowel|ankylosing|sjogren|scleroderma|vasculitis|autoimmun|atopic dermatitis|multiple sclerosis)\b/i, 'Autoimmune'],
  [/\b(heart failure|hypertension|atrial fibrillation|myocardial|coronary|cardiomyopathy|cardiovascular|angina|thrombosis|pulmonary arterial hypertension|cardiac)\b/i, 'Cardiovascular'],
  [/\b(asthma|copd|chronic obstructive|pulmonary fibrosis|cystic fibrosis|bronchi|respiratory|pulmonary)\b/i, 'Respiratory'],
  [/\b(macular|retinop|glaucoma|uveitis|dry eye|retinal|ophthalm|keratoconjunctivitis|cataract)\b/i, 'Ophthalmology'],
  [/\b(allerg|rhinitis|anaphylax|urticaria|food allergy)\b/i, 'Allergy'],
  [/\b(irritable bowel|gastro|gerd|celiac|coeliac|pancreatitis|constipation|dyspepsia|esophag|oesophag)\b/i, 'Gastroenterology'],
  [/\b(prostat|bladder|urinar|incontinen|erectile|overactive bladder|benign prostatic|renal|kidney|urolog)\b/i, 'Urology'],
];

function bioAreaFor(condition: string): string | null {
  for (const [re, area] of BIO_AREA_PATTERNS) if (re.test(condition)) return area;
  return null;
}

type PtrsTrial = {
  nct: string | null;
  status: string | null;
  sponsor: string | null;
  start: number | null;
  completion: number | null;
  title: string | null;
};

/** Pull every industry interventional trial for the condition, following
 * nextPageToken up to the page cap. The projection is deliberate: fetching
 * whole study records for 5,000 studies moves tens of MB to read six fields. */
async function ptrsFetchTrials(condition: string, industryOnly: boolean, maxPages: number) {
  const advanced = ['AREA[StudyType]INTERVENTIONAL'];
  if (industryOnly) advanced.push('AREA[LeadSponsorClass](INDUSTRY)');
  const fields = [
    'NCTId', 'BriefTitle', 'Phase', 'OverallStatus', 'StartDate', 'CompletionDate',
    'PrimaryCompletionDate', 'InterventionType', 'InterventionName', 'InterventionOtherName',
    'LeadSponsorName', 'LeadSponsorClass',
  ].join(',');

  const studies: Study[] = [];
  let token: string | null = null;
  let total = 0;
  let pages = 0;

  while (pages < maxPages) {
    const params = [
      `query.cond=${encodeURIComponent(condition)}`,
      `filter.advanced=${encodeURIComponent(advanced.join(' AND '))}`,
      'countTotal=true',
      'pageSize=1000',
      `fields=${encodeURIComponent(fields)}`,
    ];
    if (token) params.push(`pageToken=${encodeURIComponent(token)}`);
    const res = await pwFetch(`${BASE}?${params.join('&')}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) await ctError(res);
    const data = (await boundedJson(res, 'ClinicalTrials.gov transition page', 8_000_000)) as
      StudiesResponse & { nextPageToken?: string };
    if (pages === 0) total = data.totalCount ?? 0;
    studies.push(...(data.studies ?? []));
    pages += 1;
    token = data.nextPageToken ?? null;
    if (!token) break;
  }
  return { studies, total, pages, truncated: token !== null };
}

async function ctPhaseTransitionRates(args: Record<string, unknown>) {
  const condition = requiredArg(args, 'condition');
  const sponsorClassRaw = String(args.sponsor_class ?? 'industry').trim().toLowerCase();
  if (sponsorClassRaw !== 'industry' && sponsorClassRaw !== 'all') {
    throw new Error(`sponsor_class must be "industry" (default) or "all"; got ${JSON.stringify(args.sponsor_class)}`);
  }
  const industryOnly = sponsorClassRaw === 'industry';
  const toYear = intArg(args.to_year, new Date().getUTCFullYear(), 1990, 2100);
  const censorYears = intArg(args.censor_years, 3, 1, 15);
  const fromYear = args.from_year == null ? null : intArg(args.from_year, 0, 1900, 2100);
  const maxPages = intArg(args.max_pages, 5, 1, 5);

  const { studies, total, pages, truncated } = await ptrsFetchTrials(condition, industryOnly, maxPages);

  const memo = new Map<string, string[]>();
  const components = (name: string): string[] => {
    let hit = memo.get(name);
    if (!hit) { hit = ptrsComponents(name); memo.set(name, hit); }
    return hit;
  };

  // Pass 0 — how often each name is used as a PRIMARY intervention name. This
  // is the evidence the alias guard runs on: a name that stands on its own as
  // an intervention across the corpus is an asset, and must never be absorbed
  // into another asset by someone else's otherNames field.
  const primaryUse = new Map<string, number>();
  for (const s of studies) {
    for (const iv of s.protocolSection?.armsInterventionsModule?.interventions ?? []) {
      if (!PTRS_KEEP_TYPES.has(iv.type ?? '')) continue;
      for (const k of components(iv.name ?? '')) primaryUse.set(k, (primaryUse.get(k) ?? 0) + 1);
    }
  }

  // Pass 1 — alias map from otherNames, under both guards (see the header note).
  const aliasOf = new Map<string, string>();
  for (const s of studies) {
    for (const iv of s.protocolSection?.armsInterventionsModule?.interventions ?? []) {
      if (!PTRS_KEEP_TYPES.has(iv.type ?? '')) continue;
      const others = iv.otherNames ?? [];
      // Guard 2: >2 alternates is a regimen list, not a synonym list.
      if (!others.length || others.length > 2) continue;
      const primary = components(iv.name ?? '');
      // A combination arm's otherNames cannot be attributed to one component.
      if (primary.length !== 1) continue;
      for (const other of others) {
        for (const alt of components(other)) {
          if (alt === primary[0] || aliasOf.has(alt)) continue;
          // Guard 1: the alias must not be an asset in its own right.
          if ((primaryUse.get(alt) ?? 0) > 0) continue;
          aliasOf.set(alt, primary[0]);
        }
      }
    }
  }
  const resolve = (key: string): string => {
    let k = key;
    for (let i = 0; i < 5; i++) { const next = aliasOf.get(k); if (!next || next === k) break; k = next; }
    return k;
  };

  // Pass 2 — index trials under each asset, per phase.
  const index = new Map<string, Map<1 | 2 | 3 | 4, PtrsTrial[]>>();
  let trialsWithPhase = 0;
  for (const s of studies) {
    const p = s.protocolSection;
    const st = p?.statusModule;
    const phases = (p?.designModule?.phases ?? [])
      .map((x) => PTRS_PHASE_RANK[x]).filter((x): x is 1 | 2 | 3 | 4 => !!x);
    if (!phases.length) continue;
    trialsWithPhase += 1;
    const trial: PtrsTrial = {
      nct: p?.identificationModule?.nctId ?? null,
      status: st?.overallStatus ?? null,
      sponsor: p?.sponsorCollaboratorsModule?.leadSponsor?.name ?? null,
      start: ptrsYearOrd(st?.startDateStruct?.date),
      // Fall back to primary completion: a trial can report one without the
      // other, and dropping those loses real completions.
      completion: ptrsYearOrd(st?.completionDateStruct?.date)
        ?? ptrsYearOrd(st?.primaryCompletionDateStruct?.date),
      title: p?.identificationModule?.briefTitle ?? null,
    };
    const seen = new Set<string>();
    for (const iv of p?.armsInterventionsModule?.interventions ?? []) {
      if (!PTRS_KEEP_TYPES.has(iv.type ?? '')) continue;
      for (const raw of components(iv.name ?? '')) {
        const key = resolve(raw);
        if (seen.has(key)) continue;
        seen.add(key);
        let byPhase = index.get(key);
        if (!byPhase) { byPhase = new Map(); index.set(key, byPhase); }
        for (const ph of phases) {
          const list = byPhase.get(ph) ?? [];
          list.push(trial);
          byPhase.set(ph, list);
        }
      }
    }
  }

  const cutoff = toYear - censorYears;

  type Row = {
    intervention: string; transitioned: boolean;
    earlier_completion_year: number; earlier_phase_trials: number;
    later_phase_trials: number; example_earlier_nct: string | null;
    example_later_nct: string | null; sponsor: string | null;
  };

  const measure = (from: 1 | 2, to: 2 | 3) => {
    const rows: Row[] = [];
    for (const [key, byPhase] of index) {
      const completed = (byPhase.get(from) ?? []).filter(
        (t) => t.status === 'COMPLETED' && t.completion != null && t.completion <= cutoff
          && (fromYear == null || t.completion >= fromYear),
      );
      if (!completed.length) continue;
      // Earliest qualifying completion is the clock start: an asset gets credit
      // for advancing after its FIRST completed earlier-phase trial, not its
      // last, which would censor away real transitions.
      let earliest = completed[0];
      for (const t of completed) if ((t.completion ?? 0) < (earliest.completion ?? 0)) earliest = t;
      const later = (byPhase.get(to) ?? []).filter((t) => t.start != null && t.start > (earliest.completion ?? 0));
      rows.push({
        intervention: key,
        transitioned: later.length > 0,
        earlier_completion_year: Math.floor(earliest.completion ?? 0),
        earlier_phase_trials: completed.length,
        later_phase_trials: later.length,
        example_earlier_nct: earliest.nct,
        example_later_nct: later[0]?.nct ?? null,
        sponsor: earliest.sponsor,
      });
    }
    const denominator = rows.length;
    const numerator = rows.filter((r) => r.transitioned).length;
    const label = `phase${from}_to_phase${to}`;
    // Fewer than 10 eligible assets is not a rate, it is an anecdote. Say so
    // explicitly rather than returning 1/3 = 33% as though it meant something.
    if (denominator < 10) {
      return {
        status: 'insufficient_data' as const,
        label,
        numerator, denominator, rate: null,
        reason: `Only ${denominator} intervention${denominator === 1 ? '' : 's'} for "${condition}" have a completed Phase ${from} trial old enough to enter the denominator (minimum 10). A rate over this few assets is noise, so none is reported.`,
        hint: denominator === 0
          ? 'Try a broader condition term, sponsor_class: "all", or a smaller censor_years.'
          : 'Lower censor_years to admit more recent completions, or pass sponsor_class: "all" to include academic sponsors.',
        rows,
      };
    }
    return {
      status: 'ok' as const,
      label,
      numerator, denominator,
      rate: Number((numerator / denominator).toFixed(4)),
      rate_pct: Number(((numerator / denominator) * 100).toFixed(1)),
      rows,
    };
  };

  const p12 = measure(1, 2);
  const p23 = measure(2, 3);

  const area = bioAreaFor(condition);
  const bench = BIO_2011_2020[area ?? 'All indications'];
  const benchLabel = area ?? 'All indications';
  const compare = (obs: { status: string; rate?: number | null }, published: number) => {
    if (obs.status !== 'ok' || obs.rate == null) return null;
    const observed = obs.rate * 100;
    const diff = observed - published;
    return `Registry-derived ${observed.toFixed(1)}% vs published ${published.toFixed(1)}% for ${benchLabel} — ${Math.abs(diff).toFixed(1)} points ${diff < 0 ? 'lower' : 'higher'}. The registry number is expected to run LOWER: it requires a later-phase trial to be REGISTERED, and an asset can advance in a company's pipeline without a public registration, while BIO scores an analyst-curated advance-or-suspend decision per programme.`;
  };

  // Audit list: the assets carrying the Phase 2→3 number, transitions first,
  // then by how much evidence sits behind them. Without this the rate is a
  // number nobody can check.
  const top = [...p23.rows]
    .sort((a, b) =>
      Number(b.transitioned) - Number(a.transitioned)
      || (b.earlier_phase_trials + b.later_phase_trials) - (a.earlier_phase_trials + a.later_phase_trials)
      || a.intervention.localeCompare(b.intervention))
    .slice(0, 20)
    .map((r) => ({
      intervention: r.intervention,
      lead_sponsor: r.sponsor,
      phase_path: r.transitioned
        ? `Phase 2 completed ${r.earlier_completion_year} → Phase 3 started after`
        : `Phase 2 completed ${r.earlier_completion_year} → no later Phase 3 registered`,
      transitioned_phase2_to_phase3: r.transitioned,
      phase2_trials: r.earlier_phase_trials,
      phase3_trials_after_completion: r.later_phase_trials,
      example_phase2_nct: r.example_earlier_nct,
      example_phase3_nct: r.example_later_nct,
    }));

  const strip = <T extends { rows: Row[] }>(o: T) => { const { rows, ...rest } = o; return rest; };

  return {
    condition,
    sponsor_class: sponsorClassRaw,
    trials_matching: total,
    trials_analyzed: studies.length,
    trials_with_a_phase_label: trialsWithPhase,
    interventions_indexed: index.size,
    pages_fetched: pages,
    truncated,
    truncation_note: truncated
      ? `Upstream returned more than ${maxPages * 1000} trials and the page cap stopped the pull, so these rates are computed over the first ${studies.length} of ${total} matching trials and are NOT the full match set. Narrow the condition term for a complete answer.`
      : `Complete: all ${total} matching trials were analyzed (no page cap hit).`,
    censoring: {
      to_year: toYear,
      censor_years: censorYears,
      from_year: fromYear,
      rule: `An intervention enters the denominator only if it has a COMPLETED earlier-phase trial finishing on or before ${cutoff} (that is, at least ${censorYears} years before to_year ${toYear})${fromYear ? `, and no earlier than ${fromYear}` : ''}. Assets whose earlier-phase trial finished after ${cutoff} are censored OUT — they have not had time to advance, and counting them as failures would understate the rate.`,
    },
    transitions: { phase1_to_phase2: strip(p12), phase2_to_phase3: strip(p23) },
    benchmark: {
      therapeutic_area: benchLabel,
      matched_from_condition: area != null,
      source: 'BIO, Informa Pharma Intelligence & QLS Advisors, "Clinical Development Success Rates and Contributing Factors 2011-2020" (February 2021), Figure 2 — from Biomedtracker and Pharmapremia.',
      published_phase1_to_phase2_pct: bench.p1_to_p2,
      published_phase2_to_phase3_pct: bench.p2_to_p3,
      published_n_phase2: bench.n2,
      phase1_to_phase2_comparison: compare(p12, bench.p1_to_p2),
      phase2_to_phase3_comparison: compare(p23, bench.p2_to_p3),
      note: area == null
        ? `No therapeutic area matched "${condition}", so the all-indications row is used. Treat the comparison as a rough anchor.`
        : `"${condition}" was mapped to the ${area} row by keyword. BIO's own areas are broad — every solid tumour and haematological malignancy shares one Oncology row — so the published figure is an area average, not this indication's.`,
    },
    top_interventions: top,
    methodology: `Industry-sponsored interventional trials for "${condition}" are pulled from ClinicalTrials.gov and grouped by normalized intervention name: lowercased, with dose, formulation and route tokens and parenthetical asides removed, and code names preserved intact (PF-06463922 stays distinct from PF-06439535). Names in interventions[].otherNames are merged into the primary name, so lorlatinib and PF-06463922 count as one asset. Combination arms are SPLIT and counted under each component, so an asset that advanced inside a doublet still counts. Only DRUG, BIOLOGICAL, COMBINATION_PRODUCT and GENETIC interventions are counted; placebo, saline, standard-of-care and other non-asset comparator arms are excluded. An intervention "transitioned" from phase N to N+1 if it has a COMPLETED phase-N trial for this condition and any phase-N+1 trial for the same condition whose START date falls after that completion. Trials labelled with two phases (e.g. PHASE2/PHASE3) count in both.`,
    limitations: [
      'This counts TRIAL EXISTENCE in a public registry, not efficacy, readouts, or approvals. An asset that entered Phase 3 and failed still counts as a transition, so this is an UPPER BOUND on technical success, not a probability of approval.',
      'Registry records are the unit, not development programmes. ClinicalTrials.gov has no asset identifier, so assets are reconstructed from free-text intervention names; a company filing the same drug under inconsistent spellings will read as several assets that each failed.',
      'Ubiquitous chemotherapy backbones (carboplatin, cisplatin, paclitaxel) are genuine registered interventions with no registry field marking them as background therapy. They appear across every phase and transition almost always, which biases the rate UPWARD.',
      'Not every advance is registered, and non-US development may never appear here at all. Suspended or quietly discontinued programmes look identical to ones still waiting.',
      'The BIO comparison is a different measurement: analyst-curated advance-or-suspend decisions per programme over 2011-2020, at broad therapeutic-area granularity. It anchors the order of magnitude; it is not the same quantity.',
    ],
    source: 'ClinicalTrials.gov API v2',
  };
}

function projectResultOutcome(outcome: ResultOutcome) {
  const measurements = (outcome.classes ?? []).flatMap((cls) => (cls.categories ?? []).flatMap((category) =>
    (category.measurements ?? []).map((measurement) => ({ class: cls.title ?? null, category: category.title ?? null, ...measurement }))));
  return { title: outcome.title ?? null, type: outcome.type ?? null, reporting_status: outcome.reportingStatus ?? null,
    time_frame: outcome.timeFrame ?? null, description: outcome.description ?? null, parameter: outcome.paramType ?? null,
    dispersion: outcome.dispersionType ?? null, unit: outcome.unitOfMeasure ?? null, groups: outcome.groups ?? [],
    analyses: outcome.analyses ?? [], measurements: measurements.slice(0, 100), measurements_truncated: measurements.length > 100 };
}

function frequency(values: string[], limit = 50) {
  const counts = new Map<string, number>();
  for (const raw of values) { const value = raw.trim(); if (value) counts.set(value, (counts.get(value) ?? 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}
function isString(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function stringArg(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function requiredArg(args: Record<string, unknown>, key: string) { const value = stringArg(args[key]); if (!value) throw new Error(`${key} is required`); return value; }
function intArg(value: unknown, fallback: number, min: number, max: number) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback; }
function dateArg(value: unknown, key: string) { const date = stringArg(value); if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${key} must use YYYY-MM-DD`); return date; }
function normalizeNctId(value: string) { const id = value.trim().toUpperCase(); if (!/^NCT\d{8}$/.test(id)) throw new Error('nct_id must use NCT followed by 8 digits'); return id; }

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ct_search':
      return ctSearch(
        args.query as string,
        args.status as string | undefined,
        args.phase as string | undefined,
        args.sponsor as string | undefined,
        args.limit as number | undefined,
        args.sponsor_match,
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
        args.sponsor_match,
      );
    case 'ct_compare_sponsors':
      return ctCompareSponsors(args);
    case 'ct_trials_by_location':
      return ctTrialsByLocation(args);
    case 'ct_recent_updates':
      return ctRecentUpdates(args);
    case 'ct_catalyst_calendar':
      return ctCatalystCalendar(args);
    case 'ct_sponsor_pipeline':
      return ctSponsorPipeline(args);
    case 'ct_competitive_landscape':
      return ctCompetitiveLandscape(args);
    case 'ct_enrollment_watch':
      return ctEnrollmentWatch(args);
    case 'ct_results_summary':
      return ctResultsSummary(args);
    case 'ct_sponsor_activity':
      return ctSponsorActivity(args);
    case 'ct_phase_transition_rates':
      return ctPhaseTransitionRates(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
