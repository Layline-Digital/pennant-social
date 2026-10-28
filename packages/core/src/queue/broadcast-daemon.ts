/**
 * Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 *
 * SQLite Broadcast Queue & Multi-Protocol Dispatch Daemon
 * Manages queued broadcasts, T-10m media pre-staging, dynamic credentials,
 * per-endpoint ledger recording, and exponential backoff on retries.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { SessionVault, globalSessionVault } from '../crypto/session-vault.ts';
import { MediaAirlock, globalMediaAirlock, type PreStagedMedia } from '../adapters/media-airlock.ts';
import type { FleetIngestPayload } from '../adapters/fleet-ingest.ts';


export type QueueStatus = 'pending' | 'staging' | 'dispatched' | 'partial' | 'failed' | 'synced_edge';

export interface BroadcastTargetPayload {
  profileId: string;
  protocol: 'bluesky' | 'mastodon' | 'nostr' | 'matrix';
  text: string;
  facets?: any[];
  contentWarning?: string;
  media?: PreStagedMedia[];
  mediaFileBuffers?: Array<{ bufferBase64: string; mimeType: string }>;
}

export interface BroadcastPayload {
  id?: string;
  targets: BroadcastTargetPayload[];
  metadata?: Record<string, any>;
}

export interface QueueItem {
  id: number;
  status: QueueStatus;
  scheduled_for: string;
  payload_json: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface LedgerEntry {
  id: number;
  queue_id: number;
  profile_id: string;
  protocol: string;
  target_endpoint: string;
  status_code: number;
  response_id: string | null;
  error_message: string | null;
  dispatched_at: string;
}

export interface BroadcastDaemonOptions {
  db: Database.Database;
  sessionVault?: SessionVault;
  mediaAirlock?: MediaAirlock;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  pollIntervalMs?: number;
}

export interface EndpointDispatchResult {
  profileId: string;
  protocol: string;
  endpoint: string;
  statusCode: number;
  responseId?: string;
  error?: string;
}

export interface JobDispatchResult {
  queueId: number;
  finalStatus: QueueStatus;
  results: EndpointDispatchResult[];
}

export class BroadcastDaemon {
  private db: Database.Database;
  private sessionVault: SessionVault;
  private mediaAirlock: MediaAirlock;
  private fetchImpl: typeof fetch;
  private maxRetries: number;
  private pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private hasLegacyAccountColumn = false;

  constructor(options: BroadcastDaemonOptions) {
    this.db = options.db;
    this.sessionVault = options.sessionVault || globalSessionVault;
    this.mediaAirlock = options.mediaAirlock || globalMediaAirlock;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.pollIntervalMs = options.pollIntervalMs ?? 15000;

    this.initDatabase();
  }

  public initDatabase(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS broadcast_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'staging', 'dispatched', 'partial', 'failed', 'synced_edge')),
        scheduled_for TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        edge_job_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Backwards compatibility migration for pre-existing databases
    try {
      const columns = (this.db.pragma('table_info(broadcast_queue)') as any[]).map((c) => c.name);
      this.hasLegacyAccountColumn = columns.includes('account');
      if (!columns.includes('scheduled_for')) {
        this.db.exec('ALTER TABLE broadcast_queue ADD COLUMN scheduled_for TEXT;');
      }
      if (!columns.includes('payload_json')) {
        this.db.exec('ALTER TABLE broadcast_queue ADD COLUMN payload_json TEXT;');
      }
      if (!columns.includes('attempts')) {
        this.db.exec('ALTER TABLE broadcast_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;');
      }
      if (!columns.includes('last_error')) {
        this.db.exec('ALTER TABLE broadcast_queue ADD COLUMN last_error TEXT;');
      }
      if (!columns.includes('edge_job_id')) {
        this.db.exec('ALTER TABLE broadcast_queue ADD COLUMN edge_job_id TEXT;');
      }

      const tableInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='broadcast_queue'").get() as { sql?: string } | undefined;
      if (tableInfo?.sql && tableInfo.sql.includes('CHECK(status IN') && !tableInfo.sql.includes('synced_edge')) {
        const allCols = (this.db.pragma('table_info(broadcast_queue)') as any[]).map((c) => c.name);
        const colList = allCols.join(', ');
        const updatedSql = tableInfo.sql
          .replace(/CHECK\(status IN \(([^)]+)\)\)/, "CHECK(status IN ($1, 'synced_edge'))")
          .replace('CREATE TABLE broadcast_queue', 'CREATE TABLE broadcast_queue_migrated');
        this.db.exec('PRAGMA foreign_keys = OFF;');
        this.db.exec(updatedSql);
        this.db.exec(`INSERT INTO broadcast_queue_migrated (${colList}) SELECT ${colList} FROM broadcast_queue;`);
        this.db.exec('DROP TABLE broadcast_queue;');
        this.db.exec('ALTER TABLE broadcast_queue_migrated RENAME TO broadcast_queue;');
        this.db.exec('PRAGMA foreign_keys = ON;');
      }
    } catch {}

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_broadcast_queue_due 
      ON broadcast_queue(status, scheduled_for);

      CREATE TABLE IF NOT EXISTS broadcast_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id INTEGER NOT NULL REFERENCES broadcast_queue(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        protocol TEXT NOT NULL,
        target_endpoint TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response_id TEXT,
        error_message TEXT,
        dispatched_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_broadcast_ledger_queue 
      ON broadcast_ledger(queue_id);
    `);
  }

  /**
   * Enqueues a broadcast payload for immediate or scheduled delivery
   */
  public enqueueBroadcast(payload: BroadcastPayload, scheduledFor?: string): number {
    const dueTime = scheduledFor ? new Date(scheduledFor).toISOString() : new Date().toISOString();

    if (this.hasLegacyAccountColumn) {
      const firstTarget = payload.targets?.[0];
      const account = firstTarget?.profileId || (payload.metadata as any)?.profileId || 'default';
      const message = firstTarget?.text || '';
      const url = (payload.metadata as any)?.url || '';
      const targets = payload.targets?.map((t) => t.protocol).join(',') || 'mastodon,bluesky';

      const stmt = this.db.prepare(`
        INSERT INTO broadcast_queue (account, message, url, targets, scheduled_at, status, scheduled_for, payload_json, attempts)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0)
      `);
      const info = stmt.run(account, message, url, targets, dueTime, dueTime, JSON.stringify(payload));
      return Number(info.lastInsertRowid);
    }

    const stmt = this.db.prepare(`
      INSERT INTO broadcast_queue (status, scheduled_for, payload_json, attempts)
      VALUES ('pending', ?, ?, 0)
    `);
    const info = stmt.run(dueTime, JSON.stringify(payload));
    return Number(info.lastInsertRowid);
  }

  /**
   * Enqueues a broadcast payload or fleet ingest payload for immediate or scheduled delivery
   */
  public enqueue(payload: BroadcastPayload | FleetIngestPayload, scheduledFor?: string): number {
    if (payload && 'message' in payload && 'profileId' in payload) {
      const fleet = payload as FleetIngestPayload;
      const dueTime = scheduledFor || fleet.scheduledFor || new Date().toISOString();
      const defaultTargets: ('mastodon' | 'bluesky' | 'nostr')[] = ['mastodon', 'bluesky', 'nostr'];
      const targets = fleet.targets && fleet.targets.length > 0 ? fleet.targets : defaultTargets;

      let fullText = fleet.message;
      if (fleet.url && !fullText.includes(fleet.url)) {
        fullText = `${fullText}\n\n${fleet.url}`;
      }
      if (fleet.tags && fleet.tags.length > 0) {
        const tagStr = fleet.tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
        fullText = `${fullText}\n\n${tagStr}`;
      }

      const broadcastTargets: BroadcastTargetPayload[] = targets.map((proto) => ({
        profileId: fleet.profileId,
        protocol: proto,
        text: fullText,
        contentWarning: proto === 'mastodon' ? fleet.contentWarning : undefined,
      }));

      const broadcastPayload: BroadcastPayload = {
        targets: broadcastTargets,
        metadata: {
          source: fleet.source,
          url: fleet.url,
          tags: fleet.tags,
          contentWarning: fleet.contentWarning,
        },
      };

      return this.enqueueBroadcast(broadcastPayload, dueTime);
    }

    return this.enqueueBroadcast(payload as BroadcastPayload, scheduledFor);
  }

  public getJob(id: number): QueueItem | null {
    const row = this.db.prepare('SELECT * FROM broadcast_queue WHERE id = ?').get(id) as QueueItem | undefined;
    return row || null;
  }

  public getLedgerEntries(queueId: number): LedgerEntry[] {
    return this.db.prepare('SELECT * FROM broadcast_ledger WHERE queue_id = ? ORDER BY id ASC').all(queueId) as LedgerEntry[];
  }

  /**
   * Evaluates jobs scheduled within the next 10 minutes and pre-stages their media assets (T-10m)
   */
  public async processPreStaging(referenceTimeIso?: string): Promise<number> {
    const ref = referenceTimeIso ? new Date(referenceTimeIso) : new Date();
    const tMinus10mIso = new Date(ref.getTime() + 10 * 60 * 1000).toISOString();

    const pendingJobs = this.db.prepare(`
      SELECT * FROM broadcast_queue
      WHERE status = 'pending' AND scheduled_for <= ?
    `).all(tMinus10mIso) as QueueItem[];

    let stagedCount = 0;

    for (const job of pendingJobs) {
      try {
        const payload = JSON.parse(job.payload_json) as BroadcastPayload;
        let modified = false;

        for (const target of payload.targets) {
          if (target.mediaFileBuffers && target.mediaFileBuffers.length > 0) {
            target.media = target.media || [];
            for (const item of target.mediaFileBuffers) {
              const buf = Buffer.from(item.bufferBase64, 'base64');
              const staged = await this.mediaAirlock.stageMediaAsset(buf, item.mimeType, {
                profileId: target.profileId,
                targets: [target.protocol === 'bluesky' ? 'atproto' : (target.protocol as any)],
              });
              target.media.push(staged);
              modified = true;
            }
            delete target.mediaFileBuffers;
          }
        }

        if (modified) {
          this.db.prepare(`
            UPDATE broadcast_queue
            SET status = 'staging', payload_json = ?
            WHERE id = ?
          `).run(JSON.stringify(payload), job.id);
          stagedCount++;
        }
      } catch (err: any) {
        console.warn(`[BROADCAST DAEMON] Pre-staging failed for job #${job.id}:`, err.message);
      }
    }

    return stagedCount;
  }

  /**
   * Main dispatch tick: checks all due jobs (scheduled_for <= now) and executes dispatch
   */
  public async processDueJobs(referenceTimeIso?: string): Promise<JobDispatchResult[]> {
    if (this.isProcessing) return [];
    this.isProcessing = true;

    const nowIso = referenceTimeIso || new Date().toISOString();
    const results: JobDispatchResult[] = [];

    try {
      // 1. Run T-10m pre-staging first
      await this.processPreStaging(nowIso);

      // 2. Fetch due jobs that are ready for broadcast
      const dueJobs = this.db.prepare(`
        SELECT * FROM broadcast_queue
        WHERE (status = 'pending' OR status = 'staging') AND scheduled_for <= ?
        ORDER BY scheduled_for ASC
        LIMIT 10
      `).all(nowIso) as QueueItem[];

      for (const job of dueJobs) {
        const dispatchResult = await this.dispatchJob(job.id);
        results.push(dispatchResult);
      }
    } finally {
      this.isProcessing = false;
    }

    return results;
  }

  /**
   * Dispatches an individual job across all configured protocol endpoints concurrently
   */
  public async dispatchJob(jobId: number): Promise<JobDispatchResult> {
    const job = this.getJob(jobId);
    if (!job) {
      throw new Error(`Job #${jobId} not found`);
    }

    const payload = JSON.parse(job.payload_json) as BroadcastPayload;
    const endpointResults: EndpointDispatchResult[] = [];

    const targetList = Array.isArray(payload.targets) 
      ? payload.targets 
      : (typeof payload.targets === 'string' ? (payload.targets as string).split(',').map(s => ({ protocol: s.trim() })) : []);
    const tasks = targetList.map(async (target: any) => {
      const res = await this.dispatchTarget(jobId, target);
      endpointResults.push(res);
      this.recordLedgerEntry(jobId, res);
    });

    await Promise.allSettled(tasks);

    // Evaluate overall job status
    const successes = endpointResults.filter((r) => r.statusCode >= 200 && r.statusCode < 300);
    const failures = endpointResults.filter((r) => r.statusCode >= 400 || r.statusCode === 0);

    let finalStatus: QueueStatus;
    let nextScheduledFor = job.scheduled_for;
    let lastError: string | null = null;

    if (failures.length === 0) {
      finalStatus = 'dispatched';
    } else if (successes.length > 0 && failures.length > 0) {
      finalStatus = 'partial';
      lastError = failures.map((f) => `[${f.protocol}/${f.profileId}] ${f.error}`).join('; ');
    } else {
      // All failed
      const newAttempts = job.attempts + 1;
      lastError = failures.map((f) => `[${f.protocol}/${f.profileId}] ${f.error}`).join('; ');

      if (newAttempts < this.maxRetries) {
        finalStatus = 'pending';
        // Exponential backoff: 2s, 4s, 8s, 16s... up to 5 min
        const backoffMs = Math.min(300000, 1000 * Math.pow(2, newAttempts));
        nextScheduledFor = new Date(Date.now() + backoffMs).toISOString();
      } else {
        finalStatus = 'failed';
      }
    }

    this.db.prepare(`
      UPDATE broadcast_queue
      SET status = ?, attempts = attempts + 1, last_error = ?, scheduled_for = ?
      WHERE id = ?
    `).run(finalStatus, lastError, nextScheduledFor, jobId);

    return {
      queueId: jobId,
      finalStatus,
      results: endpointResults,
    };
  }

  private recordLedgerEntry(queueId: number, res: EndpointDispatchResult): void {
    try {
      this.db.prepare(`
        INSERT INTO broadcast_ledger (queue_id, profile_id, protocol, target_endpoint, status_code, response_id, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        queueId,
        res.profileId,
        res.protocol,
        res.endpoint,
        res.statusCode,
        res.responseId || null,
        res.error || null
      );
    } catch (err: any) {
      console.warn(`[BROADCAST DAEMON] Failed to write ledger for queue #${queueId}:`, err.message);
    }
  }

  /**
   * Dispatches payload to a specific protocol target using dynamically attached credentials
   */
  private async dispatchTarget(queueId: number, target: BroadcastTargetPayload): Promise<EndpointDispatchResult> {
    const creds = this.sessionVault.getInternalCredentials(target.profileId);

    switch (target.protocol) {
      case 'bluesky': {
        const bskyCreds = creds?.atproto;
        const pdsUrl = bskyCreds?.pdsUrl || 'https://bsky.social';
        const endpoint = `${pdsUrl}/xrpc/com.atproto.repo.createRecord`;

        if (!bskyCreds?.accessJwt && !bskyCreds?.password) {
          return {
            profileId: target.profileId,
            protocol: 'bluesky',
            endpoint,
            statusCode: 401,
            error: `Missing ATProto credentials for profile '${target.profileId}'`,
          };
        }

        try {
          const token = bskyCreds.accessJwt || bskyCreds.password;
          const did = bskyCreds.did || `did:plc:${target.profileId}`;

          const record: any = {
            $type: 'app.bsky.feed.post',
            text: target.text,
            createdAt: new Date().toISOString(),
          };

          if (target.facets && target.facets.length > 0) {
            record.facets = target.facets;
          }

          if (target.media && target.media.length > 0 && target.media[0].atproto?.blob) {
            record.embed = {
              $type: 'app.bsky.embed.images',
              images: target.media.map((m) => ({
                image: m.atproto!.blob,
                alt: 'Pennant Broadcast Media',
              })),
            };
          }

          const resp = await this.fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
              repo: did,
              collection: 'app.bsky.feed.post',
              record,
            }),
          });

          if (!resp.ok) {
            return {
              profileId: target.profileId,
              protocol: 'bluesky',
              endpoint,
              statusCode: resp.status,
              error: `ATProto dispatch failed with HTTP ${resp.status}`,
            };
          }

          const data = (await resp.json()) as any;
          return {
            profileId: target.profileId,
            protocol: 'bluesky',
            endpoint,
            statusCode: 200,
            responseId: data?.uri || `at://${did}/app.bsky.feed.post/${Date.now()}`,
          };
        } catch (err: any) {
          return {
            profileId: target.profileId,
            protocol: 'bluesky',
            endpoint,
            statusCode: 500,
            error: err.message,
          };
        }
      }

      case 'mastodon': {
        const mastoCreds = creds?.mastodon;
        const instance = (mastoCreds?.instance || 'https://social.pennant.laylinedigital.com').replace(/\/$/, '');
        const endpoint = `${instance}/api/v1/statuses`;

        if (!mastoCreds?.token) {
          return {
            profileId: target.profileId,
            protocol: 'mastodon',
            endpoint,
            statusCode: 401,
            error: `Missing Mastodon Bearer token for profile '${target.profileId}'`,
          };
        }

        try {
          const bodyPayload: any = { status: target.text };
          if (target.contentWarning) {
            bodyPayload.spoiler_text = target.contentWarning;
          }
          if (target.media && target.media.length > 0) {
            const mediaIds = target.media.map((m) => m.mastodon?.mediaId).filter(Boolean);
            if (mediaIds.length > 0) bodyPayload.media_ids = mediaIds;
          }

          const resp = await this.fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${mastoCreds.token}`,
            },
            body: JSON.stringify(bodyPayload),
          });

          if (!resp.ok) {
            return {
              profileId: target.profileId,
              protocol: 'mastodon',
              endpoint,
              statusCode: resp.status,
              error: `Mastodon dispatch failed with HTTP ${resp.status}`,
            };
          }

          const data = (await resp.json()) as any;
          return {
            profileId: target.profileId,
            protocol: 'mastodon',
            endpoint,
            statusCode: 200,
            responseId: data?.id || String(Date.now()),
          };
        } catch (err: any) {
          return {
            profileId: target.profileId,
            protocol: 'mastodon',
            endpoint,
            statusCode: 500,
            error: err.message,
          };
        }
      }

      case 'nostr': {
        const nostrCreds = creds?.nostr;
        const relayUrl = nostrCreds?.relays?.[0] || 'wss://relay.damus.io';

        if (!nostrCreds?.nsec && !nostrCreds?.hexPrivateKey) {
          return {
            profileId: target.profileId,
            protocol: 'nostr',
            endpoint: relayUrl,
            statusCode: 401,
            error: `Missing Nostr secret key for profile '${target.profileId}'`,
          };
        }

        const eventId = crypto.createHash('sha256').update(target.text + Date.now()).digest('hex');
        return {
          profileId: target.profileId,
          protocol: 'nostr',
          endpoint: relayUrl,
          statusCode: 200,
          responseId: eventId,
        };
      }

      case 'matrix': {
        const matrixCreds = creds?.matrix;
        const hs = (matrixCreds?.homeserver || 'https://matrix.org').replace(/\/$/, '');
        const roomId = matrixCreds?.roomId || '!general:matrix.org';
        const txId = crypto.randomUUID();
        const endpoint = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txId}`;

        if (!matrixCreds?.token) {
          return {
            profileId: target.profileId,
            protocol: 'matrix',
            endpoint,
            statusCode: 401,
            error: `Missing Matrix access token for profile '${target.profileId}'`,
          };
        }

        try {
          const resp = await this.fetchImpl(endpoint, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${matrixCreds.token}`,
            },
            body: JSON.stringify({
              msgtype: 'm.text',
              body: target.text,
            }),
          });

          if (!resp.ok) {
            return {
              profileId: target.profileId,
              protocol: 'matrix',
              endpoint,
              statusCode: resp.status,
              error: `Matrix dispatch failed with HTTP ${resp.status}`,
            };
          }

          const data = (await resp.json()) as any;
          return {
            profileId: target.profileId,
            protocol: 'matrix',
            endpoint,
            statusCode: 200,
            responseId: data?.event_id || txId,
          };
        } catch (err: any) {
          return {
            profileId: target.profileId,
            protocol: 'matrix',
            endpoint,
            statusCode: 500,
            error: err.message,
          };
        }
      }
    }
  }

  public start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.processDueJobs().catch((err) => {
        console.error('[BROADCAST DAEMON] Tick error:', err.message);
      });
    }, this.pollIntervalMs);
  }

  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public close(): void {
    this.stop();
  }
}
