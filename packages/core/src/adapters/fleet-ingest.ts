import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { BroadcastDaemon } from '../queue/broadcast-daemon.js';

export interface IngestBroadcastPayload {
  source?: string; // Arbitrary source name (e.g. 'cms', 'rss-bot', 'ci-runner')
  profileId: string;
  targets?: ('mastodon' | 'bluesky' | 'nostr' | 'matrix')[];
  message: string;
  url?: string;
  scheduledFor?: string; // ISO-8601 string
  contentWarning?: string;
  tags?: string[];
}

export function handleBroadcastIngestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  daemon?: BroadcastDaemon
): void {
  const authHeader = req.headers['authorization'] || '';
  const expectedKey = process.env.PENNANT_INGEST_API_KEY || process.env.PENNANT_FLEET_INGEST_KEY || 'ps_ingest_dev_key';

  if (!authHeader.startsWith('Bearer ') || authHeader.slice(7).trim() !== expectedKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing PENNANT_INGEST_API_KEY' }));
    return;
  }

  let rawBody = '';
  req.on('data', chunk => { rawBody += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(rawBody) as IngestBroadcastPayload;
      if (!payload.profileId || !payload.message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Request: profileId and message are required' }));
        return;
      }

      const scheduledFor = payload.scheduledFor || new Date().toISOString();
      const payloadJson = JSON.stringify({
        source: payload.source || 'external-webhook',
        profileId: payload.profileId,
        targets: payload.targets || ['mastodon', 'bluesky', 'nostr'],
        message: payload.message,
        url: payload.url || '',
        contentWarning: payload.contentWarning || '',
        tags: payload.tags || []
      });

      const queueId = daemon 
        ? daemon.enqueue(payload)
        : (() => {
            const stmt = db.prepare(`
              INSERT INTO broadcast_queue (profile_id, status, scheduled_for, payload_json, attempts)
              VALUES (?, 'pending', ?, ?, 0)
            `);
            const info = stmt.run(payload.profileId, scheduledFor, payloadJson);
            return String(info.lastInsertRowid);
          })();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        queueId,
        status: 'pending',
        scheduledFor
      }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid JSON payload: ${err.message}` }));
    }
  });
}

// Backwards-compatibility alias
export const handleFleetIngestRequest = handleBroadcastIngestRequest;
