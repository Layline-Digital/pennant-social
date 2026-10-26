/**
 * Pennant Hoist - Queue Edge CLI Command Subsystem
 *
 * Implements `pennant queue sync-edge [--job <id>]` to manually push or audit
 * edge synchronization with Cloudflare Workers relay.
 *
 * Copyright (c) 2026 Layline Digital. MIT License.
 */

import Database from 'better-sqlite3';
import {
  syncJobToEdge,
  getEdgeJob,
  reconcileEdgeJob,
  resolveDatabasePath,
  ensureBroadcastQueueEdgeSchema,
  DEFAULT_RELAY_URL,
  DEFAULT_DEV_AUTH_SECRET,
  DEFAULT_DEV_ENCRYPTION_KEY,
} from '../../../packages/core/src/scheduler/edge-bridge.ts';
import { globalSessionVault } from '../../../packages/core/src/crypto/session-vault.ts';

export interface QueueSyncEdgeOptions {
  jobId?: number;
  force?: boolean;
  dbPath?: string;
  relayUrl?: string;
  authSecret?: string;
  encryptionKey?: string;
}

export function parseQueueSyncEdgeArgs(args: string[]): QueueSyncEdgeOptions {
  const options: QueueSyncEdgeOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--job' || arg === '-j') {
      const next = args[++i];
      if (next) options.jobId = Number(next);
    } else if (arg.startsWith('--job=')) {
      options.jobId = Number(arg.slice('--job='.length));
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg === '--db') {
      options.dbPath = args[++i];
    } else if (arg === '--relay-url') {
      options.relayUrl = args[++i];
    } else if (arg === '--auth-secret') {
      options.authSecret = args[++i];
    }
  }

  return options;
}

