import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectCatalogEntry } from "../../config.js";
import type {
  MastermindNextActionDecision,
  ProposedLinearTicketPatch,
  ReviewOpenItemDisposition,
  ReviewOpenItemKind,
  ReviewOpenItemOwner,
  TicketReviewDossier,
} from "../../generated/baml_client/index.js";
import { MastermindAction, MastermindState } from "../domain/events.js";
import type {
  ExecutionAttempt,
  ExecutionAttemptPatch,
  ExecutionAttachmentTarget,
  ExecutionProjection,
  IngestDeliveryInput,
  LinearTicketSnapshot,
  MastermindEventRecord,
  MastermindStore,
  MastermindWorkItem,
  RecoverableExecution,
  StoredReview,
  StoredCodeReview,
  TerminalWorkFreshnessScanCursor,
  TerminalWorkFreshnessScanPage,
  TicketReviewValidationRecord,
} from "./store.js";

type SqlRow = Record<string, unknown>;

export class SqliteMastermindStore implements MastermindStore {
  private database?: DatabaseSync;

  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(`
      CREATE TABLE IF NOT EXISTS mastermind_work_items (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        project_policy_id TEXT,
        resolved_project_json TEXT,
        state TEXT NOT NULL,
        planned_action TEXT,
        current_execution_attempt_id TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        row_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, issue_id)
      );
      CREATE TABLE IF NOT EXISTS mastermind_deliveries (
        delivery_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES mastermind_work_items(id),
        organization_id TEXT NOT NULL,
        webhook_id TEXT,
        event_type TEXT NOT NULL,
        action TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mastermind_ticket_snapshots (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES mastermind_work_items(id),
        snapshot_json TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mastermind_reviews (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES mastermind_work_items(id),
        original_snapshot_json TEXT NOT NULL,
        original_content_hash TEXT,
        dossier_json TEXT,
        patch_json TEXT,
        review_json TEXT NOT NULL,
        validation_json TEXT,
        applied_snapshot_json TEXT,
        content_applied INTEGER NOT NULL DEFAULT 0,
        label_applied INTEGER NOT NULL DEFAULT 0,
        invalidated INTEGER NOT NULL DEFAULT 0,
        invalidation_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mastermind_action_decisions (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES mastermind_work_items(id),
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mastermind_execution_attempts (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES mastermind_work_items(id),
        attempt_number INTEGER NOT NULL,
        action TEXT NOT NULL,
        project_policy_id TEXT NOT NULL,
        project_policy_version TEXT NOT NULL,
        executor_kind TEXT NOT NULL,
        state TEXT NOT NULL,
        workspace_json TEXT,
        preflight_json TEXT,
        executor_handle_json TEXT,
        last_status_json TEXT,
        result_json TEXT,
        verification_json TEXT,
        failure_class TEXT,
        failure_message TEXT,
        retry_eligible INTEGER NOT NULL DEFAULT 0,
        projection_json TEXT,
        row_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        launched_at TEXT,
        terminal_at TEXT,
        collected_at TEXT,
        UNIQUE (work_id, attempt_number)
      );
      CREATE TABLE IF NOT EXISTS mastermind_events (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES mastermind_work_items(id),
        event_type TEXT NOT NULL,
        prior_state TEXT NOT NULL,
        next_state TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mastermind_code_reviews (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES mastermind_work_items(id),
        execution_attempt_id TEXT NOT NULL REFERENCES mastermind_execution_attempts(id),
        commit_sha TEXT NOT NULL,
        result_hash TEXT NOT NULL,
        ticket_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        dossier_json TEXT,
        review_json TEXT,
        projection_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (execution_attempt_id, commit_sha, result_hash, ticket_hash)
      );
      CREATE INDEX IF NOT EXISTS mastermind_events_work_id_idx
        ON mastermind_events(work_id, created_at);
      CREATE INDEX IF NOT EXISTS mastermind_execution_attempts_work_number_idx
        ON mastermind_execution_attempts(work_id, attempt_number);
      CREATE INDEX IF NOT EXISTS mastermind_execution_attempts_state_updated_idx
        ON mastermind_execution_attempts(state, updated_at);
      CREATE INDEX IF NOT EXISTS mastermind_execution_attempts_recoverable_idx
        ON mastermind_execution_attempts(work_id, state, updated_at);
      CREATE INDEX IF NOT EXISTS mastermind_code_reviews_work_updated_idx
        ON mastermind_code_reviews(work_id, updated_at);
    `);
    ensureColumn(database, "mastermind_work_items", "current_execution_attempt_id", "TEXT");
    ensureColumn(database, "mastermind_work_items", "resolved_project_json", "TEXT");
    ensureColumn(database, "mastermind_reviews", "original_content_hash", "TEXT");
    ensureColumn(database, "mastermind_reviews", "dossier_json", "TEXT");
    ensureColumn(database, "mastermind_reviews", "patch_json", "TEXT");
    ensureColumn(database, "mastermind_reviews", "validation_json", "TEXT");
    ensureColumn(database, "mastermind_reviews", "applied_snapshot_json", "TEXT");
    ensureColumn(database, "mastermind_reviews", "invalidated", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "mastermind_reviews", "invalidation_reason", "TEXT");
    this.database = database;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  async ingestDelivery(
    input: IngestDeliveryInput,
  ): Promise<{ duplicate: boolean; workId: string }> {
    const database = this.getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database
        .prepare("SELECT work_id FROM mastermind_deliveries WHERE delivery_id = ?")
        .get(input.deliveryId) as SqlRow | undefined;
      if (existing) {
        database.exec("COMMIT");
        return { duplicate: true, workId: String(existing.work_id) };
      }

      const now = new Date().toISOString();
      const workId = randomUUID();
      database
        .prepare(
          `INSERT INTO mastermind_work_items
            (id, organization_id, issue_id, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (organization_id, issue_id) DO NOTHING`,
        )
        .run(workId, input.organizationId, input.issueId, MastermindState.RECEIVED, now, now);
      const work = database
        .prepare("SELECT id FROM mastermind_work_items WHERE organization_id = ? AND issue_id = ?")
        .get(input.organizationId, input.issueId) as SqlRow;
      const resolvedWorkId = String(work.id);
      database
        .prepare(
          `INSERT INTO mastermind_deliveries
            (delivery_id, work_id, organization_id, webhook_id, event_type, action, issue_id, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.deliveryId,
          resolvedWorkId,
          input.organizationId,
          input.webhookId ?? null,
          input.eventType,
          input.action,
          input.issueId,
          now,
        );
      database.exec("COMMIT");
      return { duplicate: false, workId: resolvedWorkId };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async acquireLease(
    workId: string,
    owner: string,
    now: Date,
    durationMs: number,
  ): Promise<MastermindWorkItem | undefined> {
    const nowIso = now.toISOString();
    const expiry = new Date(now.getTime() + durationMs).toISOString();
    const result = this.getDatabase()
      .prepare(
        `UPDATE mastermind_work_items
         SET lease_owner = ?, lease_expires_at = ?, row_version = row_version + 1, updated_at = ?
         WHERE id = ?
           AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
      )
      .run(owner, expiry, nowIso, workId, nowIso);
    if (result.changes !== 1) {
      return undefined;
    }
    return this.getWork(workId);
  }

