/**
 * Pennant Hoist - Sovereign Cloud Edge Relay Scheduler Bridge
 *
 * Integrates local SQLite outbox queue (pennant.db) with unattended Cloudflare Workers
 * edge relay (pennant-relay-worker).
 *
 * Security Model:
 * 1. Nostr: Zero-Custody. Signs Kind 1 NIP-01 notes locally using local nsec BEFORE transit.
 * 2. Bluesky: Scoped app-passwords encrypted locally using AES-256-GCM WebCrypto with RELAY_ENCRYPTION_KEY.
 * 3. Mastodon: Handled natively via Publish-FleetBroadcast.ps1 with instance-side scheduling.
 *
 * Copyright (c) 2026 Layline Digital. MIT License.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { schnorr } from '@noble/curves/secp256k1.js';
import { SessionVault, globalSessionVault, nsecToHex } from '../crypto/session-vault.ts';

export const DEFAULT_RELAY_URL = 'https://pennant-relay-worker.aewoodyard.workers.dev';
export const DEFAULT_NOSTR_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];

// Fallback keys for local development and test environments
export const DEFAULT_DEV_AUTH_SECRET = 'auth_8490ab4f1b150a10a531906753b4047c983f85c728c0b197c60a34e9c4fb7f60';
export const DEFAULT_DEV_ENCRYPTION_KEY = '71ec9c546f401bb1402252d19eaa43d0415876687d0a7ac51bb4311ec3fab82b';

export interface NostrSignedNote {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface EdgeScheduledPayload {
  id?: string;
  tenantId?: string;
  scheduledAt: string;
  status?: 'pending' | 'processing' | 'dispatched' | 'failed';
  targets?: string[];
  createdAt?: string;
  updatedAt?: string;
  dispatchedAt?: string;
  bsky?: {
    identifier: string;
    appPasswordEncrypted: string;
    text: string;
  };
  nostr?: {
    signedEventJson: string;
    relays: string[];
  };
  receipt?: EdgeJobReceipt;
}

export interface EdgeNostrRelayReceipt {
  url: string;
  success: boolean;
  message: string;
  latencyMs: number;
}

export interface EdgeJobReceipt {
  dispatchedAt?: string;
  nostr?: {
    eventId?: string;
    relays: EdgeNostrRelayReceipt[];
    successCount: number;
    totalRelays: number;
  };
  bsky?: {
    success: boolean;
    cid?: string;
    uri?: string;
    error?: string;
  };
}

export interface EdgeJobStatusResponse {
  id: string;
  tenantId?: string;
  scheduledAt: string;
  status: 'pending' | 'processing' | 'dispatched' | 'failed';
  targets?: string[];
  createdAt?: string;
  updatedAt?: string;
  dispatchedAt?: string;
  receipt?: EdgeJobReceipt;
  error?: string;
}

export interface EdgeBridgeSyncOptions {
  force?: boolean;
  db?: Database.Database;
  sessionVault?: SessionVault;
  relayUrl?: string;
  authSecret?: string;
  encryptionKey?: string;
  fetchImpl?: typeof fetch;
}

// -----------------------------------------------------------------------------
// Cryptographic Utilities
// -----------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.trim().replace(/^0x/i, '');
  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export function decodeBech32Nsec(nsec: string): Uint8Array {
  const clean = nsec.trim().toLowerCase();
  const sep = clean.lastIndexOf('1');
  if (sep === -1) {
    throw new Error("Invalid bech32 string: missing separator '1'");
  }
  const hrp = clean.slice(0, sep);
  if (hrp !== 'nsec') {
    throw new Error(`Invalid HRP '${hrp}', expected 'nsec'`);
  }

  function polymod(values: number[]): number {
    let chk = 1;
    for (const val of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ val;
      if (top & 1) chk ^= 0x3b6a57b2;
      if (top & 2) chk ^= 0x26508e6d;
      if (top & 4) chk ^= 0x1ea119fa;
      if (top & 8) chk ^= 0x3d4233dd;
      if (top & 16) chk ^= 0x2a1462b3;
    }
    return chk;
  }

  const hrpExpanded: number[] = [];
  for (let i = 0; i < hrp.length; i++) hrpExpanded.push(hrp.charCodeAt(i) >> 5);
  hrpExpanded.push(0);
  for (let i = 0; i < hrp.length; i++) hrpExpanded.push(hrp.charCodeAt(i) & 31);

  const dataValues: number[] = [];
  for (let i = sep + 1; i < clean.length; i++) {
    const idx = BECH32_CHARSET.indexOf(clean[i]);
    if (idx === -1) {
      throw new Error(`Invalid bech32 character: ${clean[i]}`);
    }
    dataValues.push(idx);
  }

  const isChecksumValid = polymod(hrpExpanded.concat(dataValues)) === 1;

  // Convert via nsecToHex if valid 32-byte entropy
  const hex = nsecToHex(clean);
  if (hex && hex.length === 64) {
    return hexToBytes(hex);
  }

  if (!isChecksumValid) {
    throw new Error('Invalid bech32 checksum for nsec key');
  }

  const payload5Bit = dataValues.slice(0, -6);
  let acc = 0;
  let bits = 0;
  const outBytes: number[] = [];
  for (const val of payload5Bit) {
    acc = (acc << 5) | val;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      outBytes.push((acc >> bits) & 0xff);
    }
  }

  const result = Uint8Array.from(outBytes);
  if (result.length !== 32) {
    throw new Error(`Invalid nsec private key length: expected 32 bytes, got ${result.length}`);
  }
  return result;
}

/**
 * Extracts 32-byte private key from either Bech32 nsec1... or 64-character raw hex
 */
