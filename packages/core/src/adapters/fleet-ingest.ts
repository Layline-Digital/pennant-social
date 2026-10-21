/**
 * Pennant Hoist - Sovereign Fleet Ingestion Harness
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 *
 * Secure ingestion harness allowing downstream fleet apps (The Sailing Almanac, Postmodern Cereal)
 * to programmatically enqueue broadcasts.
 */

import type http from 'node:http';
import type Database from 'better-sqlite3';
import type { BroadcastDaemon, BroadcastPayload, BroadcastTargetPayload } from '../queue/broadcast-daemon.ts';

export interface FleetIngestPayload {
  source: 'sailing-almanac' | 'postmodern-cereal' | 'fleet-worker';
  profileId: string;
  targets?: ('mastodon' | 'bluesky' | 'nostr' | 'matrix')[];
  message: string;
  url?: string;
  scheduledFor?: string; // ISO-8601, optional (defaults to immediate)
  contentWarning?: string; // For ActivityPub
  tags?: string[];
}

export interface FleetIngestReceipt {
  success: boolean;
  queueId: string;
  status: 'pending';
  scheduledFor: string;
}

const VALID_SOURCES = ['sailing-almanac', 'postmodern-cereal', 'fleet-worker'] as const;
const VALID_TARGETS = ['mastodon', 'bluesky', 'nostr', 'matrix'] as const;

export async function handleFleetIngestRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db?: Database.Database,
  broadcastDaemon?: BroadcastDaemon
): Promise<boolean> {
  const host = req.headers.host || 'localhost';
  const parsedUrl = new URL(req.url || '/', `http://${host}`);

  if (parsedUrl.pathname !== '/api/ingest/fleet') {
    return false;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return true;
  }

  // Authentication: Enforce Authorization: Bearer <PENNANT_FLEET_INGEST_KEY>
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  const expectedKey = process.env.PENNANT_FLEET_INGEST_KEY;

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: Missing or invalid Authorization header' }));
    return true;
  }

  const token = authHeader.slice(7).trim();
  if (!expectedKey || token !== expectedKey.trim()) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: Invalid Bearer token' }));
    return true;
  }

  // Read request body with 1MB size limit
  let bodyStr = '';
  try {
    bodyStr = await new Promise<string>((resolve, reject) => {
      let acc = '';
      let bytes = 0;
      const maxBytes = 1024 * 1024; // 1 MB
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          reject(new Error('Payload exceeds size limit'));
          return;
        }
        acc += chunk;
      });
      req.on('end', () => resolve(acc));
      req.on('error', reject);
    });
  } catch (err: any) {
    if (err.message === 'Payload exceeds size limit') {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload exceeds 1MB limit' }));
      return true;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Failed to read request body: ${err.message}` }));
    return true;
  }

  // Parse JSON
  let payload: any;
  try {
    payload = JSON.parse(bodyStr);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Malformed JSON payload' }));
    return true;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Payload must be a JSON object' }));
    return true;
  }

  // Validation: Required fields
  if (!payload.profileId || typeof payload.profileId !== 'string' || !payload.profileId.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid required field: profileId' }));
    return true;
  }

  if (!payload.message || typeof payload.message !== 'string' || !payload.message.trim()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid required field: message' }));
    return true;
  }

  // Validate source if provided
  if (payload.source !== undefined && !VALID_SOURCES.includes(payload.source)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Invalid source: '${payload.source}'. Must be one of: ${VALID_SOURCES.join(', ')}` }));
    return true;
  }

  // Validate targets if provided
  if (payload.targets !== undefined) {
    if (!Array.isArray(payload.targets) || payload.targets.some((t: any) => !VALID_TARGETS.includes(t))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid targets. Must be a subset of: ${VALID_TARGETS.join(', ')}` }));
      return true;
    }
  }

  // Validate scheduledFor if provided
  if (payload.scheduledFor !== undefined) {
    const parsedDate = new Date(payload.scheduledFor);
    if (isNaN(parsedDate.getTime())) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid scheduledFor: must be a valid ISO-8601 string' }));
      return true;
    }
  }

  const scheduledFor = payload.scheduledFor
    ? new Date(payload.scheduledFor).toISOString()
    : new Date().toISOString();

  const targets = (payload.targets && payload.targets.length > 0)
    ? payload.targets
    : ['mastodon', 'bluesky', 'nostr'];

  const ingestPayload: FleetIngestPayload = {
    source: payload.source || 'fleet-worker',
    profileId: payload.profileId.trim(),
    targets,
    message: payload.message.trim(),
    url: payload.url || undefined,
    scheduledFor,
    contentWarning: payload.contentWarning || undefined,
    tags: Array.isArray(payload.tags) ? payload.tags : undefined,
  };

  let queueId: number | string;

  if (broadcastDaemon) {
    queueId = broadcastDaemon.enqueue(ingestPayload, scheduledFor);
  } else if (db) {
    let fullText = ingestPayload.message;
    if (ingestPayload.url && !fullText.includes(ingestPayload.url)) {
      fullText = `${fullText}\n\n${ingestPayload.url}`;
    }
    if (ingestPayload.tags && ingestPayload.tags.length > 0) {
      const tagStr = ingestPayload.tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
      fullText = `${fullText}\n\n${tagStr}`;
    }

    const broadcastTargets: BroadcastTargetPayload[] = targets.map((proto: any) => ({
      profileId: ingestPayload.profileId,
      protocol: proto,
      text: fullText,
      contentWarning: proto === 'mastodon' ? ingestPayload.contentWarning : undefined,
    }));

    const broadcastPayload: BroadcastPayload = {
      targets: broadcastTargets,
      metadata: {
        source: ingestPayload.source,
        url: ingestPayload.url,
        tags: ingestPayload.tags,
        contentWarning: ingestPayload.contentWarning,
      },
    };

    const columns = (db.pragma('table_info(broadcast_queue)') as any[]).map((c: any) => c.name);
    let stmt;
    let info;
    if (columns.includes('account')) {
      stmt = db.prepare(`
        INSERT INTO broadcast_queue (account, message, url, targets, scheduled_at, status, scheduled_for, payload_json, attempts)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0)
      `);
      info = stmt.run(
        ingestPayload.profileId,
        fullText,
        ingestPayload.url || '',
        targets.join(','),
        scheduledFor,
        scheduledFor,
        JSON.stringify(broadcastPayload)
      );
    } else {
      stmt = db.prepare(`
        INSERT INTO broadcast_queue (status, scheduled_for, payload_json, attempts)
        VALUES ('pending', ?, ?, 0)
      `);
      info = stmt.run(scheduledFor, JSON.stringify(broadcastPayload));
    }
    queueId = Number(info.lastInsertRowid);
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Broadcast Daemon is offline' }));
    return true;
  }

  const receipt: FleetIngestReceipt = {
    success: true,
    queueId: String(queueId),
    status: 'pending',
    scheduledFor,
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(receipt));
  return true;
}
