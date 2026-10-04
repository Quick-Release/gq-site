// The publication store: the Site's durable last-known-good public content, in
// D1 (migrations/), bound to the Worker as PUBLICATION_DB, the record of the
// CMS events that refresh it, and the reconciliation's lease and last outcome.
// It knows rows, formats and ordering; what is promoted, and when, is
// delivery.ts's call, what an event does events.ts's, and what a
// reconciliation compares reconciliation.ts's.

/** The part of D1's API the store uses, so tests can run the same SQL on SQLite. */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  /** Runs the statements in order as one transaction: all of them apply, or none. */
  batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<Array<{ results: T[] }>>;
}

/**
 * The version of the stored body's shape. Bump it, with a parser for the old
 * format or none, when the shape changes: a row in a format this Worker
 * doesn't know is unusable, never misread.
 */
export const PUBLICATION_FORMAT = 1;

export type StoredPublication<T> =
  | { state: "published"; content: T; promotedAt: number }
  | { state: "missing"; promotedAt: number }
  | { state: "moved"; uri: string; promotedAt: number }
  | { state: "withdrawn"; promotedAt: number };

/**
 * What a refresh promotes. `nodeId` is the WordPress post or page a row holds
 * (WPGraphQL's global id): published at another URI later, its old rows are
 * superseded. `modifiedAt` is when WordPress last modified it, as the read saw
 * it, which reconciliation compares with WordPress's list.
 */
export type Promotion<T> =
  | { state: "published"; content: T; nodeId?: string; modifiedAt?: number | null }
  | { state: "missing" }
  | { state: "moved"; uri: string; nodeId?: string };

/** Why a stored row can't be served: written in a format, or a shape, this Worker doesn't know. */
export interface Unusable {
  state: "unusable";
  message: string;
}

export interface RefreshAttempt {
  outcome: "promoted" | "superseded" | "kept";
  reason?: string;
  message?: string;
}

/** A CMS event about one WordPress entry, as the Frontend records it. */
export interface PublicationEvent {
  /** The event's identity, chosen by the CMS. */
  id: string;
  action: string;
  /** The WordPress entry it is about (WPGraphQL's global id). */
  nodeId: string;
  uri: string;
  previousUri: string | null;
  /** When it happened in the CMS (ms since the epoch). */
  occurredAt: number;
}

/**
 * Where an event stands: not processed yet (or interrupted), refreshed, failed
 * (a retry may process it again) or superseded by a newer refreshed event for
 * the same entry.
 */
export type EventStatus = "received" | "refreshed" | "failed" | "superseded";

export interface RecordedEvent extends PublicationEvent {
  status: EventStatus;
  attempts: number;
  receivedAt: number;
  processedAt: number | null;
  reason: string | null;
  message: string | null;
}

/**
 * What a withdraw event did: withdrew the entry (the keys now withdrawn), or
 * nothing, because a publication or withdrawal of the entry that happened
 * later was already accepted (`by`, when it is known).
 */
export type WithdrawalOutcome =
  | { status: "withdrawn"; keys: string[] }
  | { status: "superseded"; by: string | null };

export type EventOutcome =
  | { status: "refreshed" | "superseded" }
  | { status: "failed"; reason: string; message: string };

/** A stored entry row, as reconciliation compares it with WordPress's list. */
export interface StoredEntry {
  key: string;
  state: string;
  nodeId: string | null;
  modifiedAt: number | null;
  /** When it was last refreshed or looked at (ms), 0 if never. */
  attemptedAt: number;
}

/** What the store holds that reconciliation compares with WordPress. */
export interface EntryIndex {
  entries: StoredEntry[];
  /** The withdrawals in force: the entry's id and when it was withdrawn (the CMS's clock). */
  withdrawals: Map<string, number>;
}

/** How a reconciliation run ended, as it is recorded. */
export interface ReconciliationRecord {
  outcome: "reconciled" | "behind" | "failed";
  checked: number;
  changed: number;
  pending: number;
  failed: number;
  reason?: string;
  message?: string;
}

/** The last reconciliation: when it ran, how it ended, and when the store last matched WordPress. */
export interface ReconciliationState extends Partial<ReconciliationRecord> {
  startedAt: number | null;
  finishedAt: number | null;
  reconciledAt: number | null;
  /** Whether a run holds the lease now. */
  running: boolean;
}

