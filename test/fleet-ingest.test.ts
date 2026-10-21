import assert from 'node:assert';
import http from 'node:http';
import Database from 'better-sqlite3';
import { handleBroadcastIngestRequest } from '../packages/core/src/adapters/fleet-ingest.ts';

console.log('[*] Testing Generic Broadcast Ingest Webhook...');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE broadcast_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL,
    status TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

process.env.PENNANT_INGEST_API_KEY = 'test_secret_key_123';

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/api/ingest/broadcast' || req.url === '/api/ingest/fleet')) {
    handleBroadcastIngestRequest(req, res, db);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(0, '127.0.0.1', async () => {
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api/ingest/broadcast`;

  // Test 1: Reject unauthorized
  const unauth = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: 'test', message: 'hello' })
  });
  assert.strictEqual(unauth.status, 401, 'Expected 401 Unauthorized');
  console.log('[+] PASS: 401 on missing auth token');

  // Test 2: Successful enqueue from generic third-party CMS/webhook
  const success = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer test_secret_key_123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      source: 'headless-cms',
      profileId: 'brand_announcements',
      message: 'New product release live on production!',
      targets: ['bluesky', 'mastodon']
    })
  });
  assert.strictEqual(success.status, 200, 'Expected 200 OK');
  const resData = await success.json() as any;
  assert.strictEqual(resData.success, true);
  assert.strictEqual(resData.status, 'pending');
  console.log('[+] PASS: Generic webhook broadcast enqueued successfully');

  // Verify in SQLite
  const row = db.prepare('SELECT * FROM broadcast_queue WHERE id = ?').get(resData.queueId) as any;
  assert.ok(row, 'Row exists in SQLite');
  assert.strictEqual(row.profile_id, 'brand_announcements');
  console.log('[+] PASS: Verified SQLite record persistence');

  server.close();
});