export function resolvePrivateKeyBytes(nsecOrHex: string): Uint8Array {
  const clean = nsecOrHex.trim();
  if (clean.toLowerCase().startsWith('nsec1')) {
    return decodeBech32Nsec(clean);
  }
  if (/^[0-9a-fA-F]{64}$/.test(clean)) {
    return hexToBytes(clean);
  }
  const hexFromVault = nsecToHex(clean);
  if (hexFromVault && hexFromVault.length === 64) {
    return hexToBytes(hexFromVault);
  }
  throw new Error('Invalid Nostr secret key: must be valid Bech32 (nsec1...) or 64-char hex');
}

/**
 * Encrypts a plaintext credential using AES-256-GCM WebCrypto.
 * Returns standard "ivHex:ciphertextHex" envelope.
 */
export async function encryptAppPassword(plaintext: string, hexKey: string): Promise<string> {
  const keyBytes = hexToBytes(hexKey);
  if (keyBytes.length !== 32) {
    throw new Error(`Invalid AES-256 key length: expected 32 bytes, got ${keyBytes.length}`);
  }

  const cryptoSubtle = globalThis.crypto?.subtle || (crypto as any).webcrypto?.subtle;
  if (!cryptoSubtle) {
    throw new Error('WebCrypto subtle API is unavailable in this environment');
  }

  const cryptoKey = await cryptoSubtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuffer = await cryptoSubtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encoded
  );

  const ivHex = bytesToHex(iv);
  const cipherHex = bytesToHex(new Uint8Array(cipherBuffer));
  return `${ivHex}:${cipherHex}`;
}

/**
 * Decrypts an envelope-encrypted credential using AES-256-GCM WebCrypto.
 */