/**
 * What the store holds, in states and counts only (no content): whether the
 * Site has been prepared, for the signed check. A shared row's state is
 * "unusable" when it is in a format this Worker doesn't serve, null when
 * nothing was ever stored there.
 */
export interface StoreStatus {
  home: string | null;
  chrome: string | null;
  design: string | null;
  /** The stored entry routes, by state ("published", "missing", "moved", "withdrawn", "unusable"). */
  entries: Record<string, number>;
  /** The withdrawals in force. */
  withdrawals: number;
  /** Recorded events whose processing failed: delayed until the CMS delivers them again. */
  failedEvents: number;
}

/** The store couldn't be read or written. Says nothing about the content. */
export class StoreFailure extends Error {}

interface PublicationRow {
  state: string;
  format: number;
  body: string | null;
  promoted_at: number;
}

export interface PublicationStore {
  /** The row at key, null if nothing was ever promoted there. */
  read<T>(
    key: string,
    parse: (body: unknown) => T | undefined,
  ): Promise<StoredPublication<T> | Unusable | null>;
  /**
   * Replaces the row at key unless a read that started later was already
   * promoted there ("superseded"), or the entry it holds is withdrawn
   * ("withdrawn"); nothing changes then.
   */
  promote<T>(
    key: string,
    publication: Promotion<T>,
    readStartedAt: number,
  ): Promise<"promoted" | "superseded" | "withdrawn">;
  /**
   * Marks every other row holding nodeId as moved to uri, unless its read
   * started at readBefore or later. Resolves to the keys it marked.
   */
  supersede(nodeId: string, uri: string, keep: string, readBefore: number): Promise<string[]>;
  /** The keys stored under prefix, whatever their state. */
  keys(prefix: string): Promise<string[]>;
  /**
   * The state of each of these keys' rows ("unusable" in a format this Worker
   * doesn't serve), in one read; a key nothing was ever promoted at is left out.
   */
  states(keys: string[]): Promise<Map<string, string>>;
  recordAttempt(key: string, attempt: RefreshAttempt): Promise<void>;
  /**
   * Records a CMS event unless one with its id already is. Resolves to the
   * recorded event, the earlier one for a duplicate.
   */
  receiveEvent(event: PublicationEvent): Promise<{ recorded: RecordedEvent; duplicate: boolean }>;
  /**
   * The id of an event about the same entry that happened after this one and
   * was refreshed, null if there is none.
   */
  newerRefreshedEvent(event: PublicationEvent): Promise<string | null>;
  /**
   * Withdraws the event's entry, in one transaction, unless a publication or
   * withdrawal of it that happened later was already accepted: every row
   * holding it, and the row at key unless it holds another entry, become
   * withdrawn, and nothing promotes the entry again until a later
   * publication lifts the withdrawal.
   */
  withdraw(event: PublicationEvent, key: string, acceptedAt: number): Promise<WithdrawalOutcome>;
  /**
   * Lifts the entry's withdrawal if it happened before this publication.
   * Resolves to the withdraw event lifted, null if none was.
   */
  liftWithdrawal(event: PublicationEvent): Promise<string | null>;
  /** Counts a processing attempt of the event. */
  startEvent(id: string): Promise<void>;
  /** The stored entries and the withdrawals in force, for a reconciliation. */
  entryIndex(): Promise<EntryIndex>;
  /**
   * Takes the reconciliation's lease for this run until `now + leaseMs`,
   * unless another run holds it. Resolves to whether it was taken.
   */
  startReconciliation(runId: string, now: number, leaseMs: number): Promise<boolean>;
  /** Records how the run ended and releases its lease. */
  finishReconciliation(runId: string, record: ReconciliationRecord): Promise<void>;
  /** The last reconciliation, null if none ever ran. */
  reconciliation(): Promise<ReconciliationState | null>;
  /** What the store holds, in states and counts. */
  status(): Promise<StoreStatus>;
  /**
   * Records how processing the event ended. A refreshed event supersedes the
   * older ones about the same entry that weren't refreshed, so a retry skips
   * them.
   */
  finishEvent(event: PublicationEvent, outcome: EventOutcome): Promise<void>;
}

interface EventRow {
  id: string;
  action: string;
  node_id: string;
  uri: string;
  previous_uri: string | null;
  occurred_at: number;
  received_at: number;
  status: EventStatus;
  attempts: number;
  processed_at: number | null;
  reason: string | null;
  message: string | null;
}

