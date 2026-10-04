// Reconciliation: the Frontend catching up with WordPress when a change's own
// event never arrived (a hook that didn't fire, an event lost before the CMS
// recorded it, a change made outside the editor). The CMS's scheduler, the
// server cron that also retries its events (ADR 0008), sends a signed
// "reconcile" event every minute (events.ts); each run compares the
// publication store with what WordPress publishes and refreshes what differs
// (ADR 0009):
//
// - the shared rows (front page with the site's title and tagline, chrome,
//   design presets) are read and compared with what is stored, so a change to
//   any shared setting is caught whatever saved it;
// - WordPress's list of published pages and posts (id, URI, modification
//   time) is compared with the stored entries: a new entry, one whose URI or
//   modification time differs, one stored but no longer listed, and one
//   withdrawn but published again since are refreshed. A few stored entries are
//   also re-read each run, oldest first, so a change that didn't touch the
//   modification time is caught too, later.
//
// Nothing here decides what is served: a change found in an entry becomes a
// publication event, recorded and processed like the CMS's own
// (applyPublication), so it follows the same ordering and withdrawal rules,
// and the rest is a refresh (delivery.ts). A failed read keeps what is
// stored; an entry is only ever made a 404 by WordPress confirming it isn't
// published, never by a failed or incomplete read; and a withdrawal in force
// is lifted only by a modification WordPress made after it.
//
// One run makes at most CMS_REQUEST_BUDGET requests to WordPress (Workers' Free
// plan allows 50 subrequests per invocation); what doesn't fit is left for the
// next run, oldest-attempted first. A lease in the store keeps runs from
// overlapping, and an interrupted run's lease expires.
import {
  eachLimited,
  reconcileShared,
  refreshEntries,
  routeOf,
  type RecordOutcome,
  type SharedReconciliation,
} from "./delivery";
import {
  StoreFailure,
  type EntryIndex,
  type PublicationEvent,
  type PublicationStore,
} from "./publications";
import { isLanguageHome } from "./site-language";
import { getPublishedEntries, type PublishedEntry } from "./wordpress";

/** The most requests to WordPress one run makes (Workers' Free plan: 50 subrequests). */
export const CMS_REQUEST_BUDGET = 40;
/** The shared rows' reads each run: the front page, the chrome and the design presets. */
const SHARED_REQUESTS = 3;
/** An entry read can take two requests: WordPress failing on its blocks is asked again without them. */
const REQUESTS_PER_READ = 2;
/** Stored entries re-read each run, when the budget allows, though WordPress lists them unchanged. */
const VERIFIED_PER_RUN = 2;
/** How long a run holds the lease; an interrupted run's lease is taken over after it. */
export const LEASE_MS = 2 * 60_000;

const ENTRY = "entry:";

type Publish = (
  store: PublicationStore,
  publication: PublicationEvent,
) => Promise<{ status: number; body: Record<string, unknown> }>;

export interface ReconcileOptions {
  /** The run's identity: the reconcile event's id. */
  runId: string;
  siteOrigin?: string;
  /** Records and processes a publication event (events.ts's applyPublication). */
  publish: Publish;
}

interface Failure {
  reason: string;
  message: string;
}

/**
 * Why an entry was refreshed: WordPress lists it and the store doesn't hold it
 * (new), holds it at another route (moved), holds another version (changed),
 * or holds it withdrawn though WordPress modified it after the withdrawal
 * (republished); the store holds it and WordPress doesn't list it (removed); or
 * it was re-read in turn (verified).
 */
export type Change = "new" | "changed" | "moved" | "republished" | "removed" | "verified";

type EntryOutcome =
  | { outcome: "refreshed" | "superseded" | "withdrawn" }
  | { outcome: "kept"; failure: Failure };

export type EntryReconciliation = { change: Change } & EntryOutcome;