export async function runQueueSyncEdgeCli(args: string[]): Promise<void> {
  const options = parseQueueSyncEdgeArgs(args);
  const dbPath = options.dbPath || resolveDatabasePath();
  const relayUrl = options.relayUrl || process.env.PENNANT_RELAY_URL || DEFAULT_RELAY_URL;
  const authSecret = options.authSecret || process.env.RELAY_AUTH_SECRET || DEFAULT_DEV_AUTH_SECRET;
  const encryptionKey = options.encryptionKey || process.env.RELAY_ENCRYPTION_KEY || DEFAULT_DEV_ENCRYPTION_KEY;

  console.log('================================================================================');
  console.log('       PENNANT HOIST // UNATTENDED CLOUD EDGE RELAY BRIDGE (CLI)');
  console.log('================================================================================');
  console.log(`Database:   ${dbPath}`);
  console.log(`Edge Relay: ${relayUrl}`);

  const db = new Database(dbPath);
  ensureBroadcastQueueEdgeSchema(db);

  try {
    if (options.jobId !== undefined) {
      // Single Job Target Mode
      const jobId = options.jobId;
      console.log(`\n[*] Inspecting Outbox Job #${jobId}...`);
      const job = db.prepare('SELECT * FROM broadcast_queue WHERE id = ?').get(jobId) as any;

      if (!job) {
        console.error(`[-] Error: Job #${jobId} not found in database.`);
        process.exitCode = 1;
        return;
      }

      console.log(`    Local Status:    ${job.status}`);
      console.log(`    Account:         ${job.account || 'default'}`);
      console.log(`    Scheduled For:   ${job.scheduled_for || job.scheduled_at}`);
      console.log(`    Targets:         ${job.targets || 'unknown'}`);
      console.log(`    Edge Job ID:     ${job.edge_job_id || 'none'}`);

      if (job.status === 'pending' || options.force) {
        console.log(`\n[*] Pushing Job #${jobId} to Cloudflare Edge Relay...`);
        const edgeJobId = await syncJobToEdge(jobId, {
          db,
          sessionVault: globalSessionVault,
          relayUrl,
          authSecret,
          encryptionKey,
          force: options.force,
        });

        console.log(`[+] SUCCESS: Job #${jobId} synced to Edge Relay!`);
        console.log(`    Assigned Edge Job ID: ${edgeJobId}`);
        console.log(`    Local Database Status: synced_edge`);
      } else if (job.status === 'synced_edge') {
        console.log(`\n[*] Auditing Remote Edge Relay Status for Job #${jobId} (${job.edge_job_id})...`);
        const remote = await getEdgeJob(job.edge_job_id, { relayUrl, authSecret });

        console.log(`    Remote Status:   ${remote.status}`);
        console.log(`    Remote Sched At: ${remote.scheduledAt}`);
        console.log(`    Dispatched At:   ${remote.dispatchedAt || 'pending'}`);

        if (remote.status === 'dispatched') {
          console.log(`\n[*] Remote job has dispatched! Reconciling local SQLite outbox...`);
          await reconcileEdgeJob(jobId, { db, relayUrl, authSecret });
          console.log(`[+] Reconciled: Local status transitioned to 'dispatched' with ledger receipts.`);
        } else if (remote.status === 'failed') {
          console.log(`\n[-] Remote job execution failed: ${remote.error || 'Unknown error'}`);
          await reconcileEdgeJob(jobId, { db, relayUrl, authSecret });
        } else {
          console.log(`[+] Job remains pending in Cloudflare edge queue for scheduled dispatch.`);
        }
      } else {
        console.log(`\n[i] Job #${jobId} is currently '${job.status}'. Use --force to re-push.`);
      }

      return;
    }

    // Fleet / All Jobs Synchronization & Audit Mode
    console.log('\n[*] Scanning broadcast_queue for edge-eligible jobs...');
    const nowIso = new Date().toISOString();

    const pendingFuture = db.prepare(`
      SELECT * FROM broadcast_queue
      WHERE status = 'pending' AND (
        (scheduled_at IS NOT NULL AND scheduled_at > ?) OR
        (scheduled_for IS NOT NULL AND scheduled_for > ?)
      )
      ORDER BY id ASC
    `).all(nowIso, nowIso) as any[];

    const syncedEdge = db.prepare(`
      SELECT * FROM broadcast_queue
      WHERE status = 'synced_edge'
      ORDER BY id ASC
    `).all() as any[];

    console.log(`    Found ${pendingFuture.length} pending future jobs and ${syncedEdge.length} edge-synced jobs.\n`);

    let pushedCount = 0;
    for (const job of pendingFuture) {
      try {
        console.log(`[*] Syncing pending Job #${job.id} [${job.account || 'default'}] to Cloudflare Edge Relay...`);
        const edgeId = await syncJobToEdge(job.id, {
          db,
          sessionVault: globalSessionVault,
          relayUrl,
          authSecret,
          encryptionKey,
        });
        console.log(`    -> Synced successfully! Edge Job ID: ${edgeId}`);
        pushedCount++;
      } catch (err: any) {
        console.warn(`    [-] Could not sync Job #${job.id}: ${err.message}`);
      }
    }

    let reconciledCount = 0;
    for (const job of syncedEdge) {
      if (!job.edge_job_id) continue;
      try {
        console.log(`[*] Auditing synced Job #${job.id} (Edge: ${job.edge_job_id})...`);
        const res = await reconcileEdgeJob(job.id, { db, relayUrl, authSecret });
        if (res.reconciled) {
          console.log(`    -> Status updated to: ${res.status}`);
          reconciledCount++;
        } else {
          console.log(`    -> Still in progress on edge (Status: ${res.status})`);
        }
      } catch (err: any) {
        console.warn(`    [-] Audit error on Job #${job.id}: ${err.message}`);
      }
    }

    // Render Summary Audit Table
    const allTracked = db.prepare(`
      SELECT * FROM broadcast_queue
      WHERE status IN ('pending', 'synced_edge', 'dispatched')
      ORDER BY id DESC LIMIT 15
    `).all() as any[];

    console.log('\n--- ACTIVE EDGE OUTBOX AUDIT LEDGER (TOP 15) ---');
    console.log(
      'ID'.padEnd(6) +
      'Account'.padEnd(14) +
      'Scheduled (UTC)'.padEnd(25) +
      'Status'.padEnd(14) +
      'Edge Job ID'.padEnd(30) +
      'Targets'
    );
    console.log('-'.repeat(105));

    for (const row of allTracked) {
      let account = row.account || 'default';
      let targets = row.targets || '';
      let schedTime = row.scheduled_at || row.scheduled_for || '';
      if (row.payload_json) {
        try {
          const p = JSON.parse(row.payload_json);
          if (!targets && p.targets) targets = p.targets.map((t: any) => t.protocol).join(',');
          if (p.scheduledFor) schedTime = p.scheduledFor;
          if (p.targets?.[0]?.profileId) account = p.targets[0].profileId;
        } catch {}
      }
      console.log(
        String(row.id).padEnd(6) +
        String(account).padEnd(14) +
        String(schedTime || 'immediate').padEnd(25) +
        String(row.status).padEnd(14) +
        String(row.edge_job_id || '-').padEnd(30) +
        String(targets || '-')
      );
    }
    console.log('-'.repeat(105));
    console.log(`[+] Edge Sync Summary: ${pushedCount} newly pushed, ${reconciledCount} reconciled dispatched.\n`);
  } finally {
    db.close();
  }
}