const eventOf = (row: EventRow): RecordedEvent => ({
  id: row.id,
  action: row.action,
  nodeId: row.node_id,
  uri: row.uri,
  previousUri: row.previous_uri,
  occurredAt: row.occurred_at,
  receivedAt: row.received_at,
  status: row.status,
  attempts: row.attempts,
  processedAt: row.processed_at,
  reason: row.reason,
  message: row.message,
});

async function guard<T>(action: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new StoreFailure(`The publication store couldn't ${action}: ${String(error)}`, {
      cause: error,
    });
  }
}

export function publicationStore(db: SqlDatabase): PublicationStore {
  return {
    async read(key, parse) {
      const row = await guard("be read", () =>
        db
          .prepare("SELECT state, format, body, promoted_at FROM publications WHERE key = ?")
          .bind(key)
          .first<PublicationRow>(),
      );
      if (!row) return null;
      if (row.format !== PUBLICATION_FORMAT) {
        return {
          state: "unusable",
          message: `${key} is stored in format ${row.format}; this Frontend serves format ${PUBLICATION_FORMAT}`,
        };
      }
      if (row.state === "missing") return { state: "missing", promotedAt: row.promoted_at };
      if (row.state === "withdrawn") return { state: "withdrawn", promotedAt: row.promoted_at };
      if (row.state === "moved") {
        const uri = movedTo(row.body);
        if (uri) return { state: "moved", uri, promotedAt: row.promoted_at };
        return { state: "unusable", message: `${key} is stored as moved without a readable URI` };
      }

      let content: ReturnType<typeof parse>;
      try {
        content = row.state === "published" && row.body ? parse(JSON.parse(row.body)) : undefined;
      } catch {
        content = undefined;
      }
      if (content === undefined) {
        return {
          state: "unusable",
          message: `${key} is stored with a body this Frontend can't read`,
        };
      }
      return { state: "published", content, promotedAt: row.promoted_at };
    },

    async promote(key, publication, readStartedAt) {
      const body =
        publication.state === "published"
          ? JSON.stringify(publication.content)
          : publication.state === "moved"
            ? JSON.stringify({ uri: publication.uri })
            : null;
      const nodeId = publication.state === "missing" ? null : (publication.nodeId ?? null);
      const modifiedAt =
        publication.state === "published" ? (publication.modifiedAt ?? null) : null;
      // An entry under a withdrawal in force is never promoted, by any read.
      const result = await guard("be written", () =>
        db
          .prepare(
            `INSERT INTO publications
               (key, state, format, body, read_started_at, promoted_at, node_id, modified_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
             WHERE ?7 IS NULL OR NOT EXISTS (
               SELECT 1 FROM withdrawals WHERE node_id = ?7 AND republished_at IS NULL)
             ON CONFLICT (key) DO UPDATE SET
               state = excluded.state,
               format = excluded.format,
               body = excluded.body,
               read_started_at = excluded.read_started_at,
               promoted_at = excluded.promoted_at,
               node_id = excluded.node_id,
               modified_at = excluded.modified_at
             WHERE excluded.read_started_at > publications.read_started_at`,
          )
          .bind(
            key,
            publication.state,
            PUBLICATION_FORMAT,
            body,
            readStartedAt,
            Date.now(),
            nodeId,
            modifiedAt,
          )
          .run(),
      );
      if (result.meta.changes > 0) return "promoted";
      if (nodeId === null) return "superseded";
      const withdrawn = await guard("be read", () =>
        db
          .prepare(
            "SELECT 1 AS found FROM withdrawals WHERE node_id = ? AND republished_at IS NULL",
          )
          .bind(nodeId)
          .first(),
      );
      return withdrawn ? "withdrawn" : "superseded";
    },

    async supersede(nodeId, uri, keep, readBefore) {
      const body = JSON.stringify({ uri });
      const { results } = await guard("be written", () =>
        db
          .prepare(
            `UPDATE publications SET
               state = 'moved', format = ?1, body = ?2, read_started_at = ?3, promoted_at = ?4
             WHERE node_id = ?5 AND key <> ?6 AND read_started_at < ?3
               AND (state = 'published' OR (state = 'moved' AND body <> ?2))
             RETURNING key`,
          )
          .bind(PUBLICATION_FORMAT, body, readBefore, Date.now(), nodeId, keep)
          .all<{ key: string }>(),
      );
      return results.map((row) => row.key).sort();
    },

    async keys(prefix) {
      const { results } = await guard("be read", () =>
        db
          .prepare("SELECT key FROM publications WHERE substr(key, 1, length(?1)) = ?1")
          .bind(prefix)
          .all<{ key: string }>(),
      );
      return results.map((row) => row.key).sort();
    },

    async states(keys) {
      if (keys.length === 0) return new Map();
      const { results } = await guard("be read", () =>
        db
          .prepare(
            `SELECT key, CASE WHEN format = ?1 THEN state ELSE 'unusable' END AS state
             FROM publications WHERE key IN (SELECT value FROM json_each(?2))`,
          )
          .bind(PUBLICATION_FORMAT, JSON.stringify(keys))
          .all<{ key: string; state: string }>(),
      );
      return new Map(results.map((row) => [row.key, row.state]));
    },

    async recordAttempt(key, attempt) {
      await guard("record a refresh", () =>
        db
          .prepare(
            `INSERT INTO refresh_attempts (key, attempted_at, outcome, reason, message)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (key) DO UPDATE SET
               attempted_at = excluded.attempted_at,
               outcome = excluded.outcome,
               reason = excluded.reason,
               message = excluded.message`,
          )
          .bind(key, Date.now(), attempt.outcome, attempt.reason ?? null, attempt.message ?? null)
          .run(),
      );
    },

    async receiveEvent(event) {
      const { results } = await guard("record an event", () =>
        db
          .prepare(
            `INSERT INTO publication_events
               (id, action, node_id, uri, previous_uri, occurred_at, received_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'received')
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
          )
          .bind(
            event.id,
            event.action,
            event.nodeId,
            event.uri,
            event.previousUri,
            event.occurredAt,
            Date.now(),
          )
          .all<{ id: string }>(),
      );
      const row = await guard("read an event", () =>
        db
          .prepare("SELECT * FROM publication_events WHERE id = ?")
          .bind(event.id)
          .first<EventRow>(),
      );
      if (!row) throw new StoreFailure(`The publication store lost the event ${event.id}`);
      return { recorded: eventOf(row), duplicate: results.length === 0 };
    },

    async newerRefreshedEvent(event) {
      const row = await guard("read the events", () =>
        db
          .prepare(
            `SELECT id FROM publication_events
             WHERE node_id = ?1 AND occurred_at > ?2 AND status = 'refreshed'
             ORDER BY occurred_at DESC LIMIT 1`,
          )
          .bind(event.nodeId, event.occurredAt)
          .first<{ id: string }>(),
      );
      return row?.id ?? null;
    },

    async withdraw(event, key, acceptedAt) {
      const inForce = `EXISTS (SELECT 1 FROM withdrawals
        WHERE node_id = ?1 AND event_id = ?2 AND republished_at IS NULL)`;
      const now = Date.now();
      const [, , , [current], [newer], withdrawn] = await guard("record a withdrawal", () =>
        db
          .batch([
            // Accepted unless a publication that happened later is recorded,
            // or a later withdrawal is in force.
            db
              .prepare(
                `INSERT INTO withdrawals (node_id, event_id, uri, withdrawn_at, accepted_at)
                 SELECT ?1, ?2, ?3, ?4, ?5
                 WHERE NOT EXISTS (SELECT 1 FROM publication_events
                   WHERE node_id = ?1 AND action = 'publish' AND occurred_at > ?4)
                 ON CONFLICT (node_id) DO UPDATE SET
                   event_id = excluded.event_id,
                   uri = excluded.uri,
                   withdrawn_at = excluded.withdrawn_at,
                   accepted_at = excluded.accepted_at,
                   republished_by = NULL,
                   republished_at = NULL
                 WHERE excluded.withdrawn_at > withdrawals.withdrawn_at
                   AND excluded.withdrawn_at > coalesce(withdrawals.republished_at, 0)`,
              )
              .bind(event.nodeId, event.id, event.uri, event.occurredAt, acceptedAt),
            // Every route serving the entry, or redirecting for it.
            db
              .prepare(
                `UPDATE publications SET
                   state = 'withdrawn', format = ?3, body = NULL,
                   read_started_at = max(read_started_at, ?4), promoted_at = ?5
                 WHERE node_id = ?1 AND state <> 'withdrawn' AND ${inForce}`,
              )
              .bind(event.nodeId, event.id, PUBLICATION_FORMAT, acceptedAt, now),
            // The URI it was withdrawn at, even if the store never held it
            // there, so a cold lookup can't bring it back; unless another
            // entry is stored there.
            db
              .prepare(
                `INSERT INTO publications (key, state, format, body, read_started_at, promoted_at, node_id)
                 SELECT ?3, 'withdrawn', ?4, NULL, ?5, ?6, ?1 WHERE ${inForce}
                 ON CONFLICT (key) DO UPDATE SET
                   state = 'withdrawn', format = excluded.format, body = NULL,
                   read_started_at = max(publications.read_started_at, excluded.read_started_at),
                   promoted_at = excluded.promoted_at, node_id = excluded.node_id
                 WHERE publications.node_id IS NULL AND publications.state <> 'withdrawn'`,
              )
              .bind(event.nodeId, event.id, key, PUBLICATION_FORMAT, acceptedAt, now),
            db
              .prepare(
                "SELECT event_id FROM withdrawals WHERE node_id = ? AND republished_at IS NULL",
              )
              .bind(event.nodeId),
            db
              .prepare(
                `SELECT id FROM publication_events
                 WHERE node_id = ?1 AND action = 'publish' AND occurred_at > ?2
                 ORDER BY occurred_at DESC LIMIT 1`,
              )
              .bind(event.nodeId, event.occurredAt),
            db
              .prepare(
                "SELECT key FROM publications WHERE node_id = ? AND state = 'withdrawn' ORDER BY key",
              )
              .bind(event.nodeId),
          ])
          .then((results) => results.map((result) => result.results)),
      );
      const inForceBy = (current as { event_id?: string } | undefined)?.event_id;
      if (inForceBy === event.id) {
        return {
          status: "withdrawn",
          keys: (withdrawn as Array<{ key: string }>).map((row) => row.key),
        };
      }
      return {
        status: "superseded",
        by: (newer as { id?: string } | undefined)?.id ?? inForceBy ?? null,
      };
    },

    async liftWithdrawal(event) {
      const row = await guard("record a publication", () =>
        db
          .prepare(
            `UPDATE withdrawals SET republished_by = ?2, republished_at = ?3
             WHERE node_id = ?1 AND republished_at IS NULL AND withdrawn_at < ?3
             RETURNING event_id`,
          )
          .bind(event.nodeId, event.id, event.occurredAt)
          .first<{ event_id: string }>(),
      );
      return row?.event_id ?? null;
    },

    async entryIndex() {
      const [entries, withdrawals] = await guard("be read", () =>
        db.batch([
          db.prepare(
            `SELECT p.key, p.state, p.node_id, p.modified_at, coalesce(a.attempted_at, 0) AS attempted_at
             FROM publications p LEFT JOIN refresh_attempts a ON a.key = p.key
             WHERE substr(p.key, 1, 6) = 'entry:'
             ORDER BY p.key`,
          ),
          db.prepare("SELECT node_id, withdrawn_at FROM withdrawals WHERE republished_at IS NULL"),
        ]),
      );
      return {
        entries: (
          entries!.results as Array<{
            key: string;
            state: string;
            node_id: string | null;
            modified_at: number | null;
            attempted_at: number;
          }>
        ).map((row) => ({
          key: row.key,
          state: row.state,
          nodeId: row.node_id,
          modifiedAt: row.modified_at,
          attemptedAt: row.attempted_at,
        })),
        withdrawals: new Map(
          (withdrawals!.results as Array<{ node_id: string; withdrawn_at: number }>).map((row) => [
            row.node_id,
            row.withdrawn_at,
          ]),
        ),
      };
    },

    async startReconciliation(runId, now, leaseMs) {
      const { results } = await guard("record a reconciliation", () =>
        db
          .prepare(
            `INSERT INTO reconciliation (id, run_id, lease_until, started_at)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET
               run_id = excluded.run_id,
               lease_until = excluded.lease_until,
               started_at = excluded.started_at
             WHERE reconciliation.lease_until <= ?3
             RETURNING run_id`,
          )
          .bind(runId, now + leaseMs, now)
          .all<{ run_id: string }>(),
      );
      return results.length > 0;
    },

    async finishReconciliation(runId, record) {
      await guard("record a reconciliation", () =>
        db
          .prepare(
            `UPDATE reconciliation SET
               lease_until = 0, finished_at = ?2, outcome = ?3, checked = ?4, changed = ?5,
               pending = ?6, failed = ?7, reason = ?8, message = ?9,
               reconciled_at = CASE WHEN ?3 = 'reconciled' THEN started_at ELSE reconciled_at END
             WHERE id = 1 AND run_id = ?1`,
          )
          .bind(
            runId,
            Date.now(),
            record.outcome,
            record.checked,
            record.changed,
            record.pending,
            record.failed,
            record.reason ?? null,
            record.message ?? null,
          )
          .run(),
      );
    },

    async reconciliation() {
      const row = await guard("be read", () =>
        db.prepare("SELECT * FROM reconciliation WHERE id = 1").first<{
          lease_until: number;
          started_at: number | null;
          finished_at: number | null;
          outcome: ReconciliationRecord["outcome"] | null;
          checked: number | null;
          changed: number | null;
          pending: number | null;
          failed: number | null;
          reason: string | null;
          message: string | null;
          reconciled_at: number | null;
        }>(),
      );
      if (!row) return null;
      return {
        running: row.lease_until > Date.now(),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        reconciledAt: row.reconciled_at,
        ...(row.outcome
          ? {
              outcome: row.outcome,
              checked: row.checked ?? 0,
              changed: row.changed ?? 0,
              pending: row.pending ?? 0,
              failed: row.failed ?? 0,
            }
          : {}),
        ...(row.reason ? { reason: row.reason } : {}),
        ...(row.message ? { message: row.message } : {}),
      };
    },

    async status() {
      const [shared, entries, withdrawals, failed] = await guard("be read", () =>
        db.batch([
          db.prepare(
            "SELECT key, state, format FROM publications WHERE key IN ('home', 'chrome', 'design')",
          ),
          db
            .prepare(
              `SELECT CASE WHEN format = ?1 THEN state ELSE 'unusable' END AS state, count(*) AS count
               FROM publications WHERE substr(key, 1, 6) = 'entry:' GROUP BY 1`,
            )
            .bind(PUBLICATION_FORMAT),
          db.prepare("SELECT count(*) AS count FROM withdrawals WHERE republished_at IS NULL"),
          db.prepare("SELECT count(*) AS count FROM publication_events WHERE status = 'failed'"),
        ]),
      );
      const rows = shared!.results as Array<{ key: string; state: string; format: number }>;
      const state = (key: string) => {
        const row = rows.find((candidate) => candidate.key === key);
        if (!row) return null;
        return row.format === PUBLICATION_FORMAT ? row.state : "unusable";
      };
      const count = (result: { results: unknown[] } | undefined) =>
        Number((result?.results[0] as { count?: number } | undefined)?.count ?? 0);
      return {
        home: state("home"),
        chrome: state("chrome"),
        design: state("design"),
        entries: Object.fromEntries(
          (entries!.results as Array<{ state: string; count: number }>).map((row) => [
            row.state,
            Number(row.count),
          ]),
        ),
        withdrawals: count(withdrawals),
        failedEvents: count(failed),
      };
    },

    async startEvent(id) {
      await guard("record an event", () =>
        db
          .prepare("UPDATE publication_events SET attempts = attempts + 1 WHERE id = ?")
          .bind(id)
          .run(),
      );
    },

    async finishEvent(event, outcome) {
      const failure = outcome.status === "failed" ? outcome : null;
      await guard("record an event", () =>
        db
          .prepare(
            `UPDATE publication_events
             SET status = ?2, processed_at = ?3, reason = ?4, message = ?5
             WHERE id = ?1`,
          )
          .bind(
            event.id,
            outcome.status,
            Date.now(),
            failure?.reason ?? null,
            failure?.message ?? null,
          )
          .run(),
      );
      if (outcome.status !== "refreshed") return;
      await guard("record an event", () =>
        db
          .prepare(
            `UPDATE publication_events SET status = 'superseded'
             WHERE node_id = ?1 AND occurred_at < ?2 AND status IN ('received', 'failed')`,
          )
          .bind(event.nodeId, event.occurredAt)
          .run(),
      );
    },
  };
}

function movedTo(body: string | null) {
  try {
    const uri = (JSON.parse(body ?? "null") as { uri?: unknown } | null)?.uri;
    // A path on this site only, never another host's (`//host/`).
    return typeof uri === "string" && /^\/(?!\/)/.test(uri) ? uri : undefined;
  } catch {
    return undefined;
  }
}
