/**
 * Pennant Hoist - SQLite Broadcast Queue & Daemon Unit Tests
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 */

import assert from 'node:assert';
import Database from 'better-sqlite3';
import { SessionVault } from '../packages/core/src/crypto/session-vault.ts';
import { MediaAirlock } from '../packages/core/src/adapters/media-airlock.ts';
import {
  BroadcastDaemon,
  type BroadcastPayload,
} from '../packages/core/src/queue/broadcast-daemon.ts';

async function runBroadcastDaemonTests() {
  console.log('[*] Testing SQLite Broadcast Queue & Multi-Protocol Dispatch Daemon...');

  const db = new Database(':memory:');
  const vault = new SessionVault();

  // Register identity profiles with credentials
  vault.registerProfile({
    profileId: 'brand-alpha',
    atproto: {
      handle: 'alpha.bsky.social',
      accessJwt: 'valid-bsky-jwt',
      pdsUrl: 'https://bsky.social',
      did: 'did:plc:alpha123',
    },
    mastodon: {
      token: 'valid-masto-token',
      instance: 'https://social.pennant.laylinedigital.com',
    },
    nostr: {
      nsec: 'nsec1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2x2z82wm2tshq3ng093',
      relays: ['wss://relay.damus.io'],
    },
    matrix: {
      token: 'valid-matrix-token',
      homeserver: 'https://matrix.org',
      roomId: '!general:matrix.org',
    },
  });

  const networkRequests: Array<{ url: string; method?: string; body?: string }> = [];

  // Mock fetch router to simulate protocols and responses
  let simulateServerError = false;
  const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = input.toString();
    const method = init?.method || 'GET';
    const body = init?.body?.toString();
    networkRequests.push({ url: urlStr, method, body });

    if (simulateServerError) {
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Bluesky / ATProto createRecord
    if (urlStr.includes('/xrpc/com.atproto.repo.createRecord')) {
      return new Response(JSON.stringify({ uri: 'at://did:plc:alpha123/app.bsky.feed.post/3k123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Mastodon /api/v1/statuses
    if (urlStr.includes('/api/v1/statuses')) {
      return new Response(JSON.stringify({ id: '109988776655', url: 'https://social.pennant.io/@alpha/109988776655' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Matrix send message
    if (urlStr.includes('/_matrix/client/v3/rooms/')) {
      return new Response(JSON.stringify({ event_id: '$matrix_event_777' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
  };

  const airlock = new MediaAirlock({
    db,
    sessionVault: vault,
    fetchImpl: mockFetch,
  });

  const daemon = new BroadcastDaemon({
    db,
    sessionVault: vault,
    mediaAirlock: airlock,
    fetchImpl: mockFetch,
    maxRetries: 3,
  });

  // 1. Test Queue Enqueueing
  console.log('[*] Testing Enqueueing immediate and scheduled jobs...');
  const payload: BroadcastPayload = {
    targets: [
      { profileId: 'brand-alpha', protocol: 'bluesky', text: 'Fleet status broadcast' },
      { profileId: 'brand-alpha', protocol: 'mastodon', text: 'Fleet status broadcast' },
      { profileId: 'brand-alpha', protocol: 'nostr', text: 'Fleet status broadcast' },
      { profileId: 'brand-alpha', protocol: 'matrix', text: 'Fleet status broadcast' },
    ],
  };

  const immediateJobId = daemon.enqueueBroadcast(payload);
  assert.ok(immediateJobId > 0);
  const immediateJob = daemon.getJob(immediateJobId);
  assert.strictEqual(immediateJob?.status, 'pending');
  assert.strictEqual(immediateJob?.attempts, 0);

  // 2. Test T-10m Media Pre-staging
  console.log('[*] Testing T-10m Media Pre-Staging logic...');
  const testPngBase64 = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).toString('base64');
  const futureDate = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes in future (<= T-10m)

  const mediaJobId = daemon.enqueueBroadcast({
    targets: [
      {
        profileId: 'brand-alpha',
        protocol: 'bluesky',
        text: 'Post with future media',
        mediaFileBuffers: [{ bufferBase64: testPngBase64, mimeType: 'image/png' }],
      },
    ],
  }, futureDate);

  const preStagedCount = await daemon.processPreStaging(new Date().toISOString());
  assert.strictEqual(preStagedCount, 1);

  const updatedMediaJob = daemon.getJob(mediaJobId);
  assert.strictEqual(updatedMediaJob?.status, 'staging');
  const parsedUpdatedPayload = JSON.parse(updatedMediaJob!.payload_json) as BroadcastPayload;
  assert.ok(parsedUpdatedPayload.targets[0].media);
  assert.ok(parsedUpdatedPayload.targets[0].media!.length > 0);
  assert.strictEqual(parsedUpdatedPayload.targets[0].mediaFileBuffers, undefined);

  // 3. Test Full Multi-Protocol Dispatch & Ledger Recording
  console.log('[*] Testing full concurrent dispatch across quad-protocols...');
  const dispatchRes = await daemon.dispatchJob(immediateJobId);
  assert.strictEqual(dispatchRes.finalStatus, 'dispatched');
  assert.strictEqual(dispatchRes.results.length, 4);
  assert.strictEqual(dispatchRes.results.every((r) => r.statusCode === 200), true);

  // Verify Ledger entries
  const ledgerEntries = daemon.getLedgerEntries(immediateJobId);
  assert.strictEqual(ledgerEntries.length, 4);

  const bskyEntry = ledgerEntries.find((e) => e.protocol === 'bluesky');
  assert.ok(bskyEntry);
  assert.strictEqual(bskyEntry.status_code, 200);
  assert.ok(bskyEntry.response_id?.includes('app.bsky.feed.post'));

  const mastoEntry = ledgerEntries.find((e) => e.protocol === 'mastodon');
  assert.ok(mastoEntry);
  assert.strictEqual(mastoEntry.status_code, 200);
  assert.strictEqual(mastoEntry.response_id, '109988776655');

  const nostrEntry = ledgerEntries.find((e) => e.protocol === 'nostr');
  assert.ok(nostrEntry);
  assert.strictEqual(nostrEntry.status_code, 200);

  const matrixEntry = ledgerEntries.find((e) => e.protocol === 'matrix');
  assert.ok(matrixEntry);
  assert.strictEqual(matrixEntry.status_code, 200);
  assert.strictEqual(matrixEntry.response_id, '$matrix_event_777');

  // Verify queue table status
  const finishedJob = daemon.getJob(immediateJobId);
  assert.strictEqual(finishedJob?.status, 'dispatched');

  // 4. Test Partial Failure Handling
  console.log('[*] Testing Partial Failure (one valid profile, one missing creds)...');
  const partialJobId = daemon.enqueueBroadcast({
    targets: [
      { profileId: 'brand-alpha', protocol: 'mastodon', text: 'Valid Mastodon post' },
      { profileId: 'unconfigured-profile', protocol: 'bluesky', text: 'Missing profile credentials' },
    ],
  });

  const partialRes = await daemon.dispatchJob(partialJobId);
  assert.strictEqual(partialRes.finalStatus, 'partial');

  const partialJob = daemon.getJob(partialJobId);
  assert.strictEqual(partialJob?.status, 'partial');
  assert.ok(partialJob?.last_error?.includes('unconfigured-profile'));

  const partialLedger = daemon.getLedgerEntries(partialJobId);
  assert.strictEqual(partialLedger.length, 2);
  assert.strictEqual(partialLedger.find((l) => l.profile_id === 'brand-alpha')?.status_code, 200);
  assert.strictEqual(partialLedger.find((l) => l.profile_id === 'unconfigured-profile')?.status_code, 401);

  // 5. Test Retry Backoff on Server 500 Errors
  console.log('[*] Testing Retry Backoff on 500 server errors...');
  simulateServerError = true;

  const retryJobId = daemon.enqueueBroadcast({
    targets: [{ profileId: 'brand-alpha', protocol: 'mastodon', text: 'Retry test post' }],
  });

  // Attempt 1: Fails with 500, attempts becomes 1, status remains 'pending', scheduled_for bumped
  const t0 = new Date(daemon.getJob(retryJobId)!.scheduled_for).getTime();
  await daemon.dispatchJob(retryJobId);

  const attempt1Job = daemon.getJob(retryJobId);
  assert.strictEqual(attempt1Job?.status, 'pending');
  assert.strictEqual(attempt1Job?.attempts, 1);
  const t1 = new Date(attempt1Job!.scheduled_for).getTime();
  assert.ok(t1 > t0, 'Next scheduled_for must be postponed with exponential backoff');

  // Attempt 2
  await daemon.dispatchJob(retryJobId);
  const attempt2Job = daemon.getJob(retryJobId);
  assert.strictEqual(attempt2Job?.attempts, 2);
  assert.strictEqual(attempt2Job?.status, 'pending');

  // Attempt 3: Max retries reached (3) -> final status transitions to 'failed'
  await daemon.dispatchJob(retryJobId);
  const attempt3Job = daemon.getJob(retryJobId);
  assert.strictEqual(attempt3Job?.attempts, 3);
  assert.strictEqual(attempt3Job?.status, 'failed');
  assert.ok(attempt3Job?.last_error?.includes('500'));

  daemon.close();
  airlock.close();
  db.close();

  console.log('[+] PASS: SQLite Broadcast Queue & Daemon unit tests clean.');
  console.log('[+] PASS: T-10m media staging, ledger logging, and retry backoff verified.');
}

runBroadcastDaemonTests().catch((err) => {
  console.error('[-] Broadcast daemon test failed:', err);
  process.exit(1);
});
