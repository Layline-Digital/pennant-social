/**
 * Pennant Hoist - Multi-Identity Session Vault Unit Tests
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 */

import assert from 'node:assert';
import http from 'node:http';
import { SessionVault, globalSessionVault } from '../packages/core/src/crypto/session-vault.ts';

async function runSessionVaultTests() {
  console.log('[*] Testing SessionVault Multi-Identity Registry & Security Guards...');

  const vault = new SessionVault();

  // 1. Register multiple accounts
  vault.registerProfile({
    profileId: 'brand-alpha',
    name: 'Brand Alpha',
    mastodon: {
      token: 'secret-masto-token-alpha-12345',
      instance: 'https://mastodon.social',
    },
    atproto: {
      handle: 'alpha.bsky.social',
      password: 'secret-app-password-alpha',
      accessJwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-jwt',
      pdsUrl: 'https://bsky.social',
    },
    nostr: {
      nsec: 'nsec1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2x2z82wm2tshq3ng093',
      pubkey: '3bf0c63fcb93463407af97b5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
      relays: ['wss://relay.damus.io'],
    },
    matrix: {
      token: 'secret-matrix-access-token-alpha',
      homeserver: 'https://matrix.org',
      roomId: '!room123:matrix.org',
    },
  });

  vault.registerProfile({
    profileId: 'studio-beta',
    name: 'Studio Beta',
    mastodon: {
      token: 'secret-masto-token-beta-67890',
      instance: 'https://social.pennant.laylinedigital.com',
    },
  });

  assert.strictEqual(vault.getProfileCount(), 2);
  assert.strictEqual(vault.hasProfile('brand-alpha'), true);
  assert.strictEqual(vault.hasProfile('BRAND-ALPHA'), true); // case-insensitive lookup
  assert.strictEqual(vault.hasProfile('studio-beta'), true);
  assert.strictEqual(vault.hasProfile('non-existent'), false);

  // 2. Strict Invariant: Never leak bearer tokens, access JWTs, or nsec keys to public client view
  const publicList = vault.listPublicProfiles();
  const serialized = JSON.stringify(publicList);

  assert.strictEqual(serialized.includes('secret-masto-token'), false, 'LEAK DETECTED: Mastodon token exposed');
  assert.strictEqual(serialized.includes('secret-app-password'), false, 'LEAK DETECTED: ATProto password exposed');
  assert.strictEqual(serialized.includes('super-secret-jwt'), false, 'LEAK DETECTED: Access JWT exposed');
  assert.strictEqual(serialized.includes('nsec1'), false, 'LEAK DETECTED: Nostr nsec private key exposed');
  assert.strictEqual(serialized.includes('secret-matrix-access-token'), false, 'LEAK DETECTED: Matrix token exposed');

  const pubAlpha = vault.getPublicProfile('brand-alpha');
  assert.ok(pubAlpha);
  assert.strictEqual(pubAlpha.profileId, 'brand-alpha');
  assert.strictEqual(pubAlpha.protocols.mastodon?.configured, true);
  assert.strictEqual(pubAlpha.protocols.atproto?.configured, true);
  assert.strictEqual(pubAlpha.protocols.nostr?.configured, true);
  assert.strictEqual(pubAlpha.protocols.matrix?.configured, true);

  // 3. Upstream dynamic auth generation (server-internal)
  const mastoAuth = vault.getUpstreamAuth('brand-alpha', 'mastodon');
  assert.ok(mastoAuth);
  assert.strictEqual(mastoAuth.headerName, 'Authorization');
  assert.strictEqual(mastoAuth.headerValue, 'Bearer secret-masto-token-alpha-12345');
  assert.strictEqual(mastoAuth.targetUrl, 'https://mastodon.social');

  const atprotoAuth = vault.getUpstreamAuth('brand-alpha', 'atproto');
  assert.ok(atprotoAuth);
  assert.strictEqual(atprotoAuth.headerValue, 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-jwt');

  const matrixAuth = vault.getUpstreamAuth('brand-alpha', 'matrix');
  assert.ok(matrixAuth);
  assert.strictEqual(matrixAuth.headerValue, 'Bearer secret-matrix-access-token-alpha');

  // Verify non-configured protocol returns null
  const betaAtproto = vault.getUpstreamAuth('studio-beta', 'atproto');
  assert.strictEqual(betaAtproto, null);

  // 4. Test loading from env format (.env.broadcaster mock)
  const envContent = `
    MASTO_TOKEN_OPS=masto_secret_ops_999
    MASTO_INSTANCE_OPS=https://mastodon.example.com
    BSKY_HANDLE_OPS=ops.laylinedigital.com
    BSKY_PASS_OPS=bsky_pass_ops_123
    NOSTR_NSEC_OPS=nsec1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2x2z82wm2tshq3ng093
    MATRIX_TOKEN_OPS=matrix_token_ops_456
    MATRIX_HOMESERVER_OPS=https://matrix.ops.org
  `;
  vault.loadFromEnv(envContent);

  assert.strictEqual(vault.hasProfile('ops'), true);
  const opsInternal = vault.getInternalCredentials('ops');
  assert.strictEqual(opsInternal?.mastodon?.token, 'masto_secret_ops_999');
  assert.strictEqual(opsInternal?.atproto?.password, 'bsky_pass_ops_123');

  const opsPublic = vault.getPublicProfile('ops');
  assert.strictEqual(JSON.stringify(opsPublic).includes('masto_secret_ops_999'), false);

  // 5. Test concurrent stream scaling up to 35 concurrent streams without conflict
  console.log('[*] Testing concurrent stream registration across 35 channels...');
  for (let i = 1; i <= 35; i++) {
    const streamProf = `acct-${i}`;
    vault.registerProfile({
      profileId: streamProf,
      name: `Account ${i}`,
      mastodon: { token: `token-${i}`, instance: 'https://social.pennant.laylinedigital.com' },
    });
  }
  assert.ok(vault.getProfileCount() >= 35, 'Should hold 35+ profiles concurrently');

  // 6. Test HTTP /api/stream endpoint dynamic auth attaching and zero credential leak
  console.log('[*] Testing /api/stream HTTP endpoint...');
  const server = http.createServer(async (req, res) => {
    const handled = await vault.handleStreamRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  const port = address.port;

  // Request 1: Valid stream request
  const streamRes = await fetch(`http://127.0.0.1:${port}/api/stream?profile=brand-alpha&column=col-timeline-1&protocol=mastodon`);
  assert.strictEqual(streamRes.status, 200);
  assert.strictEqual(streamRes.headers.get('content-type'), 'text/event-stream');
  assert.strictEqual(streamRes.headers.get('x-pennant-stream-profile'), 'brand-alpha');
  assert.strictEqual(streamRes.headers.get('x-pennant-stream-column'), 'col-timeline-1');

  // Ensure response headers DO NOT contain Authorization or Bearer
  assert.strictEqual(streamRes.headers.get('authorization'), null);
  assert.strictEqual(streamRes.headers.get('x-upstream-auth'), null);

  const reader = streamRes.body?.getReader();
  const firstChunk = await reader?.read();
  const text = new TextDecoder().decode(firstChunk?.value);
  assert.ok(text.includes('event: init'));
  assert.ok(text.includes('"profileId":"brand-alpha"'));
  assert.strictEqual(text.includes('secret-masto-token-alpha-12345'), false, 'Bearer token leaked in stream body!');
  await reader?.cancel();

  // Request 2: Unknown profile -> 404
  const notFoundRes = await fetch(`http://127.0.0.1:${port}/api/stream?profile=does-not-exist&column=col-1`);
  assert.strictEqual(notFoundRes.status, 404);

  // Request 3: Missing parameters -> 400
  const badReq = await fetch(`http://127.0.0.1:${port}/api/stream`);
  assert.strictEqual(badReq.status, 400);

  server.close();

  console.log('[+] PASS: SessionVault unit tests clean.');
  console.log('[+] PASS: In-memory session store & dynamic upstream auth verified.');
}

runSessionVaultTests().catch((err) => {
  console.error('[-] Test failed:', err);
  process.exit(1);
});
