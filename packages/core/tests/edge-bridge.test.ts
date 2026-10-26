/**
 * Pennant Hoist - Cloud Edge Relay Bridge & Cryptographic Subsystem Unit Tests
 *
 * Tests:
 * 1. Zero-Custody Nostr Kind 1 note pre-signing (Bech32 nsec decoding, BIP-340 Schnorr signatures, NIP-01 canonical hash)
 * 2. Scoped Bluesky app-password envelope encryption/decryption (AES-256-GCM WebCrypto)
 * 3. End-to-end edge synchronization bridge (syncJobToEdge, SQLite state transitions)
 * 4. Remote edge relay job polling and ledger reconciliation (reconcileEdgeJob)
 *
 * Copyright (c) 2026 Layline Digital. MIT License.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  decodeBech32Nsec,
  hexToBytes,
  bytesToHex,
  resolvePrivateKeyBytes,
  encryptAppPassword,
  decryptAppPassword,
  preSignNostrNote,
  syncJobToEdge,
  getEdgeJob,
  reconcileEdgeJob,
  ensureBroadcastQueueEdgeSchema,
  DEFAULT_NOSTR_RELAYS,
  DEFAULT_DEV_AUTH_SECRET,
  DEFAULT_DEV_ENCRYPTION_KEY,
} from '../src/scheduler/edge-bridge.ts';
import { SessionVault } from '../src/crypto/session-vault.ts';

async function runEdgeBridgeTests() {
  console.log('[*] Testing Cloud Edge Relay Bridge & Cryptographic Subsystem...\n');

  // ===========================================================================
  // TEST SUITE 1: Bech32 nsec Decoding & Private Key Invariants
  // ===========================================================================
  console.log('>>> [1/5] Testing Bech32 nsec Decoding & Key Derivation...');

  const validNsec = 'nsec1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2xknz82kr939q9cv358';
  const privBytes = decodeBech32Nsec(validNsec);

  assert.strictEqual(privBytes.length, 32, 'Decoded private key must be exactly 32 bytes');
  const privHex = bytesToHex(privBytes);
  assert.strictEqual(/^[0-9a-f]{64}$/.test(privHex), true, 'Private key must serialize to 64 hex characters');

  // Test hex resolution from both raw hex and nsec
  const fromHex = resolvePrivateKeyBytes(privHex);
  assert.deepStrictEqual(fromHex, privBytes, 'resolvePrivateKeyBytes must handle raw 64-char hex identically');

  const fromNsec = resolvePrivateKeyBytes(validNsec);
  assert.deepStrictEqual(fromNsec, privBytes, 'resolvePrivateKeyBytes must handle nsec string identically');

  // Corruption & boundary tests
  assert.throws(() => decodeBech32Nsec('npub1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2xknz82kr939q9cv358'), /Invalid HRP/);
  assert.throws(() => decodeBech32Nsec('nsec1invalidcharacterooo'), /Invalid bech32 character/i);
  assert.throws(() => decodeBech32Nsec('nsec1qq'), /Invalid bech32 checksum|Invalid nsec/i);
  assert.throws(() => decodeBech32Nsec('notabech32key'), /missing separator/i);

  // Derive Schnorr public key
  const pubKeyBytes = schnorr.getPublicKey(privBytes);
  assert.strictEqual(pubKeyBytes.length, 32, 'Derived BIP-340 public key must be 32 bytes');
  const pubKeyHex = bytesToHex(pubKeyBytes);
  assert.strictEqual(/^[0-9a-f]{64}$/.test(pubKeyHex), true, 'Public key hex must be 64 characters');

  console.log('    [+] PASS: Bech32 decoding, error rejection, and BIP-340 key derivation verified.\n');

  // ===========================================================================
  // TEST SUITE 2: Nostr Kind 1 Note Pre-Signing (Zero-Custody Model)
  // ===========================================================================
  console.log('>>> [2/5] Testing Zero-Custody Nostr Kind 1 Note Pre-Signing...');

  const testMessage = 'Sovereign fleet broadcast scheduled via Cloudflare Edge Relay.';
  const scheduledTime = '2026-10-26T15:00:00.000Z';
  const scheduledUnix = Math.floor(new Date(scheduledTime).getTime() / 1000);

  const preSigned = preSignNostrNote(testMessage, validNsec, scheduledTime);

  // Validate envelope structure
  assert.ok(preSigned.signedEvent, 'Must produce signedEvent object');
  assert.ok(preSigned.signedEventJson, 'Must produce signedEventJson string');
  assert.deepStrictEqual(preSigned.relays, DEFAULT_NOSTR_RELAYS, 'Must target default Nostr relays');

  const event = preSigned.signedEvent;
  assert.strictEqual(event.kind, 1, 'Event kind must be 1 (short text note)');
  assert.strictEqual(event.content, testMessage, 'Event content must match input message');
  assert.strictEqual(event.created_at, scheduledUnix, 'Event timestamp must match scheduled dispatch time');
  assert.strictEqual(event.pubkey, pubKeyHex, 'Event pubkey must match derived Schnorr public key');

  // Verify NIP-01 canonical event hash calculation
  const canonical = JSON.stringify([0, pubKeyHex, scheduledUnix, 1, [], testMessage]);
  const expectedEventId = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  assert.strictEqual(event.id, expectedEventId, 'Event ID must match SHA-256 of canonical serialization');

  // Cryptographically verify BIP-340 Schnorr signature
  const sigBytes = hexToBytes(event.sig);
  const idBytes = hexToBytes(event.id);
  assert.strictEqual(sigBytes.length, 64, 'BIP-340 signature must be 64 bytes (128 hex chars)');
  const isSigValid = schnorr.verify(sigBytes, idBytes, pubKeyBytes);
  assert.strictEqual(isSigValid, true, 'Cryptographic signature verification must succeed');

  // Zero-Custody Assertion: Ensure private key string never appears in signed JSON
  assert.strictEqual(preSigned.signedEventJson.includes(validNsec), false, 'CRITICAL: Private key nsec must never leak in payload');
  assert.strictEqual(preSigned.signedEventJson.includes(privHex), false, 'CRITICAL: Raw private key hex must never leak in payload');

  console.log('    [+] PASS: NIP-01 canonical hashing, BIP-340 Schnorr signing, and zero-custody guarantees verified.\n');

  // ===========================================================================
  // TEST SUITE 3: Bluesky Scoped App-Password AES-256-GCM Envelope Encryption
  // ===========================================================================
  console.log('>>> [3/5] Testing AES-256-GCM Envelope Encryption / Decryption...');

  const masterHexKey = DEFAULT_DEV_ENCRYPTION_KEY;
  const plaintextAppPass = 'abcd-1234-efgh-5678';

  const encryptedEnvelope = await encryptAppPassword(plaintextAppPass, masterHexKey);
  assert.ok(encryptedEnvelope.includes(':'), 'Envelope must follow ivHex:ciphertextHex format');

  const [ivPart, cipherPart] = encryptedEnvelope.split(':');
  assert.strictEqual(ivPart.length, 24, 'IV must be 12 bytes = 24 hex characters');
  assert.ok(cipherPart.length >= 32, 'Ciphertext must contain encrypted payload and 16-byte GCM authentication tag');

  // Decrypt and assert 100% round-trip fidelity
  const decrypted = await decryptAppPassword(encryptedEnvelope, masterHexKey);
  assert.strictEqual(decrypted, plaintextAppPass, 'Decrypted app password must match plaintext perfectly');

  // Test non-deterministic IV generation (every encryption call should produce unique IV and ciphertext)
  const secondEncryption = await encryptAppPassword(plaintextAppPass, masterHexKey);
  assert.notStrictEqual(encryptedEnvelope, secondEncryption, 'AES-GCM encryption must use unique random IV for each call');
  const secondDecrypted = await decryptAppPassword(secondEncryption, masterHexKey);
  assert.strictEqual(secondDecrypted, plaintextAppPass);

  // Tamper detection: flip a bit in ciphertext -> GCM authentication failure
  const tamperedCipher = cipherPart.slice(0, -2) + (cipherPart.slice(-2) === 'aa' ? 'bb' : 'aa');
  const tamperedEnvelope = `${ivPart}:${tamperedCipher}`;
  await assert.rejects(
    async () => {
      await decryptAppPassword(tamperedEnvelope, masterHexKey);
    },
    'Tampered ciphertext must cause AES-GCM authentication failure'
  );

  // Reject wrong key
  const wrongKey = '0000000000000000000000000000000000000000000000000000000000000000';
  await assert.rejects(
    async () => {
      await decryptAppPassword(encryptedEnvelope, wrongKey);
    },
    'Decryption with invalid key must fail authentication'
  );

  console.log('    [+] PASS: AES-256-GCM encryption, decryption, IV freshness, and tamper rejection verified.\n');

  // ===========================================================================
  // TEST SUITE 4: SQLite Outbox & Edge Bridge Integration (syncJobToEdge)
  // ===========================================================================
  console.log('>>> [4/5] Testing SQLite Outbox Bridge & Remote Edge Relay Sync...');

  // Set up in-memory SQLite database
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE broadcast_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'staging', 'dispatched', 'partial', 'failed')),
      scheduled_for TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Verify ensureBroadcastQueueEdgeSchema migrates existing schema to include 'synced_edge' and 'edge_job_id'
  ensureBroadcastQueueEdgeSchema(db);

  const vault = new SessionVault();
  vault.registerProfile({
    profileId: 'testpilot',
    name: 'Test Pilot',
    nostr: {
      nsec: validNsec,
    },
    atproto: {
      handle: 'testpilot.bsky.social',
      password: plaintextAppPass,
    },
  });

  // Seed a pending broadcast targeting both Bluesky and Nostr
  const futureSchedule = new Date(Date.now() + 3600000).toISOString();
  const insertInfo = db.prepare(`
    INSERT INTO broadcast_queue (status, scheduled_for, payload_json)
    VALUES ('pending', ?, ?)
  `).run(
    futureSchedule,
    JSON.stringify({
      scheduledFor: futureSchedule,
      targets: [
        { profileId: 'testpilot', protocol: 'nostr', text: 'Dual-target broadcast to edge' },
        { profileId: 'testpilot', protocol: 'bluesky', text: 'Dual-target broadcast to edge' },
      ],
    })
  );
  const localJobId = Number(insertInfo.lastInsertRowid);

  // Mock Edge Relay fetch
  let capturedScheduleUrl = '';
  let capturedScheduleHeaders: Record<string, string> = {};
  let capturedScheduleBody: any = null;

  const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();

    if (url.endsWith('/api/v1/schedule')) {
      capturedScheduleUrl = url;
      capturedScheduleHeaders = (init?.headers as Record<string, string>) || {};
      capturedScheduleBody = JSON.parse((init?.body as string) || '{}');

      return new Response(
        JSON.stringify({
          success: true,
          jobId: 'edge_job_mock_98765',
          scheduledAt: capturedScheduleBody.scheduledAt,
          status: 'pending',
          targets: ['nostr', 'bsky'],
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes('/api/v1/job/')) {
      return new Response(
        JSON.stringify({
          id: 'edge_job_mock_98765',
          status: 'pending',
          scheduledAt: futureSchedule,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not Found', { status: 404 });
  };

  const returnedEdgeId = await syncJobToEdge(localJobId, {
    db,
    sessionVault: vault,
    fetchImpl: mockFetch,
    authSecret: DEFAULT_DEV_AUTH_SECRET,
    encryptionKey: masterHexKey,
  });

  assert.strictEqual(returnedEdgeId, 'edge_job_mock_98765', 'Must return remote edge job ID');

  // Verify headers and payload submitted over the wire
  assert.strictEqual(
    capturedScheduleHeaders['Authorization'],
    `Bearer ${DEFAULT_DEV_AUTH_SECRET}`,
    'Must transmit pre-shared Bearer authentication secret'
  );
  assert.ok(capturedScheduleBody.nostr, 'Payload must include nostr section');
  assert.ok(capturedScheduleBody.bsky, 'Payload must include bsky section');
  assert.strictEqual(capturedScheduleBody.bsky.identifier, 'testpilot.bsky.social');

  // Verify payload security: Bluesky password must be encrypted, Nostr event signed
  assert.notStrictEqual(capturedScheduleBody.bsky.appPasswordEncrypted, plaintextAppPass, 'App password must NOT be plaintext');
  const decryptedFromPayload = await decryptAppPassword(capturedScheduleBody.bsky.appPasswordEncrypted, masterHexKey);
  assert.strictEqual(decryptedFromPayload, plaintextAppPass, 'Encrypted app password in payload must decrypt cleanly');

  const signedNostr = JSON.parse(capturedScheduleBody.nostr.signedEventJson);
  assert.strictEqual(signedNostr.pubkey, pubKeyHex);
  assert.strictEqual(signedNostr.content, 'Dual-target broadcast to edge');

  // Verify SQLite row transition
  const updatedRow = db.prepare('SELECT * FROM broadcast_queue WHERE id = ?').get(localJobId) as any;
  assert.strictEqual(updatedRow.status, 'synced_edge', 'Local SQLite status must transition to synced_edge');
  assert.strictEqual(updatedRow.edge_job_id, 'edge_job_mock_98765', 'edge_job_id must persist in SQLite');

  console.log('    [+] PASS: syncJobToEdge, remote contract validation, and local outbox transition verified.\n');

  // ===========================================================================
  // TEST SUITE 5: Remote Job Polling & Ledger Reconciliation
  // ===========================================================================
  console.log('>>> [5/5] Testing Edge Job Polling & Ledger Ingestion...');

  // Mock remote relay response transitioning to "dispatched" with receipts
  const mockDispatchedFetch: typeof fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes('/api/v1/job/edge_job_mock_98765')) {
      return new Response(
        JSON.stringify({
          id: 'edge_job_mock_98765',
          status: 'dispatched',
          scheduledAt: futureSchedule,
          dispatchedAt: '2026-10-26T15:00:01.200Z',
          receipt: {
            dispatchedAt: '2026-10-26T15:00:01.200Z',
            nostr: {
              eventId: signedNostr.id,
              relays: [
                { url: 'wss://relay.damus.io', success: true, message: 'Accepted', latencyMs: 85 },
                { url: 'wss://nos.lol', success: true, message: 'Accepted', latencyMs: 92 },
              ],
              successCount: 2,
              totalRelays: 2,
            },
            bsky: {
              success: true,
              cid: 'bafyreie53x637k3a4...',
              uri: 'at://did:plc:mock/app.bsky.feed.post/3k...',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('Not Found', { status: 404 });
  };

  const reconcileRes = await reconcileEdgeJob(localJobId, {
    db,
    fetchImpl: mockDispatchedFetch,
    authSecret: DEFAULT_DEV_AUTH_SECRET,
  });

  assert.strictEqual(reconcileRes.reconciled, true, 'Reconciliation must report success');
  assert.strictEqual(reconcileRes.status, 'dispatched', 'Status must be dispatched');

  // Assert broadcast_queue is now 'dispatched'
  const reconciledQueueRow = db.prepare('SELECT * FROM broadcast_queue WHERE id = ?').get(localJobId) as any;
  assert.strictEqual(reconciledQueueRow.status, 'dispatched', 'broadcast_queue status must be dispatched');
  assert.strictEqual(reconciledQueueRow.published_at, '2026-10-26T15:00:01.200Z');
  assert.ok(reconciledQueueRow.receipts.includes('bafyreie53x637k3a4'), 'Receipts JSON must contain Bluesky CID');

  // Assert broadcast_ledger contains entries for both Nostr relays and Bluesky endpoint
  const ledgerEntries = db.prepare('SELECT * FROM broadcast_ledger WHERE queue_id = ? ORDER BY id ASC').all(localJobId) as any[];
  assert.strictEqual(ledgerEntries.length, 3, 'Must insert 2 Nostr relay receipts and 1 Bluesky receipt into ledger');

  const nostrLedger1 = ledgerEntries.find((e) => e.target_endpoint === 'wss://relay.damus.io');
  assert.ok(nostrLedger1, 'Must record Damus relay receipt');
  assert.strictEqual(nostrLedger1.status_code, 200);
  assert.strictEqual(nostrLedger1.response_id, signedNostr.id);

  const bskyLedger = ledgerEntries.find((e) => e.protocol === 'bluesky');
  assert.ok(bskyLedger, 'Must record Bluesky receipt');
  assert.strictEqual(bskyLedger.status_code, 200);
  assert.strictEqual(bskyLedger.response_id, 'at://did:plc:mock/app.bsky.feed.post/3k...');

  db.close();

  console.log('    [+] PASS: Remote polling, SQLite row transition, and broadcast_ledger logging verified.\n');

  console.log('================================================================================');
  console.log(' ALL 5 CLOUD EDGE RELAY SCHEDULER & CRYPTO GATES PASSED CLEANLY (100% OK)');
  console.log('================================================================================\n');
}

runEdgeBridgeTests().catch((err) => {
  console.error('[-] Edge bridge unit tests failed:', err);
  process.exit(1);
});
