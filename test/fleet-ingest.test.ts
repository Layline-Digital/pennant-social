/**
 * Pennant Hoist - Downstream Fleet Ingestion Harness Unit & Integration Tests
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 */

import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { SessionVault } from '../packages/core/src/crypto/session-vault.ts';
import { MediaAirlock } from '../packages/core/src/adapters/media-airlock.ts';
import { BroadcastDaemon } from '../packages/core/src/queue/broadcast-daemon.ts';
import {
  handleFleetIngestRequest,
  type FleetIngestPayload,
  type FleetIngestReceipt,
} from '../packages/core/src/adapters/fleet-ingest.ts';

const TEST_INGEST_KEY = 'test-fleet-secret-key-xyz-789';

async function runFleetIngestTests() {
  console.log('[*] Testing Downstream Fleet Ingestion Harness for Almanac and Cereal...');

  const originalEnvKey = process.env.PENNANT_FLEET_INGEST_KEY;
  process.env.PENNANT_FLEET_INGEST_KEY = TEST_INGEST_KEY;

  // Initialize in-memory SQLite database and BroadcastDaemon
  const db = new Database(':memory:');
  const vault = new SessionVault();
  const airlock = new MediaAirlock({ db, sessionVault: vault });
  const daemon = new BroadcastDaemon({
    db,
    sessionVault: vault,
    mediaAirlock: airlock,
  });

  // Create local test HTTP server mounting handleFleetIngestRequest
  const server = http.createServer(async (req, res) => {
    const handled = await handleFleetIngestRequest(req, res, db, daemon);
    if (!handled && !res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // ------------------------------------------------------------------------
    // 1. Authorized Ingestion & Queue Creation
    // ------------------------------------------------------------------------
    console.log('[*] Testing authorized ingestion and queue creation...');

    // Test A: Sailing Almanac Ingestion
    const almanacPayload: FleetIngestPayload = {
      source: 'sailing-almanac',
      profileId: 'harbormaster',
      targets: ['mastodon', 'bluesky'],
      message: 'Gale Warning in effect for Stellwagen Bank. Winds NW 35kt.',
      url: 'https://almanac.sailing/alerts/2026-10-20',
      scheduledFor: '2026-10-25T14:30:00.000Z',
      contentWarning: 'Weather Gale Warning',
      tags: ['sailing', 'weather', 'almanac'],
    };

    const almanacRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify(almanacPayload),
    });

    assert.strictEqual(almanacRes.status, 200, 'Authorized request should return HTTP 200');
    const almanacReceipt = (await almanacRes.json()) as FleetIngestReceipt;
    assert.strictEqual(almanacReceipt.success, true);
    assert.ok(typeof almanacReceipt.queueId === 'string');
    assert.strictEqual(almanacReceipt.status, 'pending');
    assert.strictEqual(almanacReceipt.scheduledFor, '2026-10-25T14:30:00.000Z');

    // Verify row in SQLite broadcast_queue
    const qId1 = Number(almanacReceipt.queueId);
    const job1 = daemon.getJob(qId1);
    assert.ok(job1, 'Job must exist in broadcast_queue');
    assert.strictEqual(job1!.status, 'pending');
    assert.strictEqual(job1!.scheduled_for, '2026-10-25T14:30:00.000Z');

    const job1Payload = JSON.parse(job1!.payload_json);
    assert.strictEqual(job1Payload.metadata?.source, 'sailing-almanac');
    assert.strictEqual(job1Payload.targets.length, 2);
    assert.strictEqual(job1Payload.targets[0].protocol, 'mastodon');
    assert.strictEqual(job1Payload.targets[0].contentWarning, 'Weather Gale Warning');
    assert.ok(job1Payload.targets[0].text.includes('Gale Warning'));
    assert.ok(job1Payload.targets[0].text.includes('https://almanac.sailing/alerts/2026-10-20'));
    assert.ok(job1Payload.targets[0].text.includes('#sailing #weather #almanac'));

    // Test B: Postmodern Cereal Ingestion (Immediate, default targets)
    const cerealPayload: FleetIngestPayload = {
      source: 'postmodern-cereal',
      profileId: 'cereal-news',
      message: 'New dispatch published: Structural Narrative in Late Capitalism',
      url: 'https://postmoderncereal.com/dispatch-42',
    };

    const cerealRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify(cerealPayload),
    });

    assert.strictEqual(cerealRes.status, 200);
    const cerealReceipt = (await cerealRes.json()) as FleetIngestReceipt;
    assert.strictEqual(cerealReceipt.success, true);
    assert.ok(typeof cerealReceipt.queueId === 'string');
    assert.strictEqual(cerealReceipt.status, 'pending');
    assert.ok(cerealReceipt.scheduledFor, 'Must provide ISO-8601 immediate timestamp');

    const qId2 = Number(cerealReceipt.queueId);
    const job2 = daemon.getJob(qId2);
    assert.ok(job2);
    const job2Payload = JSON.parse(job2!.payload_json);
    assert.strictEqual(job2Payload.metadata?.source, 'postmodern-cereal');
    // Verify default targets: mastodon, bluesky, nostr
    assert.strictEqual(job2Payload.targets.length, 3);
    const protocols = job2Payload.targets.map((t: any) => t.protocol);
    assert.ok(protocols.includes('mastodon'));
    assert.ok(protocols.includes('bluesky'));
    assert.ok(protocols.includes('nostr'));

    // Test C: Fleet Worker Ingestion
    const workerPayload: FleetIngestPayload = {
      source: 'fleet-worker',
      profileId: 'ops-bot',
      targets: ['matrix'],
      message: 'Fleet health check OK across all nodes.',
    };

    const workerRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify(workerPayload),
    });

    assert.strictEqual(workerRes.status, 200);
    const workerReceipt = (await workerRes.json()) as FleetIngestReceipt;
    assert.strictEqual(workerReceipt.success, true);

    // ------------------------------------------------------------------------
    // 2. Rejection of Invalid Bearer Tokens (HTTP 401)
    // ------------------------------------------------------------------------
    console.log('[*] Testing rejection of invalid bearer tokens (HTTP 401)...');

    // Missing Authorization header
    const noAuthRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(almanacPayload),
    });
    assert.strictEqual(noAuthRes.status, 401, 'Missing Authorization header should return HTTP 401');
    const noAuthBody = await noAuthRes.json();
    assert.ok(noAuthBody.error.includes('Unauthorized'));

    // Invalid scheme (Basic instead of Bearer)
    const basicAuthRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic dXNlcjpwYXNz',
      },
      body: JSON.stringify(almanacPayload),
    });
    assert.strictEqual(basicAuthRes.status, 401, 'Basic scheme must be rejected with HTTP 401');

    // Wrong Bearer token
    const wrongTokenRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-secret-token',
      },
      body: JSON.stringify(almanacPayload),
    });
    assert.strictEqual(wrongTokenRes.status, 401, 'Incorrect Bearer token must return HTTP 401');

    // Empty Bearer token
    const emptyBearerRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ',
      },
      body: JSON.stringify(almanacPayload),
    });
    assert.strictEqual(emptyBearerRes.status, 401, 'Empty Bearer token must return HTTP 401');

    // ------------------------------------------------------------------------
    // 3. Rejection of Malformed Payloads
    // ------------------------------------------------------------------------
    console.log('[*] Testing rejection of malformed payloads (missing message or profileId)...');

    // Missing profileId
    const missingProfileRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify({
        source: 'sailing-almanac',
        message: 'Valid message without profile',
      }),
    });
    assert.strictEqual(missingProfileRes.status, 400, 'Missing profileId must return HTTP 400');
    const missingProfileBody = await missingProfileRes.json();
    assert.ok(missingProfileBody.error.includes('profileId'));

    // Missing message
    const missingMessageRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify({
        source: 'sailing-almanac',
        profileId: 'harbormaster',
      }),
    });
    assert.strictEqual(missingMessageRes.status, 400, 'Missing message must return HTTP 400');
    const missingMsgBody = await missingMessageRes.json();
    assert.ok(missingMsgBody.error.includes('message'));

    // Empty string message
    const emptyMsgRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify({
        source: 'sailing-almanac',
        profileId: 'harbormaster',
        message: '   ',
      }),
    });
    assert.strictEqual(emptyMsgRes.status, 400, 'Empty whitespace message must return HTTP 400');

    // Invalid source identifier
    const invalidSourceRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify({
        source: 'unauthorized-third-party',
        profileId: 'harbormaster',
        message: 'Valid message',
      }),
    });
    assert.strictEqual(invalidSourceRes.status, 400, 'Invalid source must return HTTP 400');

    // Invalid targets
    const invalidTargetsRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify({
        profileId: 'harbormaster',
        message: 'Valid message',
        targets: ['unsupported-network'],
      }),
    });
    assert.strictEqual(invalidTargetsRes.status, 400, 'Invalid targets must return HTTP 400');

    // Invalid scheduledFor timestamp
    const invalidDateRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify({
        profileId: 'harbormaster',
        message: 'Valid message',
        scheduledFor: 'not-a-valid-date',
      }),
    });
    assert.strictEqual(invalidDateRes.status, 400, 'Invalid scheduledFor must return HTTP 400');

    // Corrupt JSON payload
    const corruptJsonRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: '{ not valid json: ... }',
    });
    assert.strictEqual(corruptJsonRes.status, 400, 'Corrupt JSON must return HTTP 400');

    // ------------------------------------------------------------------------
    // 4. HTTP Method Not Allowed (405)
    // ------------------------------------------------------------------------
    const getRes = await fetch(`${baseUrl}/api/ingest/fleet`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${TEST_INGEST_KEY}` },
    });
    assert.strictEqual(getRes.status, 405, 'GET to /api/ingest/fleet must return HTTP 405');

    // ------------------------------------------------------------------------
    // 5. Test Direct BroadcastDaemon.enqueue() Integration
    // ------------------------------------------------------------------------
    console.log('[*] Testing direct BroadcastDaemon.enqueue() dispatch...');
    const directQueueId = daemon.enqueue({
      source: 'sailing-almanac',
      profileId: 'harbormaster',
      targets: ['bluesky'],
      message: 'Direct daemon.enqueue test message',
      url: 'https://almanac.sailing',
    });
    assert.ok(typeof directQueueId === 'number' && directQueueId > 0);
    const directJob = daemon.getJob(directQueueId);
    assert.ok(directJob);
    assert.strictEqual(directJob!.status, 'pending');

    // ------------------------------------------------------------------------
    // 6. Test Direct Database Fallback (when daemon is omitted)
    // ------------------------------------------------------------------------
    console.log('[*] Testing direct database fallback when daemon is omitted...');
    const fallbackServer = http.createServer(async (req, res) => {
      await handleFleetIngestRequest(req, res, db, undefined);
    });
    await new Promise<void>((resolve) => fallbackServer.listen(0, '127.0.0.1', () => resolve()));
    const fallbackPort = (fallbackServer.address() as { port: number }).port;

    const fallbackRes = await fetch(`http://127.0.0.1:${fallbackPort}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify({
        source: 'fleet-worker',
        profileId: 'fallback-profile',
        message: 'Message ingested directly via SQLite DB',
      }),
    });
    assert.strictEqual(fallbackRes.status, 200);
    const fallbackReceipt = (await fallbackRes.json()) as FleetIngestReceipt;
    assert.strictEqual(fallbackReceipt.success, true);
    assert.ok(daemon.getJob(Number(fallbackReceipt.queueId)));

    fallbackServer.close();

    // ------------------------------------------------------------------------
    // 7. Test pennant-launcher.js Mounted Route (/api/ingest/fleet)
    // ------------------------------------------------------------------------
    console.log('[*] Testing pennant-launcher.js mounted route /api/ingest/fleet...');
    const { server: launcherServer } = await import('../pennant-launcher.js');
    await new Promise<void>((resolve) => launcherServer.listen(0, '127.0.0.1', () => resolve()));
    const launcherPort = (launcherServer.address() as { port: number }).port;

    const launcherRes = await fetch(`http://127.0.0.1:${launcherPort}/api/ingest/fleet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_INGEST_KEY}`,
      },
      body: JSON.stringify({
        source: 'sailing-almanac',
        profileId: 'harbormaster',
        message: 'Launcher mounted route test message',
      }),
    });
    assert.strictEqual(launcherRes.status, 200, 'Launcher route must respond 200 OK');
    const launcherReceipt = (await launcherRes.json()) as FleetIngestReceipt;
    assert.strictEqual(launcherReceipt.success, true);
    assert.ok(typeof launcherReceipt.queueId === 'string');

    launcherServer.close();

    // ------------------------------------------------------------------------
    // 8. Test scripts/Invoke-FleetIngest.ps1 via HTTP and Fallback
    // ------------------------------------------------------------------------
    console.log('[*] Testing scripts/Invoke-FleetIngest.ps1 via HTTP and fallback...');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const isWin = os.platform() === 'win32';
    const pwsh = isWin ? 'powershell.exe' : 'pwsh';
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'Invoke-FleetIngest.ps1');

    // Run Invoke-FleetIngest.ps1 targeting the active test server port
    const psHttpResult = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const proc = spawn(pwsh, [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Source', 'sailing-almanac',
        '-ProfileId', 'harbormaster',
        '-Message', 'PowerShell script HTTP dispatch test',
        '-ApiKey', TEST_INGEST_KEY,
      ], {
        env: { ...process.env, PORT: String(address.port) },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ stdout, stderr, code }));
    });

    assert.strictEqual(psHttpResult.code, 0, `Invoke-FleetIngest.ps1 HTTP failed: ${psHttpResult.stderr}`);
    assert.ok(
      psHttpResult.stdout.includes('Successfully enqueued broadcast via Pennant daemon!'),
      'Script must report successful enqueue via daemon'
    );
    assert.ok(psHttpResult.stdout.includes('Queue ID:'), 'Script must display Queue ID');

    // Run Invoke-FleetIngest.ps1 targeting an unused port with DryRun to verify offline fallback
    const psFallbackResult = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const proc = spawn(pwsh, [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-Source', 'sailing-almanac',
        '-ProfileId', 'pennant',
        '-Message', 'PowerShell script fallback test',
        '-ApiKey', TEST_INGEST_KEY,
        '-DryRun',
      ], {
        env: { ...process.env, PORT: '59999' },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ stdout, stderr, code }));
    });

    assert.strictEqual(psFallbackResult.code, 0, `Invoke-FleetIngest.ps1 fallback failed: ${psFallbackResult.stderr}`);
    assert.ok(
      psFallbackResult.stdout.includes('Falling back to direct dispatch via Publish-FleetBroadcast.ps1'),
      'Script must trigger fallback to Publish-FleetBroadcast.ps1 when daemon is offline'
    );
    assert.ok(
      psFallbackResult.stdout.includes('[OK] Broadcast dispatch routine complete.'),
      'Fallback routine must complete successfully'
    );

    console.log('[+] PASS: Authorized ingestion and queue creation verified.');
    console.log('[+] PASS: Rejection of invalid bearer tokens (HTTP 401) verified.');
    console.log('[+] PASS: Rejection of malformed payloads (HTTP 400) verified.');
    console.log('[+] PASS: Downstream Fleet Ingestion Harness tests clean.');
    process.exit(0);
  } finally {
    server.close();
    if (originalEnvKey !== undefined) {
      process.env.PENNANT_FLEET_INGEST_KEY = originalEnvKey;
    } else {
      delete process.env.PENNANT_FLEET_INGEST_KEY;
    }
    db.close();
  }
}

runFleetIngestTests().catch((err) => {
  console.error('[-] Test failed:', err);
  process.exit(1);
});