  async releaseLease(workId: string, owner: string): Promise<void> {
    this.getDatabase()
      .prepare(
        `UPDATE mastermind_work_items
         SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND lease_owner = ?`,
      )
      .run(new Date().toISOString(), workId, owner);
  }

  async renewLease(workId: string, owner: string, now: Date, durationMs: number): Promise<boolean> {
    const nowIso = now.toISOString();
    const expiry = new Date(now.getTime() + durationMs).toISOString();
    const result = this.getDatabase()
      .prepare(
        `UPDATE mastermind_work_items
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?`,
      )
      .run(expiry, nowIso, workId, owner, nowIso);
    return result.changes === 1;
  }

  async getWork(workId: string): Promise<MastermindWorkItem | undefined> {
    const row = this.getDatabase()
      .prepare("SELECT * FROM mastermind_work_items WHERE id = ?")
      .get(workId) as SqlRow | undefined;
    return row ? toWorkItem(row) : undefined;
  }

  async transition(
    work: MastermindWorkItem,
    owner: string,
    event: MastermindEventRecord,
  ): Promise<MastermindWorkItem> {
    const database = this.getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const plannedAction =
        typeof event.metadata?.plannedAction === "string"
          ? event.metadata.plannedAction
          : work.plannedAction;
      const result = database
        .prepare(
          `UPDATE mastermind_work_items
           SET state = ?, planned_action = ?,
               current_execution_attempt_id = CASE WHEN ? = ? THEN NULL ELSE current_execution_attempt_id END,
               row_version = row_version + 1, updated_at = ?
           WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?
             AND row_version = ? AND state = ?`,
        )
        .run(
          event.nextState,
          plannedAction ?? null,
          event.eventType,
          "REOPEN_REVIEW",
          now,
          work.id,
          owner,
          now,
          work.rowVersion,
          event.priorState,
        );
      if (result.changes !== 1) {
        throw new Error(`Stale Mastermind transition for work item ${work.id}.`);
      }
      database
        .prepare(
          `INSERT INTO mastermind_events
            (id, work_id, event_type, prior_state, next_state, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          work.id,
          event.eventType,
          event.priorState,
          event.nextState,
          event.metadata ? JSON.stringify(event.metadata) : null,
          now,
        );
      database.exec("COMMIT");
      const updated = await this.getWork(work.id);
      if (!updated) {
        throw new Error(`Mastermind work item disappeared after transition: ${work.id}`);
      }
      return updated;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async createExecutionAttempt(input: {
    work: MastermindWorkItem;
    owner: string;
    projectPolicyId: string;
    projectPolicyVersion: string;
    executorKind: ExecutionAttempt["executorKind"];
    action: MastermindAction;
  }): Promise<{ work: MastermindWorkItem; attempt: ExecutionAttempt }> {
    const database = this.getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const current = database
        .prepare("SELECT * FROM mastermind_work_items WHERE id = ?")
        .get(input.work.id) as SqlRow | undefined;
      if (
        !current ||
        current.lease_owner !== input.owner ||
        typeof current.lease_expires_at !== "string" ||
        current.lease_expires_at <= now ||
        Number(current.row_version) !== input.work.rowVersion ||
        (current.state !== MastermindState.ACTION_PLANNED &&
          current.state !== MastermindState.RETRY_WAIT) ||
        current.planned_action !== input.action ||
        (current.state === MastermindState.ACTION_PLANNED &&
          current.current_execution_attempt_id !== null)
      ) {
        throw new FencedExecutionError(
          input.work.id,
          undefined,
          `Cannot create execution attempt for stale or ineligible work item ${input.work.id}.`,
        );
      }
      const priorState = String(current.state);
      const priorAttemptId =
        typeof current.current_execution_attempt_id === "string"
          ? current.current_execution_attempt_id
          : null;
      if (priorState === MastermindState.RETRY_WAIT) {
        const retryAttempt = database
          .prepare(
            `SELECT retry_eligible, state
                 FROM mastermind_execution_attempts
                 WHERE id = ? AND work_id = ?`,
          )
          .get(priorAttemptId, input.work.id) as SqlRow | undefined;
        if (
          !retryAttempt ||
          Number(retryAttempt.retry_eligible) !== 1 ||
          retryAttempt.state !== MastermindState.RETRY_WAIT
        ) {
          throw new FencedExecutionError(
            input.work.id,
            priorAttemptId ?? undefined,
            `Execution retry is not eligible for work item ${input.work.id}.`,
          );
        }
      }
      const next = database
        .prepare(
          `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
               FROM mastermind_execution_attempts
               WHERE work_id = ?`,
        )
        .get(input.work.id) as SqlRow;
      const attemptId = randomUUID();
      const attemptNumber = Number(next.attempt_number);
      database
        .prepare(
          `INSERT INTO mastermind_execution_attempts
                (id, work_id, attempt_number, action, project_policy_id, project_policy_version,
                 executor_kind, state, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attemptId,
          input.work.id,
          attemptNumber,
          input.action,
          input.projectPolicyId,
          input.projectPolicyVersion,
          input.executorKind,
          MastermindState.PROVISIONING,
          now,
          now,
        );
      const updated = database
        .prepare(
          `UPDATE mastermind_work_items
               SET state = ?, current_execution_attempt_id = ?, row_version = row_version + 1,
                   updated_at = ?
               WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?
                 AND row_version = ? AND state = ? AND planned_action = ?
                 AND (? = ? OR current_execution_attempt_id = ?)`,
        )
        .run(
          MastermindState.PROVISIONING,
          attemptId,
          now,
          input.work.id,
          input.owner,
          now,
          input.work.rowVersion,
          priorState,
          input.action,
          priorState,
          MastermindState.ACTION_PLANNED,
          priorAttemptId,
        );
      if (updated.changes !== 1) {
        throw new FencedExecutionError(
          input.work.id,
          attemptId,
          `Execution attempt creation lost its work-item fence for ${input.work.id}.`,
        );
      }
      this.insertEvent(database, {
        workId: input.work.id,
        eventType: "execution.attempt_created",
        priorState,
        nextState: MastermindState.PROVISIONING,
        metadata: { attemptId, attemptNumber, executorKind: input.executorKind },
        createdAt: now,
      });
      database.exec("COMMIT");
      return {
        work: (await this.getWork(input.work.id))!,
        attempt: (await this.getExecutionAttempt(attemptId))!,
      };
    } catch (error) {
      database.exec("ROLLBACK");
      if (error instanceof FencedExecutionError) {
        this.appendAuditEvent(input.work.id, "execution.fence_rejected", {
          attemptId: error.attemptId,
          message: error.message,
        });
      }
      throw error;
    }
  }