export async function decryptAppPassword(encryptedPayload: string, hexKey: string): Promise<string> {
  const keyBytes = hexToBytes(hexKey);
  if (keyBytes.length !== 32) {
    throw new Error(`Invalid AES-256 key length: expected 32 bytes, got ${keyBytes.length}`);
  }

  const cryptoSubtle = globalThis.crypto?.subtle || (crypto as any).webcrypto?.subtle;
  if (!cryptoSubtle) {
    throw new Error('WebCrypto subtle API is unavailable in this environment');
  }

  const cryptoKey = await cryptoSubtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const colonIdx = encryptedPayload.indexOf(':');
  if (colonIdx === -1) {
    throw new Error('Invalid encrypted envelope format: expected "ivHex:cipherHex"');
  }

  const ivPart = encryptedPayload.slice(0, colonIdx);
  const cipherPart = encryptedPayload.slice(colonIdx + 1);

  const iv = hexToBytes(ivPart);
  const ciphertext = hexToBytes(cipherPart);

  const decryptedBuffer = await cryptoSubtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );

  return new TextDecoder().decode(decryptedBuffer);
}

/**
 * Pre-signs a Nostr Kind 1 note according to NIP-01 canonical serialization (Zero Custody).
 */
export function preSignNostrNote(
  text: string,
  nsecOrHex: string,
  scheduledAt: string,
  relays: string[] = DEFAULT_NOSTR_RELAYS
): { signedEvent: NostrSignedNote; signedEventJson: string; relays: string[] } {
  const privKeyBytes = resolvePrivateKeyBytes(nsecOrHex);
  const pubKeyBytes = schnorr.getPublicKey(privKeyBytes);
  const pubKeyHex = bytesToHex(pubKeyBytes);

  const scheduledDate = new Date(scheduledAt);
  const scheduledUnixSec = isNaN(scheduledDate.getTime())
    ? Math.floor(Date.now() / 1000)
    : Math.floor(scheduledDate.getTime() / 1000);

  const canonicalEvent = [
    0,
    pubKeyHex,
    scheduledUnixSec,
    1,
    [],
    text,
  ];

  const serialized = JSON.stringify(canonicalEvent);
  const eventId = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
  const idBytes = hexToBytes(eventId);

  const sigBytes = schnorr.sign(idBytes, privKeyBytes);
  const sigHex = bytesToHex(sigBytes);

  const isValid = schnorr.verify(sigBytes, idBytes, pubKeyBytes);
  if (!isValid) {
    throw new Error('Cryptographic fault: Generated Nostr Schnorr signature failed local verification');
  }

  const signedEvent: NostrSignedNote = {
    id: eventId,
    pubkey: pubKeyHex,
    created_at: scheduledUnixSec,
    kind: 1,
    tags: [],
    content: text,
    sig: sigHex,
  };

  return {
    signedEvent,
    signedEventJson: JSON.stringify(signedEvent),
    relays,
  };
}

// -----------------------------------------------------------------------------
// Database Resolution and Schema Migration
// -----------------------------------------------------------------------------

export function resolveDatabasePath(): string {
  if (process.env.PENNANT_DB_PATH) {
    return path.resolve(process.env.PENNANT_DB_PATH);
  }
  const rootPennantDb = path.resolve(process.cwd(), 'pennant.db');
  if (fs.existsSync(rootPennantDb)) {
    return rootPennantDb;
  }
  const homeDataDir = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), '.pennant'));
  return path.join(homeDataDir, 'pennant_schedule.db');
}

