import assert from 'node:assert';
import http from 'node:http';
import Database from 'better-sqlite3';
import { handleFleetIngestRequest } from '../packages/core/src/adapters/fleet-ingest.js';

console.log('[*] Testing Fleet Ingest Handler...');

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

process.env.PENNANT_FLEET_INGEST_KEY = 'test_secret_key_123';

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/ingest/fleet') {
    handleFleetIngestRequest(req, res, db);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(0, '127.0.0.1', async () => {
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api/ingest/fleet`;

  // Test 1: Reject unauthorized
  const unauth = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: 'test', message: 'hello' })
  });
  assert.strictEqual(unauth.status, 401, 'Expected 401 Unauthorized');
  console.log('[+] PASS: 401 on missing auth token');

  // Test 2: Successful enqueue
  const success = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer test_secret_key_123',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      source: 'sailing-almanac',
      profileId: 'almanac_main',
      message: 'Weekly Tide Report is live!',
      targets: ['bluesky', 'mastodon']
    })
  });
  assert.strictEqual(success.status, 200, 'Expected 200 OK');
  const resData = await success.json() as any;
  assert.strictEqual(resData.success, true);
  assert.strictEqual(resData.status, 'pending');
  console.log('[+] PASS: Authorized fleet ingestion enqueued successfully');

  // Verify in SQLite
  const row = db.prepare('SELECT * FROM broadcast_queue WHERE id = ?').get(resData.queueId) as any;
  assert.ok(row, 'Row exists in SQLite');
  assert.strictEqual(row.profile_id, 'almanac_main');
  console.log('[+] PASS: SQLite record verified in WAL queue');

  server.close();
});