  async getExecutionAttempt(attemptId: string): Promise<ExecutionAttempt | undefined> {
    const row = this.getDatabase()
      .prepare("SELECT * FROM mastermind_execution_attempts WHERE id = ?")
      .get(attemptId) as SqlRow | undefined;
    return row ? toExecutionAttempt(row) : undefined;
  }

  async getCurrentExecutionAttempt(workId: string): Promise<ExecutionAttempt | undefined> {
    const row = this.getDatabase()
      .prepare(
        `SELECT attempt.*
             FROM mastermind_work_items work
             JOIN mastermind_execution_attempts attempt
               ON attempt.id = work.current_execution_attempt_id
             WHERE work.id = ?`,
      )
      .get(workId) as SqlRow | undefined;
    return row ? toExecutionAttempt(row) : undefined;
  }

  async listExecutionAttempts(workId: string): Promise<ExecutionAttempt[]> {
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM mastermind_execution_attempts
           WHERE work_id = ?
           ORDER BY attempt_number ASC`,
      )
      .all(workId) as SqlRow[];
    return rows.map(toExecutionAttempt);
  }

  async listRecentTicketWorkIds(
    limit: number,
  ): Promise<Array<{ workId: string; identifier: string }>> {
    const rows = this.getDatabase()
      .prepare(
        `SELECT work.id AS work_id,
                json_extract(snapshot.snapshot_json, '$.identifier') AS identifier
           FROM mastermind_work_items work
           JOIN mastermind_ticket_snapshots snapshot
             ON snapshot.id = (
               SELECT latest.id
               FROM mastermind_ticket_snapshots latest
               WHERE latest.work_id = work.id
               ORDER BY latest.captured_at DESC
               LIMIT 1
             )
           ORDER BY work.updated_at DESC
           LIMIT ?`,
      )
      .all(limit) as SqlRow[];
    return rows.map((row) => ({
      workId: String(row.work_id),
      identifier: String(row.identifier),
    }));
  }

  async findExecutionAttachment(selector: string): Promise<ExecutionAttachmentTarget | undefined> {
    const rows = this.getDatabase()
      .prepare(
        `SELECT work.id AS work_id, work.issue_id, snapshot.snapshot_json, attempt.*
           FROM mastermind_work_items work
           JOIN mastermind_execution_attempts attempt
             ON attempt.id = COALESCE(
               work.current_execution_attempt_id,
               (
                 SELECT latest.id
                 FROM mastermind_execution_attempts latest
                 WHERE latest.work_id = work.id
                 ORDER BY latest.attempt_number DESC
                 LIMIT 1
               )
             )
           JOIN mastermind_ticket_snapshots snapshot
             ON snapshot.id = (
               SELECT latest_snapshot.id
               FROM mastermind_ticket_snapshots latest_snapshot
               WHERE latest_snapshot.work_id = work.id
               ORDER BY latest_snapshot.captured_at DESC
               LIMIT 1
             )
           WHERE lower(work.id) = lower(?)
              OR lower(work.issue_id) = lower(?)
              OR lower(attempt.id) = lower(?)
              OR lower(json_extract(snapshot.snapshot_json, '$.identifier')) = lower(?)
           ORDER BY attempt.attempt_number DESC
           LIMIT 2`,
      )
      .all(selector, selector, selector, selector) as SqlRow[];
    if (rows.length > 1) {
      throw new Error(`Mastermind attachment selector is ambiguous: ${selector}`);
    }

    const row = rows[0];
    if (!row) return undefined;
    const snapshot = JSON.parse(String(row.snapshot_json)) as LinearTicketSnapshot;
    return {
      workId: String(row.work_id),
      issueId: String(row.issue_id),
      ticketIdentifier: snapshot.identifier,
      attempt: toExecutionAttempt(row),
    };
  }

  async getCurrentCodeReview(workId: string): Promise<StoredCodeReview | undefined> {
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM mastermind_code_reviews
         WHERE work_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(workId) as SqlRow | undefined;
    return row ? toStoredCodeReview(row) : undefined;
  }

  async createCodeReview(
    input: Omit<StoredCodeReview, "id" | "status" | "createdAt" | "updatedAt">,
  ): Promise<StoredCodeReview> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.getDatabase()
      .prepare(
        `INSERT INTO mastermind_code_reviews
          (id, work_id, execution_attempt_id, commit_sha, result_hash, ticket_hash, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (execution_attempt_id, commit_sha, result_hash, ticket_hash) DO NOTHING`,
      )
      .run(
        id,
        input.workId,
        input.executionAttemptId,
        input.commitSha,
        input.resultHash,
        input.ticketHash,
        now,
        now,
      );
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM mastermind_code_reviews
         WHERE execution_attempt_id = ? AND commit_sha = ? AND result_hash = ? AND ticket_hash = ?`,
      )
      .get(input.executionAttemptId, input.commitSha, input.resultHash, input.ticketHash) as SqlRow;
    return toStoredCodeReview(row);
  }