export function ensureBroadcastQueueEdgeSchema(db: Database.Database): void {
  try {
    const tableInfo = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='broadcast_queue'"
    ).get() as { sql?: string } | undefined;

    if (tableInfo?.sql) {
      // Re-create table if CHECK constraint on status excludes 'synced_edge'
      if (tableInfo.sql.includes('CHECK(status IN') && !tableInfo.sql.includes('synced_edge')) {
        const columns = (db.pragma('table_info(broadcast_queue)') as any[]).map((c) => c.name);
        const colList = columns.join(', ');
        const updatedSql = tableInfo.sql
          .replace(
            /CHECK\(status IN \(([^)]+)\)\)/,
            "CHECK(status IN ($1, 'synced_edge'))"
          )
          .replace('CREATE TABLE broadcast_queue', 'CREATE TABLE broadcast_queue_edge_tmp');

        db.exec('PRAGMA foreign_keys = OFF;');
        db.exec(updatedSql);
        db.exec(`INSERT INTO broadcast_queue_edge_tmp (${colList}) SELECT ${colList} FROM broadcast_queue;`);
        db.exec('DROP TABLE broadcast_queue;');
        db.exec('ALTER TABLE broadcast_queue_edge_tmp RENAME TO broadcast_queue;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_broadcast_queue_due ON broadcast_queue(status, scheduled_for);');
        db.exec('PRAGMA foreign_keys = ON;');
      }
    }

    const cols = (db.pragma('table_info(broadcast_queue)') as any[]).map((c) => c.name);
    if (!cols.includes('edge_job_id')) {
      db.exec('ALTER TABLE broadcast_queue ADD COLUMN edge_job_id TEXT;');
    }
    if (!cols.includes('account')) {
      db.exec('ALTER TABLE broadcast_queue ADD COLUMN account TEXT;');
    }
    if (!cols.includes('targets')) {
      db.exec('ALTER TABLE broadcast_queue ADD COLUMN targets TEXT;');
    }
    if (!cols.includes('message')) {
      db.exec('ALTER TABLE broadcast_queue ADD COLUMN message TEXT;');
    }
    if (!cols.includes('scheduled_at')) {
      db.exec('ALTER TABLE broadcast_queue ADD COLUMN scheduled_at TEXT;');
    }
    if (!cols.includes('scheduled_for')) {
      db.exec('ALTER TABLE broadcast_queue ADD COLUMN scheduled_for TEXT;');
    }
    if (!cols.includes('payload_json')) {
      db.exec('ALTER TABLE broadcast_queue ADD COLUMN payload_json TEXT;');
    }
    if (!cols.includes('published_at')) {
      db.exec('ALTER TABLE broadcast_queue ADD COLUMN published_at TEXT;');
    }
    if (!cols.includes('receipts')) {
      db.exec('ALTER TABLE broadcast_queue ADD COLUMN receipts TEXT;');
    }
  } catch (err) {
    // Non-fatal if schema already contains the required constraints
  }

  // Ensure broadcast_ledger table exists
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_broadcast_ledger_queue ON broadcast_ledger(queue_id);
  `);
}

// -----------------------------------------------------------------------------
// Core Edge Bridge Sync & Reconcile Engine
// -----------------------------------------------------------------------------

/**
 * Synchronizes a queued post from local SQLite outbox to Cloudflare Workers Edge Relay.
 *
 * Directives:
 * 1. Read job from SQLite broadcast_queue WHERE id = ?.
 * 2. Load profile credentials from SessionVault / .env.broadcaster.
 * 3. If targets includes nostr: pre-sign Kind 1 note using secp256k1/Schnorr with relay URLs ["wss://relay.damus.io", "wss://nos.lol"].
 * 4. If targets includes bluesky: encrypt BSKY_PASS_<ID> using AES-256-GCM WebCrypto with RELAY_ENCRYPTION_KEY.
 * 5. Send payload to https://pennant-relay-worker.aewoodyard.workers.dev/api/v1/schedule.
 * 6. Update SQLite: UPDATE broadcast_queue SET status = 'synced_edge', edge_job_id = ? WHERE id = ?.
 */
export async function syncJobToEdge(jobId: number, options?: EdgeBridgeSyncOptions): Promise<string> {
  const ownDb = !options?.db;
  const db = options?.db || new Database(resolveDatabasePath());

  try {
    ensureBroadcastQueueEdgeSchema(db);

    const job = db.prepare('SELECT * FROM broadcast_queue WHERE id = ?').get(jobId) as any;
    if (!job) {
      throw new Error(`Job #${jobId} not found in broadcast_queue`);
    }

    if (!options?.force) {
      if (job.status === 'synced_edge' && job.edge_job_id) {
        return job.edge_job_id;
      }
      if (job.status === 'dispatched' || job.status === 'published') {
        throw new Error(`Job #${jobId} is already dispatched`);
      }
    }

    // 1. Resolve Vault and Credentials
    const vault = options?.sessionVault || globalSessionVault;
    if (vault.getProfileCount() === 0) {
      const broadcasterEnvPath = [
        path.resolve('.env.broadcaster'),
        path.resolve(process.cwd(), '.env.broadcaster'),
        path.resolve(__dirname, '../../../.env.broadcaster'),
        path.resolve(__dirname, '../../../../.env.broadcaster'),
      ].find((p) => fs.existsSync(p));

      if (broadcasterEnvPath) {
        vault.loadFromEnv(broadcasterEnvPath);
      }
    }

    // 2. Parse job parameters from row and payload_json
    let scheduledAt = job.scheduled_for || job.scheduled_at;
    let message = job.message || '';
    let account = job.account || 'default';
    let targets: string[] = [];

    if (job.payload_json) {
      try {
        const payload = JSON.parse(job.payload_json);
        if (!scheduledAt && payload.scheduledFor) scheduledAt = payload.scheduledFor;
        if (Array.isArray(payload.targets)) {
          for (const t of payload.targets) {
            if (t.protocol) targets.push(t.protocol.toLowerCase());
            if (!message && t.text) message = t.text;
            if ((!account || account === 'default') && t.profileId) account = t.profileId;
          }
        }
      } catch {}
    }

    if (targets.length === 0 && job.targets) {
      targets = String(job.targets)
        .split(',')
        .map((t) => t.trim().toLowerCase());
    }

    // Normalize target protocols
    const hasNostr = targets.includes('nostr');
    const hasBluesky = targets.includes('bluesky') || targets.includes('atproto');

    if (!hasNostr && !hasBluesky) {
      throw new Error(`Job #${jobId} targets [${targets.join(', ')}] do not include edge-relayable targets (nostr, bluesky)`);
    }

    if (!scheduledAt) {
      scheduledAt = new Date().toISOString();
    } else {
      scheduledAt = new Date(scheduledAt).toISOString();
    }

    const cleanAccount = (account || 'default').trim().toLowerCase();
    const creds = vault.getInternalCredentials(cleanAccount) ||
      vault.getInternalCredentials('pennant') ||
      vault.getInternalCredentials('default');

    const relayPayload: EdgeScheduledPayload = {
      tenantId: cleanAccount,
      scheduledAt,
      targets: [],
    };

    // 3. Nostr: Pre-sign Kind 1 note (Zero Private Key Custody)
    if (hasNostr) {
      const nsec =
        creds?.nostr?.nsec ||
        creds?.nostr?.hexPrivateKey ||
        process.env[`NOSTR_NSEC_${cleanAccount.toUpperCase()}`] ||
        process.env.NOSTR_NSEC ||
        process.env.NOSTR_NSEC_PENNANT;

      if (!nsec) {
        throw new Error(`Missing Nostr credentials for account [${cleanAccount}]`);
      }

      const preSigned = preSignNostrNote(message, nsec, scheduledAt, DEFAULT_NOSTR_RELAYS);
      relayPayload.nostr = {
        signedEventJson: preSigned.signedEventJson,
        relays: preSigned.relays,
      };
      relayPayload.targets!.push('nostr');
    }

    // 4. Bluesky: Scoped app-password envelope encryption
    if (hasBluesky) {
      const encryptionKey =
        options?.encryptionKey ||
        process.env.RELAY_ENCRYPTION_KEY ||
        DEFAULT_DEV_ENCRYPTION_KEY;

      const bskyPass =
        creds?.atproto?.password ||
        process.env[`BSKY_PASS_${cleanAccount.toUpperCase()}`] ||
        process.env.BSKY_PASS ||
        process.env.BSKY_PASS_PENNANT ||
        process.env.BLUESKY_APP_PASSWORD;

      const bskyHandle =
        creds?.atproto?.handle ||
        process.env[`BSKY_HANDLE_${cleanAccount.toUpperCase()}`] ||
        process.env.BSKY_HANDLE ||
        process.env.BSKY_HANDLE_PENNANT ||
        process.env.BLUESKY_IDENTIFIER ||
        `${cleanAccount}.laylinedigital.com`;

      if (!bskyPass) {
        throw new Error(`Missing Bluesky app password for account [${cleanAccount}]`);
      }

      const appPasswordEncrypted = await encryptAppPassword(bskyPass, encryptionKey);
      relayPayload.bsky = {
        identifier: bskyHandle,
        appPasswordEncrypted,
        text: message,
      };
      relayPayload.targets!.push('bsky');
    }

    // 5. Submit to Cloudflare Workers Edge Relay
    const relayUrl = (options?.relayUrl || process.env.PENNANT_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, '');
    const authSecret = options?.authSecret || process.env.RELAY_AUTH_SECRET || DEFAULT_DEV_AUTH_SECRET;
    const fetchImpl = options?.fetchImpl || globalThis.fetch;

    const res = await fetchImpl(`${relayUrl}/api/v1/schedule`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authSecret}`,
      },
      body: JSON.stringify(relayPayload),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Cloudflare Edge Relay schedule failed (HTTP ${res.status}): ${errBody}`);
    }

    const data: any = await res.json();
    const edgeJobId = data.jobId;
    if (!edgeJobId) {
      throw new Error('Cloudflare Edge Relay did not return a jobId');
    }

    // 6. Update SQLite outbox row
    db.prepare(`
      UPDATE broadcast_queue
      SET status = 'synced_edge',
          edge_job_id = ?
      WHERE id = ?
    `).run(edgeJobId, jobId);

    return edgeJobId;
  } finally {
    if (ownDb) {
      try { db.close(); } catch {}
    }
  }
}