export interface ReconciliationReport {
  /**
   * reconciled: the store matches WordPress; behind: changes are left for the
   * next run; failed: a read or a refresh failed, and kept what was stored;
   * busy: another run holds the lease, so this one did nothing.
   */
  status: "reconciled" | "behind" | "failed" | "busy";
  startedAt?: number;
  shared?: SharedReconciliation;
  /** WordPress's list of published entries: read, or failed (and every stored entry kept). */
  listing?: { outcome: "listed"; count: number } | { outcome: "kept"; failure: Failure };
  /** Each refreshed route's change and outcome. */
  entries?: Record<string, EntryReconciliation>;
  /** Published entries compared, changes refreshed, changes left for the next run, failures. */
  checked?: number;
  changed?: number;
  pending?: number;
  failed?: number;
  /** The first failure. */
  failure?: Failure;
}

interface Candidate {
  change: Change;
  route: string;
  /** How WordPress lists it, when it does. */
  listed?: PublishedEntry;
  /** The route the entry is stored at, when WordPress lists it at another. */
  previousRoute?: string;
  attemptedAt: number;
}

/**
 * One reconciliation run: compares the store with WordPress and refreshes
 * what differs, within the run's budget. Resolves to its report, which is
 * also recorded in the store.
 */
export async function reconcile(
  store: PublicationStore,
  { runId, siteOrigin, publish }: ReconcileOptions,
): Promise<ReconciliationReport> {
  const startedAt = Date.now();
  if (!(await store.startReconciliation(runId, startedAt, LEASE_MS))) {
    console.info(`Reconciliation: ${runId} found another run under way`);
    return { status: "busy" };
  }

  let report: ReconciliationReport;
  try {
    report = await run(store, startedAt, siteOrigin, publish);
  } catch (error) {
    if (!(error instanceof StoreFailure)) throw error;
    report = {
      status: "failed",
      startedAt,
      failed: 1,
      failure: { reason: "store", message: error.message },
    };
  }
  await finish(store, runId, report);

  const summary = `${report.checked ?? 0} checked, ${report.changed ?? 0} changed, ${report.pending ?? 0} left, ${report.failed ?? 0} failed`;
  if (report.status === "failed") {
    console.error(
      `Reconciliation: ${runId} failed (${summary}): ${report.failure?.reason}: ${report.failure?.message}`,
    );
  } else {
    console.info(`Reconciliation: ${runId} ${report.status} (${summary})`);
  }
  return report;
}

/** Records how the run ended and releases its lease; if that fails, the lease expires on its own. */
async function finish(store: PublicationStore, runId: string, report: ReconciliationReport) {
  try {
    await store.finishReconciliation(runId, {
      outcome: report.status === "busy" ? "failed" : report.status,
      checked: report.checked ?? 0,
      changed: report.changed ?? 0,
      pending: report.pending ?? 0,
      failed: report.failed ?? 0,
      ...report.failure,
    });
  } catch (error) {
    if (!(error instanceof StoreFailure)) throw error;
    console.error(`Reconciliation: ${runId}'s outcome couldn't be recorded: ${error.message}`);
  }
}

async function run(
  store: PublicationStore,
  startedAt: number,
  siteOrigin: string | undefined,
  publish: Publish,
): Promise<ReconciliationReport> {
  const [shared, listing] = await Promise.all([
    reconcileShared(store, siteOrigin),
    getPublishedEntries(),
  ]);
  const failures: Failure[] = [];
  let changed = 0;
  for (const outcome of Object.values(shared)) {
    if (outcome.outcome === "kept") failures.push(outcome.failure);
    if (outcome.outcome === "promoted") changed += 1;
  }

  if (listing.kind !== "found") {
    // An incomplete list says nothing about what isn't in it: nothing is
    // removed, and the stored entries are kept.
    failures.push(listing.failure);
    return {
      status: "failed",
      startedAt,
      shared,
      listing: { outcome: "kept", failure: listing.failure },
      entries: {},
      checked: 0,
      changed,
      pending: 0,
      failed: failures.length,
      failure: failures[0],
    };
  }

  const { entries: listed, requests } = listing.content;
  const index = await store.entryIndex();
  const found = candidates(listed, index);
  let budget = CMS_REQUEST_BUDGET - SHARED_REQUESTS - requests;
  const chosen: Candidate[] = [];
  let pending = 0;
  for (const candidate of found) {
    const cost = (candidate.previousRoute ? 2 : 1) * REQUESTS_PER_READ;
    if (cost > budget) {
      pending += 1;
      continue;
    }
    budget -= cost;
    chosen.push(candidate);
  }
  if (pending === 0) chosen.push(...verified(index, found, Math.floor(budget / REQUESTS_PER_READ)));

  const entries = await refresh(store, chosen, publish);
  for (const outcome of Object.values(entries)) {
    if (outcome.outcome === "kept") failures.push(outcome.failure);
    if (outcome.outcome === "refreshed" && outcome.change !== "verified") changed += 1;
  }
  return {
    status: failures.length > 0 ? "failed" : pending > 0 ? "behind" : "reconciled",
    startedAt,
    shared,
    listing: { outcome: "listed", count: listed.length },
    entries,
    checked: listed.length,
    changed,
    pending,
    failed: failures.length,
    ...(failures[0] ? { failure: failures[0] } : {}),
  };
}