  async saveCodeReview(input: {
    review: StoredCodeReview;
    status: StoredCodeReview["status"];
    dossier?: StoredCodeReview["dossier"];
    result?: StoredCodeReview["review"];
    projection?: ExecutionProjection;
  }): Promise<StoredCodeReview> {
    const now = new Date(
      Math.max(Date.now(), Date.parse(input.review.updatedAt) + 1),
    ).toISOString();
    const result = this.getDatabase()
      .prepare(
        `UPDATE mastermind_code_reviews
         SET status = ?, dossier_json = COALESCE(?, dossier_json),
             review_json = COALESCE(?, review_json),
             projection_json = COALESCE(?, projection_json), updated_at = ?
         WHERE id = ? AND updated_at = ?`,
      )
      .run(
        input.status,
        jsonOrNull(input.dossier),
        jsonOrNull(input.result),
        jsonOrNull(input.projection),
        now,
        input.review.id,
        input.review.updatedAt,
      );
    if (result.changes !== 1) throw new Error(`Stale code review ${input.review.id}.`);
    return (await this.getCurrentCodeReview(input.review.workId))!;
  }

  async transitionExecutionAttempt(input: {
    work: MastermindWorkItem;
    attempt: ExecutionAttempt;
    owner: string;
    event: MastermindEventRecord;
    patch?: ExecutionAttemptPatch;
  }): Promise<{ work: MastermindWorkItem; attempt: ExecutionAttempt }> {
    const database = this.getDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const patch = input.patch ?? {};
      const attemptResult = database
        .prepare(
          `UPDATE mastermind_execution_attempts
               SET state = ?,
                   workspace_json = COALESCE(?, workspace_json),
                   preflight_json = COALESCE(?, preflight_json),
                   executor_handle_json = COALESCE(?, executor_handle_json),
                   last_status_json = COALESCE(?, last_status_json),
                   result_json = COALESCE(?, result_json),
                   verification_json = COALESCE(?, verification_json),
                   failure_class = COALESCE(?, failure_class),
                   failure_message = COALESCE(?, failure_message),
                   retry_eligible = COALESCE(?, retry_eligible),
                   launched_at = COALESCE(?, launched_at),
                   terminal_at = COALESCE(?, terminal_at),
                   collected_at = COALESCE(?, collected_at),
                   row_version = row_version + 1,
                   updated_at = ?
               WHERE id = ? AND work_id = ? AND row_version = ? AND state = ?
                 AND EXISTS (
                   SELECT 1 FROM mastermind_work_items work
                   WHERE work.id = mastermind_execution_attempts.work_id
                     AND work.current_execution_attempt_id = mastermind_execution_attempts.id
                     AND work.lease_owner = ? AND work.lease_expires_at > ?
                     AND work.row_version = ? AND work.state = ?
                 )`,
        )
        .run(
          input.event.nextState,
          jsonOrNull(patch.workspace),
          jsonOrNull(patch.preflight),
          jsonOrNull(patch.executorHandle),
          jsonOrNull(patch.lastStatus),
          jsonOrNull(patch.result),
          jsonOrNull(patch.verification),
          patch.failureClass ?? null,
          patch.failureMessage ?? null,
          typeof patch.retryEligible === "boolean" ? Number(patch.retryEligible) : null,
          patch.launchedAt ?? null,
          patch.terminalAt ?? null,
          patch.collectedAt ?? null,
          now,
          input.attempt.id,
          input.work.id,
          input.attempt.rowVersion,
          input.event.priorState,
          input.owner,
          now,
          input.work.rowVersion,
          input.event.priorState,
        );
      if (attemptResult.changes !== 1) {
        throw new FencedExecutionError(
          input.work.id,
          input.attempt.id,
          `Stale execution attempt transition for ${input.attempt.id}.`,
        );
      }
      const workResult = database
        .prepare(
          `UPDATE mastermind_work_items
               SET state = ?, row_version = row_version + 1, updated_at = ?
               WHERE id = ? AND current_execution_attempt_id = ?
                 AND lease_owner = ? AND lease_expires_at > ?
                 AND row_version = ? AND state = ?`,
        )
        .run(
          input.event.nextState,
          now,
          input.work.id,
          input.attempt.id,
          input.owner,
          now,
          input.work.rowVersion,
          input.event.priorState,
        );
      if (workResult.changes !== 1) {
        throw new FencedExecutionError(
          input.work.id,
          input.attempt.id,
          `Execution work transition lost its fence for ${input.attempt.id}.`,
        );
      }
      this.insertEvent(database, {
        workId: input.work.id,
        eventType: input.event.eventType,
        priorState: input.event.priorState,
        nextState: input.event.nextState,
        metadata: { attemptId: input.attempt.id, ...input.event.metadata },
        createdAt: now,
      });
      database.exec("COMMIT");
      return {
        work: (await this.getWork(input.work.id))!,
        attempt: (await this.getExecutionAttempt(input.attempt.id))!,
      };
    } catch (error) {
      database.exec("ROLLBACK");
      if (error instanceof FencedExecutionError) {
        this.appendAuditEvent(input.work.id, "execution.fence_rejected", {
          attemptId: input.attempt.id,
          message: error.message,
        });
      }
      throw error;
    }
  }

  async saveExecutionProjection(input: {
    work: MastermindWorkItem;
    attempt: ExecutionAttempt;
    owner: string;
    projection: ExecutionProjection;
  }): Promise<ExecutionAttempt> {
    const now = new Date().toISOString();
    const result = this.getDatabase()
      .prepare(
        `UPDATE mastermind_execution_attempts
             SET projection_json = ?, row_version = row_version + 1, updated_at = ?
             WHERE id = ? AND work_id = ? AND row_version = ?
               AND EXISTS (
                 SELECT 1 FROM mastermind_work_items work
                 WHERE work.id = mastermind_execution_attempts.work_id
                   AND work.current_execution_attempt_id = mastermind_execution_attempts.id
                   AND work.lease_owner = ? AND work.lease_expires_at > ?
                   AND work.row_version = ?
               )`,
      )
      .run(
        JSON.stringify(input.projection),
        now,
        input.attempt.id,
        input.work.id,
        input.attempt.rowVersion,
        input.owner,
        now,
        input.work.rowVersion,
      );
    if (result.changes !== 1) {
      this.appendAuditEvent(input.work.id, "execution.projection_fence_rejected", {
        attemptId: input.attempt.id,
      });
      throw new FencedExecutionError(
        input.work.id,
        input.attempt.id,
        `Stale execution projection for ${input.attempt.id}.`,
      );
    }
    this.appendAuditEvent(input.work.id, `execution.projection_${input.projection.disposition}`, {
      attemptId: input.attempt.id,
      externalId: input.projection.externalId,
    });
    return (await this.getExecutionAttempt(input.attempt.id))!;
  }

  async patchExecutionAttempt(input: {
    work: MastermindWorkItem;
    attempt: ExecutionAttempt;
    owner: string;
    patch: ExecutionAttemptPatch;
    eventType: string;
  }): Promise<ExecutionAttempt> {
    const now = new Date().toISOString();
    const patch = input.patch;
    const result = this.getDatabase()
      .prepare(
        `UPDATE mastermind_execution_attempts
             SET workspace_json = COALESCE(?, workspace_json),
                 preflight_json = COALESCE(?, preflight_json),
                 executor_handle_json = COALESCE(?, executor_handle_json),
                 last_status_json = COALESCE(?, last_status_json),
                 result_json = COALESCE(?, result_json),
                 verification_json = COALESCE(?, verification_json),
                 failure_class = COALESCE(?, failure_class),
                 failure_message = COALESCE(?, failure_message),
                 retry_eligible = COALESCE(?, retry_eligible),
                 launched_at = COALESCE(?, launched_at),
                 terminal_at = COALESCE(?, terminal_at),
                 collected_at = COALESCE(?, collected_at),
                 row_version = row_version + 1,
                 updated_at = ?
             WHERE id = ? AND work_id = ? AND row_version = ? AND state = ?
               AND EXISTS (
                 SELECT 1 FROM mastermind_work_items work
                 WHERE work.id = mastermind_execution_attempts.work_id
                   AND work.current_execution_attempt_id = mastermind_execution_attempts.id
                   AND work.lease_owner = ? AND work.lease_expires_at > ?
                   AND work.row_version = ? AND work.state = mastermind_execution_attempts.state
               )`,
      )
      .run(
        jsonOrNull(patch.workspace),
        jsonOrNull(patch.preflight),
        jsonOrNull(patch.executorHandle),
        jsonOrNull(patch.lastStatus),
        jsonOrNull(patch.result),
        jsonOrNull(patch.verification),
        patch.failureClass ?? null,
        patch.failureMessage ?? null,
        typeof patch.retryEligible === "boolean" ? Number(patch.retryEligible) : null,
        patch.launchedAt ?? null,
        patch.terminalAt ?? null,
        patch.collectedAt ?? null,
        now,
        input.attempt.id,
        input.work.id,
        input.attempt.rowVersion,
        input.attempt.state,
        input.owner,
        now,
        input.work.rowVersion,
      );
    if (result.changes !== 1) {
      this.appendAuditEvent(input.work.id, "execution.fence_rejected", {
        attemptId: input.attempt.id,
        eventType: input.eventType,
      });
      throw new FencedExecutionError(
        input.work.id,
        input.attempt.id,
        `Stale execution attempt patch for ${input.attempt.id}.`,
      );
    }
    this.appendAuditEvent(input.work.id, input.eventType, {
      attemptId: input.attempt.id,
    });
    return (await this.getExecutionAttempt(input.attempt.id))!;
  }

  async listRecoverableExecutions(now: Date): Promise<RecoverableExecution[]> {
    const rows = this.getDatabase()
      .prepare(
        `SELECT work.id AS work_id, attempt.id AS attempt_id
             FROM mastermind_work_items work
             JOIN mastermind_execution_attempts attempt
               ON attempt.id = work.current_execution_attempt_id
             WHERE (
               attempt.state IN (?, ?, ?, ?, ?, ?)
               OR (
                 attempt.state = ?
                 AND work.state IN (?, ?, ?)
               )
               OR (
                 attempt.state IN (?, ?, ?)
                 AND (
                   attempt.projection_json IS NULL
                   OR json_extract(attempt.projection_json, '$.disposition') != 'applied'
                 )
               )
             )
               AND (work.lease_owner IS NULL OR work.lease_expires_at <= ?)
             ORDER BY attempt.created_at`,
      )
      .all(
        MastermindState.PROVISIONING,
        MastermindState.PREFLIGHTING,
        MastermindState.LAUNCHING,
        MastermindState.RUNNING,
        MastermindState.COLLECTING,
        MastermindState.RETRY_WAIT,
        MastermindState.SUCCEEDED,
        MastermindState.SUCCEEDED,
        MastermindState.CODE_REVIEW_PENDING,
        MastermindState.CODE_REVIEWING,
        MastermindState.SUCCEEDED,
        MastermindState.NEEDS_HUMAN,
        MastermindState.FAILED,
        now.toISOString(),
      ) as SqlRow[];
    return rows.map((row) => ({
      workId: String(row.work_id),
      attemptId: String(row.attempt_id),
    }));
  }

  async listLaunchableExecutionWorkIds(now: Date): Promise<string[]> {
    const rows = this.getDatabase()
      .prepare(
        `SELECT id
         FROM mastermind_work_items
         WHERE state = ? AND planned_action IN (?, ?) AND current_execution_attempt_id IS NULL
           AND (lease_owner IS NULL OR lease_expires_at <= ?)
         ORDER BY created_at`,
      )
      .all(
        MastermindState.ACTION_PLANNED,
        MastermindAction.IMPLEMENT_DIRECTLY,
        MastermindAction.DELEGATE_SUBMIND,
        now.toISOString(),
      ) as SqlRow[];
    return rows.map((row) => String(row.id));
  }

  async saveTicketSnapshot(workId: string, snapshot: LinearTicketSnapshot): Promise<void> {
    this.getDatabase()
      .prepare(
        `INSERT INTO mastermind_ticket_snapshots
          (id, work_id, snapshot_json, captured_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), workId, JSON.stringify(snapshot), new Date().toISOString());
  }

  async getLatestTicketSnapshot(workId: string): Promise<LinearTicketSnapshot | undefined> {
    const row = this.getDatabase()
      .prepare(
        `SELECT snapshot_json
         FROM mastermind_ticket_snapshots
         WHERE work_id = ?
         ORDER BY captured_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(workId) as SqlRow | undefined;
    return typeof row?.snapshot_json === "string"
      ? (JSON.parse(String(row.snapshot_json)) as LinearTicketSnapshot)
      : undefined;
  }

  async getLatestReview(workId: string): Promise<StoredReview | undefined> {
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM mastermind_reviews
         WHERE work_id = ? AND patch_json IS NOT NULL AND invalidated = 0
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(workId) as SqlRow | undefined;
    return row ? toStoredReview(row) : undefined;
  }

  async saveReviewProposal(
    workId: string,
    snapshot: LinearTicketSnapshot,
    originalContentHash: string,
    dossier: TicketReviewDossier,
    patch: ProposedLinearTicketPatch,
  ): Promise<StoredReview> {
    const existing = await this.getLatestReview(workId);
    if (existing && !existing.labelApplied) {
      return existing;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.getDatabase()
      .prepare(
        `INSERT INTO mastermind_reviews
          (id, work_id, original_snapshot_json, original_content_hash, dossier_json,
           patch_json, review_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workId,
        JSON.stringify(snapshot),
        originalContentHash,
        JSON.stringify(dossier),
        JSON.stringify(patch),
        JSON.stringify(patch),
        now,
        now,
      );
    this.appendAuditEvent(workId, "review.generated", { reviewId: id });
    return {
      id,
      workId,
      originalSnapshot: snapshot,
      originalContentHash,
      dossier,
      patch,
      contentApplied: false,
      labelApplied: false,
      invalidated: false,
    };
  }

  async saveReviewValidation(
    reviewId: string,
    validation: TicketReviewValidationRecord,
  ): Promise<void> {
    const database = this.getDatabase();
    const review = database
      .prepare("SELECT work_id FROM mastermind_reviews WHERE id = ?")
      .get(reviewId) as SqlRow | undefined;
    const result = database
      .prepare(
        `UPDATE mastermind_reviews
         SET validation_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(validation), new Date().toISOString(), reviewId);
    if (!review || result.changes !== 1) {
      throw new Error(`Mastermind review not found for validation: ${reviewId}`);
    }
    this.appendAuditEvent(String(review.work_id), "review.validated", {
      reviewId,
      ...validation,
    });
  }

  async markReviewContentApplied(reviewId: string): Promise<void> {
    const database = this.getDatabase();
    const review = database
      .prepare("SELECT work_id FROM mastermind_reviews WHERE id = ?")
      .get(reviewId) as SqlRow | undefined;
    const result = database
      .prepare(
        `UPDATE mastermind_reviews
         SET content_applied = 1, updated_at = ?
         WHERE id = ? AND content_applied = 0`,
      )
      .run(new Date().toISOString(), reviewId);
    if (review && result.changes > 0) {
      this.appendAuditEvent(String(review.work_id), "review.content_applied", {
        reviewId,
      });
    }
  }

  async markReviewLabelApplied(reviewId: string): Promise<void> {
    const database = this.getDatabase();
    const review = database
      .prepare("SELECT work_id FROM mastermind_reviews WHERE id = ?")
      .get(reviewId) as SqlRow | undefined;
    const result = database
      .prepare(
        `UPDATE mastermind_reviews
         SET label_applied = 1, updated_at = ?
         WHERE id = ? AND label_applied = 0`,
      )
      .run(new Date().toISOString(), reviewId);
    if (review && result.changes > 0) {
      this.appendAuditEvent(String(review.work_id), "review.label_applied", {
        reviewId,
      });
    }
  }

  async saveReviewAppliedSnapshot(reviewId: string, snapshot: LinearTicketSnapshot): Promise<void> {
    const result = this.getDatabase()
      .prepare(
        `UPDATE mastermind_reviews
         SET applied_snapshot_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(snapshot), new Date().toISOString(), reviewId);
    if (result.changes !== 1) {
      throw new Error(`Mastermind review not found for applied snapshot: ${reviewId}`);
    }
  }

  async invalidateReview(reviewId: string, reason: string): Promise<void> {
    const database = this.getDatabase();
    const review = database
      .prepare("SELECT work_id FROM mastermind_reviews WHERE id = ?")
      .get(reviewId) as SqlRow | undefined;
    const result = database
      .prepare(
        `UPDATE mastermind_reviews
         SET invalidated = 1, invalidation_reason = ?, updated_at = ?
         WHERE id = ? AND invalidated = 0`,
      )
      .run(reason, new Date().toISOString(), reviewId);
    if (!review) {
      throw new Error(`Mastermind review not found for invalidation: ${reviewId}`);
    }
    if (result.changes > 0) {
      this.appendAuditEvent(String(review.work_id), "review.invalidated", {
        reviewId,
        reason,
      });
    }
  }

  async saveDecision(workId: string, decision: MastermindNextActionDecision): Promise<void> {
    this.getDatabase()
      .prepare(
        `INSERT INTO mastermind_action_decisions
          (id, work_id, decision_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), workId, JSON.stringify(decision), new Date().toISOString());
    this.appendAuditEvent(workId, "decision.recorded", {
      action: decision.action,
      confidence: decision.confidence,
    });
  }

  async getLatestDecision(workId: string): Promise<MastermindNextActionDecision | undefined> {
    const row = this.getDatabase()
      .prepare(
        `SELECT decision_json
         FROM mastermind_action_decisions
         WHERE work_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(workId) as SqlRow | undefined;
    return typeof row?.decision_json === "string"
      ? (JSON.parse(row.decision_json) as MastermindNextActionDecision)
      : undefined;
  }

  async setProjectPolicy(
    workId: string,
    projectPolicyId: string,
    resolvedProject?: ProjectCatalogEntry,
  ): Promise<void> {
    this.getDatabase()
      .prepare(
        `UPDATE mastermind_work_items
         SET project_policy_id = ?, resolved_project_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        projectPolicyId,
        resolvedProject ? JSON.stringify(resolvedProject) : null,
        new Date().toISOString(),
        workId,
      );
  }

  async listRecoverableWorkIds(now: Date): Promise<string[]> {
    const rows = this.getDatabase()
      .prepare(
        `SELECT id FROM mastermind_work_items
         WHERE state NOT IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           AND NOT (state = ? AND current_execution_attempt_id IS NOT NULL)
           AND (lease_owner IS NULL OR lease_expires_at <= ?)
         ORDER BY created_at`,
      )
      .all(
        MastermindState.ACTION_PLANNED,
        MastermindState.NEEDS_HUMAN,
        MastermindState.IGNORED,
        MastermindState.FAILED,
        MastermindState.PROVISIONING,
        MastermindState.PREFLIGHTING,
        MastermindState.LAUNCHING,
        MastermindState.RUNNING,
        MastermindState.COLLECTING,
        MastermindState.SUCCEEDED,
        MastermindState.RETRY_WAIT,
        now.toISOString(),
      ) as SqlRow[];
    return rows.map((row) => String(row.id));
  }

  async listTerminalWorkIdsForFreshnessScan(
    now: Date,
    page: {
      limit: number;
      cursor?: TerminalWorkFreshnessScanCursor;
    },
  ): Promise<TerminalWorkFreshnessScanPage> {
    const boundedLimit = Math.max(1, page.limit);
    const queryLimit = boundedLimit + 1;
    const rows = (
      page.cursor
        ? this.getDatabase()
            .prepare(
              `SELECT id, updated_at, created_at
               FROM mastermind_work_items
               WHERE state IN (?, ?, ?, ?)
                 AND (lease_owner IS NULL OR lease_expires_at <= ?)
                 AND (
                   updated_at > ?
                   OR (updated_at = ? AND created_at > ?)
                   OR (updated_at = ? AND created_at = ? AND id > ?)
                 )
               ORDER BY updated_at, created_at, id
               LIMIT ?`,
            )
            .all(
              MastermindState.ACTION_PLANNED,
              MastermindState.NEEDS_HUMAN,
              MastermindState.FAILED,
              MastermindState.SUCCEEDED,
              now.toISOString(),
              page.cursor.updatedAt,
              page.cursor.updatedAt,
              page.cursor.createdAt,
              page.cursor.updatedAt,
              page.cursor.createdAt,
              page.cursor.workId,
              queryLimit,
            )
        : this.getDatabase()
            .prepare(
              `SELECT id, updated_at, created_at
               FROM mastermind_work_items
               WHERE state IN (?, ?, ?, ?)
                 AND (lease_owner IS NULL OR lease_expires_at <= ?)
               ORDER BY updated_at, created_at, id
               LIMIT ?`,
            )
            .all(
              MastermindState.ACTION_PLANNED,
              MastermindState.NEEDS_HUMAN,
              MastermindState.FAILED,
              MastermindState.SUCCEEDED,
              now.toISOString(),
              queryLimit,
            )
    ) as SqlRow[];
    const pageRows = rows.slice(0, boundedLimit);
    const lastRow = pageRows.at(-1);
    return {
      workIds: pageRows.map((row) => String(row.id)),
      ...(rows.length > boundedLimit && lastRow
        ? {
            nextCursor: {
              updatedAt: String(lastRow.updated_at),
              createdAt: String(lastRow.created_at),
              workId: String(lastRow.id),
            },
          }
        : {}),
    };
  }

  async listEvents(workId: string): Promise<Array<Record<string, unknown>>> {
    const rows = this.getDatabase()
      .prepare(
        `SELECT event_type, prior_state, next_state, metadata_json, created_at
         FROM mastermind_events
         WHERE work_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(workId) as SqlRow[];
    return rows.map((row) => ({
      eventType: row.event_type,
      priorState: row.prior_state,
      nextState: row.next_state,
      metadata: typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
    }));
  }

  private getDatabase(): DatabaseSync {
    if (!this.database) {
      throw new Error("Mastermind store is not initialized.");
    }
    return this.database;
  }

  private appendAuditEvent(
    workId: string,
    eventType: string,
    metadata?: Record<string, unknown>,
  ): void {
    const database = this.getDatabase();
    const work = database
      .prepare("SELECT state FROM mastermind_work_items WHERE id = ?")
      .get(workId) as SqlRow | undefined;
    if (!work) {
      throw new Error(`Cannot append Mastermind audit event for missing work: ${workId}`);
    }
    const state = String(work.state);
    database
      .prepare(
        `INSERT INTO mastermind_events
          (id, work_id, event_type, prior_state, next_state, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        workId,
        eventType,
        state,
        state,
        metadata ? JSON.stringify(metadata) : null,
        new Date().toISOString(),
      );
  }

  private insertEvent(
    database: DatabaseSync,
    input: {
      workId: string;
      eventType: string;
      priorState: string;
      nextState: string;
      metadata?: Record<string, unknown>;
      createdAt: string;
    },
  ): void {
    database
      .prepare(
        `INSERT INTO mastermind_events
          (id, work_id, event_type, prior_state, next_state, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.workId,
        input.eventType,
        input.priorState,
        input.nextState,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.createdAt,
      );
  }
}

function toWorkItem(row: SqlRow): MastermindWorkItem {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    issueId: String(row.issue_id),
    projectPolicyId: typeof row.project_policy_id === "string" ? row.project_policy_id : undefined,
    resolvedProject:
      typeof row.resolved_project_json === "string"
        ? (JSON.parse(row.resolved_project_json) as ProjectCatalogEntry)
        : undefined,
    state: String(row.state) as MastermindWorkItem["state"],
    plannedAction:
      typeof row.planned_action === "string" ? (row.planned_action as MastermindAction) : undefined,
    currentExecutionAttemptId:
      typeof row.current_execution_attempt_id === "string"
        ? row.current_execution_attempt_id
        : undefined,
    leaseOwner: typeof row.lease_owner === "string" ? row.lease_owner : undefined,
    leaseExpiresAt: typeof row.lease_expires_at === "string" ? row.lease_expires_at : undefined,
    retryCount: Number(row.retry_count),
    rowVersion: Number(row.row_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toExecutionAttempt(row: SqlRow): ExecutionAttempt {
  return {
    id: String(row.id),
    workId: String(row.work_id),
    attemptNumber: Number(row.attempt_number),
    action: String(row.action) as MastermindAction,
    projectPolicyId: String(row.project_policy_id),
    projectPolicyVersion: String(row.project_policy_version),
    executorKind: String(row.executor_kind) as ExecutionAttempt["executorKind"],
    state: String(row.state) as ExecutionAttempt["state"],
    ...(parseOptionalJson(row.workspace_json, "workspace") as Pick<ExecutionAttempt, "workspace">),
    ...(parseOptionalJson(row.preflight_json, "preflight") as Pick<ExecutionAttempt, "preflight">),
    ...(parseOptionalJson(row.executor_handle_json, "executorHandle") as Pick<
      ExecutionAttempt,
      "executorHandle"
    >),
    ...(parseOptionalJson(row.last_status_json, "lastStatus") as Pick<
      ExecutionAttempt,
      "lastStatus"
    >),
    ...(parseOptionalJson(row.result_json, "result") as Pick<ExecutionAttempt, "result">),
    ...(parseOptionalJson(row.verification_json, "verification") as Pick<
      ExecutionAttempt,
      "verification"
    >),
    failureClass: typeof row.failure_class === "string" ? row.failure_class : undefined,
    failureMessage: typeof row.failure_message === "string" ? row.failure_message : undefined,
    retryEligible: Number(row.retry_eligible) === 1,
    ...(parseOptionalJson(row.projection_json, "projection") as Pick<
      ExecutionAttempt,
      "projection"
    >),
    rowVersion: Number(row.row_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    launchedAt: typeof row.launched_at === "string" ? row.launched_at : undefined,
    terminalAt: typeof row.terminal_at === "string" ? row.terminal_at : undefined,
    collectedAt: typeof row.collected_at === "string" ? row.collected_at : undefined,
  };
}

function toStoredCodeReview(row: SqlRow): StoredCodeReview {
  return {
    id: String(row.id),
    workId: String(row.work_id),
    executionAttemptId: String(row.execution_attempt_id),
    commitSha: String(row.commit_sha),
    resultHash: String(row.result_hash),
    ticketHash: String(row.ticket_hash),
    status: String(row.status) as StoredCodeReview["status"],
    ...(parseOptionalJson(row.dossier_json, "dossier") as Pick<StoredCodeReview, "dossier">),
    ...(parseOptionalJson(row.review_json, "review") as Pick<StoredCodeReview, "review">),
    ...(parseOptionalJson(row.projection_json, "projection") as Pick<
      StoredCodeReview,
      "projection"
    >),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseOptionalJson(value: unknown, key: string): Record<string, unknown> {
  return typeof value === "string" ? { [key]: JSON.parse(value) } : {};
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export class FencedExecutionError extends Error {
  constructor(
    readonly workId: string,
    readonly attemptId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "FencedExecutionError";
  }
}

function toStoredReview(row: SqlRow): StoredReview {
  const parsedPatch = parseStoredReviewPatch(String(row.patch_json));
  return {
    id: String(row.id),
    workId: String(row.work_id),
    originalSnapshot: JSON.parse(String(row.original_snapshot_json)) as LinearTicketSnapshot,
    originalContentHash: String(row.original_content_hash),
    dossier: JSON.parse(String(row.dossier_json)) as TicketReviewDossier,
    patch: parsedPatch.patch,
    legacyOpenItemDispositionsMissing: parsedPatch.legacyOpenItemDispositionsMissing,
    validation:
      typeof row.validation_json === "string"
        ? (JSON.parse(row.validation_json) as TicketReviewValidationRecord)
        : undefined,
    appliedSnapshot:
      typeof row.applied_snapshot_json === "string"
        ? (JSON.parse(row.applied_snapshot_json) as LinearTicketSnapshot)
        : undefined,
    contentApplied: Number(row.content_applied) === 1,
    labelApplied: Number(row.label_applied) === 1,
    invalidated: Number(row.invalidated) === 1,
    invalidationReason:
      typeof row.invalidation_reason === "string" ? row.invalidation_reason : undefined,
  };
}

function ensureColumn(database: DatabaseSync, table: string, column: string, type: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
  if (!columns.some((entry) => entry.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

const storedPatchStringArrayFields = [
  "acceptanceCriteria",
  "assumptions",
  "ambiguities",
  "unansweredQuestions",
  "dependencies",
  "risks",
  "automatedVerification",
  "manualVerification",
  "validationSteps",
  "observability",
  "rolloutPlan",
  "rollbackPlan",
  "outOfScope",
  "blockingReasons",
  "warnings",
] as const satisfies ReadonlyArray<keyof ProposedLinearTicketPatch>;

function parseStoredReviewPatch(patchJson: string): {
  patch: ProposedLinearTicketPatch;
  legacyOpenItemDispositionsMissing: boolean;
} {
  const rawPatch = JSON.parse(patchJson) as Record<string, unknown>;
  const patch = { ...rawPatch } as Record<string, unknown>;

  for (const field of storedPatchStringArrayFields) {
    patch[field] = toStringArray(rawPatch[field]);
  }
  patch.openItemDispositions = normalizeStoredOpenItemDispositions(rawPatch.openItemDispositions);
  patch.evidence = Array.isArray(rawPatch.evidence) ? rawPatch.evidence : [];

  return {
    patch: patch as unknown as ProposedLinearTicketPatch,
    legacyOpenItemDispositionsMissing: !Object.prototype.hasOwnProperty.call(
      rawPatch,
      "openItemDispositions",
    ),
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => (typeof entry === "string" ? [entry] : []));
}

function normalizeStoredOpenItemDispositions(value: unknown): ReviewOpenItemDisposition[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const owner = toReviewOpenItemOwner(record.owner);
    const rationale = typeof record.rationale === "string" ? record.rationale : "";
    const text =
      typeof record.text === "string"
        ? record.text
        : typeof record.item === "string"
          ? record.item
          : undefined;
    const kind = toReviewOpenItemKind(record.kind, record.item);
    if (!owner || !text || !kind) {
      return [];
    }
    return [{ kind, text, owner, rationale }];
  });
}

function toReviewOpenItemOwner(value: unknown): ReviewOpenItemOwner | undefined {
  return typeof value === "string" ? (value as ReviewOpenItemOwner) : undefined;
}

function toReviewOpenItemKind(
  value: unknown,
  legacyItemValue: unknown,
): ReviewOpenItemKind | undefined {
  if (typeof value === "string") {
    return value as ReviewOpenItemKind;
  }
  return typeof legacyItemValue === "string"
    ? ("UNANSWERED_QUESTION" as ReviewOpenItemKind)
    : undefined;
}
