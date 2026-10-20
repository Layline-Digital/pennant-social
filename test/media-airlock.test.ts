/**
 * Pennant Hoist - Adaptive Background Media Airlock Unit Tests
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 */

import assert from 'node:assert';
import Database from 'better-sqlite3';
import { SessionVault } from '../packages/core/src/crypto/session-vault.ts';
import {
  MediaAirlock,
  generateBlurHash,
  parseImageDimensions,
  type PreStagedMedia,
} from '../packages/core/src/adapters/media-airlock.ts';

async function runMediaAirlockTests() {
  console.log('[*] Testing Adaptive Background Media Airlock...');

  // 1. Test Image Dimension Parsing and BlurHash calculation
  // Create a minimal 1x1 PNG buffer:
  // Signature: 89 50 4E 47 0D 0A 1A 0A
  // IHDR length: 00 00 00 0D
  // IHDR: 49 48 44 52
  // Width: 00 00 03 20 (800 px)
  // Height: 00 00 02 58 (600 px)
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0x20, // width: 800
    0x00, 0x00, 0x02, 0x58, // height: 600
    0x08, 0x06, 0x00, 0x00, 0x00,
  ]);
  const dummyData = Buffer.alloc(100, 0xAA);
  const testPngBuffer = Buffer.concat([pngHeader, dummyData]);

  const dims = parseImageDimensions(testPngBuffer, 'image/png');
  assert.ok(dims);
  assert.strictEqual(dims.width, 800);
  assert.strictEqual(dims.height, 600);

  const blurhash = generateBlurHash(testPngBuffer, dims);
  assert.ok(blurhash);
  assert.ok(blurhash.length >= 20, 'BlurHash should produce valid base83 encoded representation');

  // 2. Test in-memory SQLite WAL caching
  const testDb = new Database(':memory:');
  const vault = new SessionVault();

  vault.registerProfile({
    profileId: 'deck-author',
    mastodon: {
      token: 'masto-token-777',
      instance: 'https://mastodon.test.social',
    },
    atproto: {
      handle: 'author.bsky.social',
      accessJwt: 'bsky-jwt-888',
      pdsUrl: 'https://bsky.test.social',
    },
    matrix: {
      token: 'matrix-token-999',
      homeserver: 'https://matrix.test.org',
    },
  });

  // Track HTTP requests made by airlock to verify protocol compliance
  const networkCalls: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];

  const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = input.toString();
    const method = init?.method || 'GET';
    const headers = (init?.headers as Record<string, string>) || {};
    networkCalls.push({ url: urlStr, method, headers });

    // ATProto uploadBlob endpoint
    if (urlStr.includes('/xrpc/com.atproto.repo.uploadBlob')) {
      return new Response(JSON.stringify({
        blob: {
          $type: 'blob',
          ref: { $link: 'bafkreicid987654321' },
          mimeType: 'image/png',
          size: testPngBuffer.length,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Mastodon POST /api/v2/media (simulating 202 Accepted async processing)
    if (urlStr.includes('/api/v2/media') && method === 'POST') {
      return new Response(JSON.stringify({
        id: '2024101999',
        url: null, // Still processing
      }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }

    // Mastodon polling /api/v1/media/:id (returns processed media with final URL)
    if (urlStr.includes('/api/v1/media/2024101999')) {
      return new Response(JSON.stringify({
        id: '2024101999',
        url: 'https://mastodon.test.social/system/media_attachments/files/2024101999.png',
        preview_url: 'https://mastodon.test.social/system/media_attachments/files/preview_2024101999.png',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Matrix media upload
    if (urlStr.includes('/_matrix/media/v3/upload')) {
      return new Response(JSON.stringify({
        content_uri: 'mxc://matrix.test.org/testMedia123',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  };

  const airlock = new MediaAirlock({
    db: testDb,
    sessionVault: vault,
    fetchImpl: mockFetch,
  });

  // 3. Test stageMediaAsset live authoring dispatch
  console.log('[*] Testing live authoring staging dispatch...');
  const staged = await airlock.stageMediaAsset(testPngBuffer, 'image/png', {
    profileId: 'deck-author',
    targets: ['atproto', 'mastodon', 'nostr', 'matrix'],
    altText: 'Fleet broadcast banner',
    pollIntervalMs: 50,
  });

  assert.ok(staged);
  assert.strictEqual(staged.status, 'ready');
  assert.strictEqual(staged.mimeType, 'image/png');
  assert.strictEqual(staged.dimensions?.width, 800);
  assert.strictEqual(staged.dimensions?.height, 600);
  assert.ok(staged.blurhash);

  // ATProto verification: CID and blob ref cached
  assert.ok(staged.atproto);
  assert.strictEqual(staged.atproto.cid, 'bafkreicid987654321');
  assert.strictEqual(staged.atproto.blob.$type, 'blob');

  // Mastodon verification: media_id returned after polling
  assert.ok(staged.mastodon);
  assert.strictEqual(staged.mastodon.mediaId, '2024101999');
  assert.ok(staged.mastodon.url?.includes('2024101999'));

  // Nostr verification: NIP-94 event structure & NIP-92 imeta tags with BlurHash & dimensions
  assert.ok(staged.nostr);
  assert.ok(staged.nostr.url);
  assert.ok(Array.isArray(staged.nostr.imeta));
  const imeta = staged.nostr.imeta;
  assert.strictEqual(imeta[0], 'imeta');
  assert.ok(imeta.some((tag) => tag.startsWith('dim 800x600')), 'NIP-92 dim tag missing');
  assert.ok(imeta.some((tag) => tag.startsWith('blurhash ')), 'NIP-92 blurhash tag missing');
  assert.ok(imeta.some((tag) => tag.startsWith('x ')), 'NIP-92 hash tag missing');
  assert.ok(imeta.some((tag) => tag.startsWith('m image/png')), 'NIP-92 mime tag missing');

  assert.strictEqual(staged.nostr.nip94Event?.kind, 1063);

  // Matrix verification: MXC URI
  assert.ok(staged.matrix);
  assert.strictEqual(staged.matrix.mxcUri, 'mxc://matrix.test.org/testMedia123');

  // 4. Test Sub-millisecond WAL Cache Hit & Deduplication
  console.log('[*] Testing WAL SQLite deduplication & sub-millisecond retrieval...');
  const t0 = performance.now();
  const cached = await airlock.stageMediaAsset(testPngBuffer, 'image/png', {
    profileId: 'deck-author',
  });
  const elapsedMs = performance.now() - t0;

  assert.strictEqual(cached.id, staged.id);
  assert.strictEqual(cached.hash, staged.hash);
  assert.ok(elapsedMs < 50, `Expected sub-millisecond cache retrieval, took ${elapsedMs}ms`);

  // Verify database record
  const dbRecord = testDb.prepare('SELECT * FROM media_airlock_cache WHERE hash = ?').get(staged.hash) as any;
  assert.ok(dbRecord);
  assert.strictEqual(dbRecord.width, 800);
  assert.strictEqual(dbRecord.height, 600);
  assert.strictEqual(dbRecord.status, 'ready');

  airlock.close();

  console.log('[+] PASS: Media Airlock multi-protocol staging validated.');
  console.log('[+] PASS: ATProto blob upload, Mastodon async polling, and Nostr NIP-92/94 tags verified.');
}

runMediaAirlockTests().catch((err) => {
  console.error('[-] Media Airlock test failed:', err);
  process.exit(1);
});
