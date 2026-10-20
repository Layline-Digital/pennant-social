/**
 * Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 *
 * StreamHub Ingestion Multiplexer
 * Manages active upstream listeners by (protocol, accountId, streamType) without
 * opening redundant network connections, multiplexing events to a single SSE downstream route (/api/events/live).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { SessionVault, globalSessionVault } from '../crypto/session-vault.ts';

export type StreamProtocol = 'mastodon' | 'atproto' | 'nostr' | 'matrix';
export type StreamType = 'timeline' | 'notifications' | 'tag' | 'custom';

export interface NormalizedEvent {
  id: string;
  protocol: StreamProtocol;
  streamType: StreamType;
  profileId: string;
  type: 'post' | 'notification' | 'like' | 'repost' | 'follow' | 'reply';
  timestamp: string;
  data: {
    postId?: string;
    author: {
      name: string;
      handle: string;
      avatarUrl?: string;
    };
    content: string;
    media?: Array<{
      url: string;
      previewUrl?: string;
      width: number;
      height: number;
      blurhash?: string;
      mimeType?: string;
    }>;
    metrics?: {
      replies: number;
      reposts: number;
      likes: number;
    };
    replyToId?: string;
    raw?: any;
  };
}

export interface MultiplexedStreamEvent {
  streamId: string;
  profileId: string;
  event: NormalizedEvent;
}

export interface UpstreamListener {
  streamKey: string;
  protocol: StreamProtocol;
  profileId: string;
  streamType: StreamType;
  refCount: number;
  stop: () => void;
  startedAt: number;
}

export interface ClientSubscriber {
  id: string;
  res: http.ServerResponse;
  streamFilter?: Set<string>; // empty/undefined = all streams
  connectedAt: number;
}

export class StreamHub {
  private sessionVault: SessionVault;
  private upstreamListeners = new Map<string, UpstreamListener>();
  private clientSubscribers = new Map<string, ClientSubscriber>();
  private eventHistory: MultiplexedStreamEvent[] = [];
  private maxHistory = 100;

  constructor(options?: { sessionVault?: SessionVault }) {
    this.sessionVault = options?.sessionVault || globalSessionVault;
  }

  public static buildStreamKey(protocol: StreamProtocol, profileId: string, streamType: StreamType): string {
    return `${protocol.toLowerCase()}:${profileId.toLowerCase()}:${streamType.toLowerCase()}`;
  }

  /**
   * Subscribes to an upstream listener for (protocol, accountId, streamType).
   * Multiplexes existing upstream connections so redundant network calls are never opened.
   */
  public acquireUpstream(
    protocol: StreamProtocol,
    profileId: string,
    streamType: StreamType,
    factory?: (streamKey: string) => () => void
  ): UpstreamListener {
    const key = StreamHub.buildStreamKey(protocol, profileId, streamType);
    let listener = this.upstreamListeners.get(key);

    if (listener) {
      listener.refCount++;
      return listener;
    }

    // Initialize new upstream listener
    let stopFn = () => {};
    if (factory) {
      stopFn = factory(key);
    } else {
      // Default upstream mock/poller or stream connection handler
      stopFn = this.createDefaultUpstream(protocol, profileId, streamType);
    }

    listener = {
      streamKey: key,
      protocol,
      profileId: profileId.toLowerCase(),
      streamType,
      refCount: 1,
      stop: stopFn,
      startedAt: Date.now(),
    };

    this.upstreamListeners.set(key, listener);
    return listener;
  }

  /**
   * Releases reference to an upstream listener.
   * If refCount reaches 0, gracefully tears down upstream connection.
   */
  public releaseUpstream(protocol: StreamProtocol, profileId: string, streamType: StreamType): boolean {
    const key = StreamHub.buildStreamKey(protocol, profileId, streamType);
    const listener = this.upstreamListeners.get(key);
    if (!listener) return false;

    listener.refCount--;
    if (listener.refCount <= 0) {
      listener.stop();
      this.upstreamListeners.delete(key);
      return true;
    }
    return false;
  }

  public getActiveUpstreamCount(): number {
    return this.upstreamListeners.size;
  }

  public getActiveUpstreams(): UpstreamListener[] {
    return Array.from(this.upstreamListeners.values());
  }

  /**
   * Ingests a new normalized event from any upstream protocol
   * and fans out the multiplexed payload to all connected SSE clients.
   */
  public ingestEvent(event: NormalizedEvent): MultiplexedStreamEvent {
    const streamId = StreamHub.buildStreamKey(event.protocol, event.profileId, event.streamType);
    const multiplexed: MultiplexedStreamEvent = {
      streamId,
      profileId: event.profileId.toLowerCase(),
      event,
    };

    // Cache in circular ring buffer
    this.eventHistory.push(multiplexed);
    if (this.eventHistory.length > this.maxHistory) {
      this.eventHistory.shift();
    }

    // Broadcast to connected client SSE streams
    const payload = `data: ${JSON.stringify(multiplexed)}\n\n`;
    for (const [clientId, sub] of this.clientSubscribers.entries()) {
      if (sub.streamFilter && sub.streamFilter.size > 0 && !sub.streamFilter.has(streamId)) {
        continue;
      }
      try {
        if (!sub.res.writableEnded && !sub.res.destroyed) {
          sub.res.write(payload);
        } else {
          this.clientSubscribers.delete(clientId);
        }
      } catch {
        this.clientSubscribers.delete(clientId);
      }
    }

    return multiplexed;
  }

  /**
   * Server-Sent Events (SSE) Route Handler: /api/events/live
   * The frontend opens ONE single connection to this endpoint to receive events across all active columns.
   */
  public async handleLiveEventsRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (parsedUrl.pathname !== '/api/events/live') {
      return false;
    }

    const clientId = crypto.randomUUID();
    const streamsParam = parsedUrl.searchParams.get('streams');
    const filter = streamsParam
      ? new Set(streamsParam.split(',').map((s) => s.trim().toLowerCase()))
      : undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Pennant-Stream-Multiplexer': 'StreamHub/v1',
    });

    const subscriber: ClientSubscriber = {
      id: clientId,
      res,
      streamFilter: filter,
      connectedAt: Date.now(),
    };
    this.clientSubscribers.set(clientId, subscriber);

    // Initial connection event with active streams overview
    const initPayload = {
      type: 'streamhub:connected',
      clientId,
      activeUpstreams: Array.from(this.upstreamListeners.keys()),
      subscriberCount: this.clientSubscribers.size,
      timestamp: new Date().toISOString(),
    };
    res.write(`event: init\ndata: ${JSON.stringify(initPayload)}\n\n`);

    // Backfill recent matching history
    for (const historic of this.eventHistory) {
      if (!filter || filter.size === 0 || filter.has(historic.streamId)) {
        res.write(`data: ${JSON.stringify(historic)}\n\n`);
      }
    }

    // Keepalive heartbeat
    const pingTimer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(pingTimer);
        this.clientSubscribers.delete(clientId);
        return;
      }
      res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, 15000);

    req.on('close', () => {
      clearInterval(pingTimer);
      this.clientSubscribers.delete(clientId);
    });

    return true;
  }

  public getSubscriberCount(): number {
    return this.clientSubscribers.size;
  }

  private createDefaultUpstream(
    protocol: StreamProtocol,
    profileId: string,
    streamType: StreamType
  ): () => void {
    // Default upstream simulated/polled stream
    let active = true;
    return () => {
      active = false;
    };
  }

  public close(): void {
    for (const [id, sub] of this.clientSubscribers.entries()) {
      try {
        sub.res.end();
      } catch {}
    }
    this.clientSubscribers.clear();

    for (const listener of this.upstreamListeners.values()) {
      try {
        listener.stop();
      } catch {}
    }
    this.upstreamListeners.clear();
  }
}

export const globalStreamHub = new StreamHub();