/**
 * Query remote execution status for an edge relay job
 */
export async function getEdgeJob(
  edgeJobId: string,
  options?: { relayUrl?: string; authSecret?: string; fetchImpl?: typeof fetch }
): Promise<EdgeJobStatusResponse> {
  const relayUrl = (options?.relayUrl || process.env.PENNANT_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, '');
  const authSecret = options?.authSecret || process.env.RELAY_AUTH_SECRET || DEFAULT_DEV_AUTH_SECRET;
  const fetchImpl = options?.fetchImpl || globalThis.fetch;

  const res = await fetchImpl(`${relayUrl}/api/v1/job/${encodeURIComponent(edgeJobId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${authSecret}`,
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to query edge job ${edgeJobId} (HTTP ${res.status}): ${errText}`);
  }

  return (await res.json()) as EdgeJobStatusResponse;
}

/**
 * Reconciles a locally synced job with remote edge status.
 * If remote has dispatched, updates SQLite broadcast_queue and records receipts in broadcast_ledger.
 */
export async function reconcileEdgeJob(
  jobId: number,
  options?: EdgeBridgeSyncOptions
): Promise<{ reconciled: boolean; status: string; edgeJobId?: string }> {
  const ownDb = !options?.db;
  const db = options?.db || new Database(resolveDatabasePath());

  try {
    ensureBroadcastQueueEdgeSchema(db);

    const job = db.prepare('SELECT * FROM broadcast_queue WHERE id = ?').get(jobId) as any;
    if (!job || !job.edge_job_id) {
      return { reconciled: false, status: job?.status || 'not_found' };
    }

    const remoteJob = await getEdgeJob(job.edge_job_id, options);

    if (remoteJob.status === 'dispatched') {
      const dispatchedAt = remoteJob.receipt?.dispatchedAt || remoteJob.dispatchedAt || new Date().toISOString();
      const receiptsJson = JSON.stringify(remoteJob.receipt || {});
      const account = job.account || 'pennant';

      // Insert receipts into broadcast_ledger
      if (remoteJob.receipt?.nostr?.relays) {
        const stmt = db.prepare(`
          INSERT INTO broadcast_ledger (queue_id, profile_id, protocol, target_endpoint, status_code, response_id, error_message, dispatched_at)
          VALUES (?, ?, 'nostr', ?, ?, ?, ?, ?)
        `);
        for (const r of remoteJob.receipt.nostr.relays) {
          stmt.run(
            job.id,
            account,
            r.url,
            r.success ? 200 : 500,
            remoteJob.receipt.nostr.eventId || null,
            r.success ? null : r.message,
            dispatchedAt
          );
        }
      }

      if (remoteJob.receipt?.bsky) {
        const b = remoteJob.receipt.bsky;
        db.prepare(`
          INSERT INTO broadcast_ledger (queue_id, profile_id, protocol, target_endpoint, status_code, response_id, error_message, dispatched_at)
          VALUES (?, ?, 'bluesky', 'https://bsky.social', ?, ?, ?, ?)
        `).run(
          job.id,
          account,
          b.success ? 200 : 500,
          b.uri || b.cid || null,
          b.success ? null : (b.error || 'Bluesky dispatch failed'),
          dispatchedAt
        );
      }

      // Update broadcast_queue
      const queueCols = (db.pragma('table_info(broadcast_queue)') as any[]).map((c) => c.name);
      if (queueCols.includes('published_at') && queueCols.includes('receipts')) {
        db.prepare(`
          UPDATE broadcast_queue
          SET status = 'dispatched',
              published_at = ?,
              receipts = ?
          WHERE id = ?
        `).run(dispatchedAt, receiptsJson, job.id);
      } else {
        db.prepare(`
          UPDATE broadcast_queue
          SET status = 'dispatched'
          WHERE id = ?
        `).run(job.id);
      }

      return { reconciled: true, status: 'dispatched', edgeJobId: job.edge_job_id };
    }

    if (remoteJob.status === 'failed') {
      db.prepare(`
        UPDATE broadcast_queue
        SET status = 'failed',
            last_error = ?
        WHERE id = ?
      `).run(remoteJob.error || 'Cloudflare Edge Relay execution failed', job.id);

      return { reconciled: true, status: 'failed', edgeJobId: job.edge_job_id };
    }

    return { reconciled: false, status: remoteJob.status, edgeJobId: job.edge_job_id };
  } finally {
    if (ownDb) {
      try { db.close(); } catch {}
    }
  }
}

/**
 * Polls and reconciles all active synced_edge jobs in SQLite
 */
export async function pollAndReconcileAllEdgeJobs(
  options?: EdgeBridgeSyncOptions
): Promise<{ audited: number; dispatched: number; failed: number }> {
  const ownDb = !options?.db;
  const db = options?.db || new Database(resolveDatabasePath());

  try {
    ensureBroadcastQueueEdgeSchema(db);

    const jobs = db.prepare(
      "SELECT id, edge_job_id FROM broadcast_queue WHERE status = 'synced_edge' AND edge_job_id IS NOT NULL"
    ).all() as Array<{ id: number; edge_job_id: string }>;

    let dispatched = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        const res = await reconcileEdgeJob(job.id, { ...options, db });
        if (res.status === 'dispatched') dispatched++;
        else if (res.status === 'failed') failed++;
      } catch (err: any) {
        console.warn(`[EDGE RELAY] Reconcile error on job #${job.id}:`, err.message);
      }
    }

    return { audited: jobs.length, dispatched, failed };
  } finally {
    if (ownDb) {
      try { db.close(); } catch {}
    }
  }
}