/**
 * What differs between WordPress's list and the store, oldest-attempted first.
 * WordPress's front page (`/`) is the homepage's, reconciled with the shared
 * rows, unless it is withdrawn and modified since.
 */
function candidates(listed: PublishedEntry[], index: EntryIndex): Candidate[] {
  const rows = new Map(index.entries.map((row) => [row.key, row]));
  const storedAt = new Map<string, string[]>();
  for (const row of index.entries) {
    if (row.state !== "published" || !row.nodeId) continue;
    storedAt.set(row.nodeId, [...(storedAt.get(row.nodeId) ?? []), row.key.slice(ENTRY.length)]);
  }

  const found: Candidate[] = [];
  const listedRoutes = new Set<string>();
  const left = new Set<string>();
  for (const entry of listed) {
    const route = routeOf(entry.uri);
    if (listedRoutes.has(route)) continue;
    listedRoutes.add(route);
    const row = rows.get(`${ENTRY}${route}`);
    const withdrawnAt = entry.id === null ? undefined : index.withdrawals.get(entry.id);
    if (withdrawnAt !== undefined) {
      // Only a modification made after the withdrawal is a republication.
      if (entry.modifiedAt !== null && entry.modifiedAt > withdrawnAt) {
        found.push({
          change: "republished",
          route,
          listed: entry,
          attemptedAt: row?.attemptedAt ?? 0,
        });
      }
      continue;
    }
    // Each language's front page is its home's (reconcileShared), never an entry.
    if (isLanguageHome(route)) continue;
    if (
      row?.state === "published" &&
      entry.id !== null &&
      row.nodeId === entry.id &&
      entry.modifiedAt !== null &&
      row.modifiedAt === entry.modifiedAt
    ) {
      continue;
    }
    const previousRoute =
      entry.id === null ? undefined : storedAt.get(entry.id)?.find((stored) => stored !== route);
    if (previousRoute) left.add(previousRoute);
    found.push({
      change: previousRoute ? "moved" : row ? "changed" : "new",
      route,
      listed: entry,
      ...(previousRoute ? { previousRoute } : {}),
      attemptedAt: row?.attemptedAt ?? 0,
    });
  }
  for (const row of index.entries) {
    const route = row.key.slice(ENTRY.length);
    if (row.state !== "published" || listedRoutes.has(route) || left.has(route)) continue;
    found.push({ change: "removed", route, attemptedAt: row.attemptedAt });
  }
  return found.sort(
    (a, b) => a.attemptedAt - b.attemptedAt || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0),
  );
}

/** Up to `limit` (and VERIFIED_PER_RUN) stored entries no change was found in, oldest-attempted first. */
function verified(index: EntryIndex, found: Candidate[], limit: number): Candidate[] {
  const changing = new Set(found.flatMap(({ route, previousRoute }) => [route, previousRoute]));
  return index.entries
    .filter((row) => row.state === "published" && !changing.has(row.key.slice(ENTRY.length)))
    .sort((a, b) => a.attemptedAt - b.attemptedAt)
    .slice(0, Math.max(0, Math.min(limit, VERIFIED_PER_RUN)))
    .map((row) => ({
      change: "verified" as const,
      route: row.key.slice(ENTRY.length),
      attemptedAt: row.attemptedAt,
    }));
}

