/**
 * Pennant Hoist - StreamHub Ingestion Multiplexer Unit Tests
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 */

import assert from 'node:assert';
import http from 'node:http';
import {
  StreamHub,
  type NormalizedEvent,
} from '../packages/core/src/adapters/stream-hub.ts';

async function runStreamHubTests() {
  console.log('[*] Testing StreamHub Ingestion Multiplexer & Single-Connection SSE Fan-Out...');

  const hub = new StreamHub();

  // 1. Test Upstream Connection Multiplexing & Reference Counting
  console.log('[*] Testing upstream listener deduplication and ref-counting...');
  let upstreamStartCount = 0;
  let upstreamStopCount = 0;

  const mockFactory = (key: string) => {
    upstreamStartCount++;
    return () => {
      upstreamStopCount++;
    };
  };

  // First acquisition for mastodon:brand-alpha:timeline
  const l1 = hub.acquireUpstream('mastodon', 'brand-alpha', 'timeline', mockFactory);
  assert.strictEqual(l1.refCount, 1);
  assert.strictEqual(upstreamStartCount, 1);
  assert.strictEqual(hub.getActiveUpstreamCount(), 1);

  // Second acquisition for the same stream -> MUST NOT open a new upstream connection!
  const l2 = hub.acquireUpstream('mastodon', 'brand-alpha', 'timeline', mockFactory);
  assert.strictEqual(l2.refCount, 2);
  assert.strictEqual(upstreamStartCount, 1, 'Redundant upstream connection opened!');
  assert.strictEqual(hub.getActiveUpstreamCount(), 1);

  // Different stream -> should open a second listener
  const l3 = hub.acquireUpstream('atproto', 'brand-alpha', 'timeline', mockFactory);
  assert.strictEqual(l3.refCount, 1);
  assert.strictEqual(upstreamStartCount, 2);
  assert.strictEqual(hub.getActiveUpstreamCount(), 2);

  // Release l1 -> refCount becomes 1, stop NOT called
  const r1 = hub.releaseUpstream('mastodon', 'brand-alpha', 'timeline');
  assert.strictEqual(r1, false);
  assert.strictEqual(upstreamStopCount, 0);

  // Release l2 -> refCount becomes 0, stop called
  const r2 = hub.releaseUpstream('mastodon', 'brand-alpha', 'timeline');
  assert.strictEqual(r2, true);
  assert.strictEqual(upstreamStopCount, 1);
  assert.strictEqual(hub.getActiveUpstreamCount(), 1);

  // 2. Test HTTP SSE Server & Fan-Out to Multiple Connected Clients
  console.log('[*] Testing live SSE route /api/events/live and client fan-out...');
  const server = http.createServer(async (req, res) => {
    const handled = await hub.handleLiveEventsRoute(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  const port = address.port;

  // Client 1: Unfiltered (receives all events)
  const client1Res = await fetch(`http://127.0.0.1:${port}/api/events/live`);
  assert.strictEqual(client1Res.status, 200);
  assert.strictEqual(client1Res.headers.get('content-type'), 'text/event-stream');

  // Client 2: Filtered strictly to "atproto:brand-alpha:timeline"
  const client2Res = await fetch(
    `http://127.0.0.1:${port}/api/events/live?streams=atproto:brand-alpha:timeline`
  );
  assert.strictEqual(client2Res.status, 200);

  assert.strictEqual(hub.getSubscriberCount(), 2);

  const reader1 = client1Res.body?.getReader();
  const reader2 = client2Res.body?.getReader();

  // Read initial connection event
  const initChunk1 = await reader1?.read();
  const initText1 = new TextDecoder().decode(initChunk1?.value);
  assert.ok(initText1.includes('streamhub:connected'));

  const initChunk2 = await reader2?.read();
  const initText2 = new TextDecoder().decode(initChunk2?.value);
  assert.ok(initText2.includes('streamhub:connected'));

  // 3. Ingest Events & Verify Multiplexed Fan-Out
  console.log('[*] Ingesting normalized events across protocols...');

  // Event A: Mastodon event (should be received by Client 1, ignored by Client 2)
  const mastoEvent: NormalizedEvent = {
    id: 'evt-masto-1',
    protocol: 'mastodon',
    profileId: 'brand-alpha',
    streamType: 'timeline',
    type: 'post',
    timestamp: new Date().toISOString(),
    data: {
      content: 'Hello Mastodon federated network!',
      author: { name: 'Alpha', handle: '@alpha@social.pennant.io' },
    },
  };
  hub.ingestEvent(mastoEvent);

  // Client 1 should receive Event A
  const chunkA = await reader1?.read();
  const textA = new TextDecoder().decode(chunkA?.value);
  assert.ok(textA.includes('Hello Mastodon federated network!'));
  assert.ok(textA.includes('"streamId":"mastodon:brand-alpha:timeline"'));

  // Event B: ATProto event (should be received by BOTH Client 1 and Client 2)
  const bskyEvent: NormalizedEvent = {
    id: 'evt-bsky-1',
    protocol: 'atproto',
    profileId: 'brand-alpha',
    streamType: 'timeline',
    type: 'post',
    timestamp: new Date().toISOString(),
    data: {
      content: 'Hello Bluesky ATProto firehose!',
      author: { name: 'Alpha', handle: 'alpha.bsky.social' },
    },
  };
  hub.ingestEvent(bskyEvent);

  const chunkB1 = await reader1?.read();
  const textB1 = new TextDecoder().decode(chunkB1?.value);
  assert.ok(textB1.includes('Hello Bluesky ATProto firehose!'));

  const chunkB2 = await reader2?.read();
  const textB2 = new TextDecoder().decode(chunkB2?.value);
  assert.ok(textB2.includes('Hello Bluesky ATProto firehose!'));
  assert.ok(textB2.includes('"streamId":"atproto:brand-alpha:timeline"'));

  await reader1?.cancel();
  await reader2?.cancel();

  hub.close();
  server.close();

  console.log('[+] PASS: StreamHub connection multiplexing and SSE fan-out validated.');
}

runStreamHubTests().catch((err) => {
  console.error('[-] StreamHub test failed:', err);
  process.exit(1);
});