/**
 * Refreshes the chosen candidates. A change WordPress dates (its id and
 * modification time) becomes a publication event with that time, and an
 * identity derived from the change, so a repeated or interrupted run
 * records and retries the same event rather than a new one. The rest (a
 * removal, a re-read, an entry WordPress lists without its id or time) is a
 * refresh of the route.
 */
async function refresh(
  store: PublicationStore,
  chosen: Candidate[],
  publish: Publish,
): Promise<Record<string, EntryReconciliation>> {
  const outcomes: Record<string, EntryReconciliation> = {};
  const dated = chosen.filter(
    (candidate) => candidate.listed?.id && candidate.listed.modifiedAt !== null,
  );
  const plain = chosen.filter((candidate) => !dated.includes(candidate));

  const superseded: Candidate[] = [];
  await eachLimited(dated, 4, async (candidate) => {
    const listed = candidate.listed!;
    const publication: PublicationEvent = {
      id: await changeId(listed),
      action: "publish",
      nodeId: listed.id!,
      uri: listed.uri,
      previousUri: candidate.previousRoute ?? null,
      occurredAt: listed.modifiedAt!,
    };
    try {
      const { body } = await publish(store, publication);
      if (body.status === "refreshed") {
        outcomes[candidate.route] = { change: candidate.change, outcome: "refreshed" };
      } else if (body.status === "superseded") {
        superseded.push(candidate);
      } else {
        outcomes[candidate.route] = {
          change: candidate.change,
          outcome: "kept",
          failure: firstFailure(body) ?? {
            reason: "store",
            message: `the routes ${candidate.route} left couldn't be reconciled`,
          },
        };
      }
    } catch (error) {
      if (!(error instanceof StoreFailure)) throw error;
      outcomes[candidate.route] = {
        change: candidate.change,
        outcome: "kept",
        failure: { reason: "store", message: error.message },
      };
    }
  });

  // A change already processed, or superseded by a newer event, while the
  // store still differs (such as a row from before modification times were
  // stored): read the route again, by the rules of any refresh. A withdrawal
  // in force still refuses it.
  const reread = [
    ...plain,
    ...superseded.filter((candidate) => candidate.change !== "republished"),
  ];
  for (const candidate of superseded) {
    if (candidate.change === "republished") {
      outcomes[candidate.route] = { change: candidate.change, outcome: "superseded" };
    }
  }
  if (reread.length === 0) return outcomes;
  const routes = [
    ...new Set(
      reread.flatMap(({ route, previousRoute }) =>
        previousRoute ? [route, previousRoute] : [route],
      ),
    ),
  ];
  try {
    const refreshed = await refreshEntries(store, routes);
    for (const candidate of reread) {
      outcomes[candidate.route] = {
        change: candidate.change,
        ...routeOutcome(refreshed.entries[candidate.route]),
      };
    }
  } catch (error) {
    if (!(error instanceof StoreFailure)) throw error;
    for (const candidate of reread) {
      outcomes[candidate.route] = {
        change: candidate.change,
        outcome: "kept",
        failure: { reason: "store", message: error.message },
      };
    }
  }
  return outcomes;
}

function routeOutcome(outcome: RecordOutcome | undefined): EntryOutcome {
  if (!outcome) return { outcome: "kept", failure: { reason: "store", message: "not refreshed" } };
  if (outcome.outcome === "kept") return { outcome: "kept", failure: outcome.failure };
  if (outcome.outcome === "withdrawn") return { outcome: "withdrawn" };
  return { outcome: "refreshed" };
}

/** The first part of a refresh that kept its stored version, in a publication's answer. */
function firstFailure(body: Record<string, unknown>): Failure | undefined {
  const outcomes = [body.home, ...Object.values((body.entries as object | undefined) ?? {})];
  for (const outcome of outcomes as Array<RecordOutcome | undefined>) {
    if (outcome?.outcome === "kept") return outcome.failure;
  }
  return undefined;
}

/** A change's identity: the same entry, URI and modification time is the same change. */
async function changeId({ id, uri, modifiedAt }: PublishedEntry) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${id}\n${uri}\n${modifiedAt}`),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));
  return `reconcile-${hex.join("").slice(0, 40)}`;
}
