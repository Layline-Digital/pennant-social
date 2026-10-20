/**
 * Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 *
 * In-Memory Multi-Identity Session Store & Dynamic Auth Proxy Router
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type SupportedProtocol = 'mastodon' | 'atproto' | 'nostr' | 'matrix' | 'activitypub' | 'bluesky';

export interface MastodonCredentials {
  token: string;
  instance: string;
}

export interface AtprotoCredentials {
  handle: string;
  password?: string;
  accessJwt?: string;
  refreshJwt?: string;
  did?: string;
  pdsUrl?: string;
}

export interface NostrCredentials {
  nsec?: string;
  hexPrivateKey?: string;
  npub?: string;
  pubkey?: string;
  relays?: string[];
}

export interface MatrixCredentials {
  token: string;
  homeserver: string;
  roomId?: string;
  userId?: string;
}

export interface ProfileCredentials {
  profileId: string;
  name?: string;
  mastodon?: MastodonCredentials;
  atproto?: AtprotoCredentials;
  nostr?: NostrCredentials;
  matrix?: MatrixCredentials;
  customHeaders?: Record<string, string>;
}

export interface PublicProtocolSummary {
  configured: boolean;
  instance?: string;
  handle?: string;
  did?: string;
  npub?: string;
  pubkey?: string;
  relays?: string[];
  homeserver?: string;
  roomId?: string;
}

export interface PublicSessionProfile {
  profileId: string;
  name: string;
  protocols: {
    mastodon?: PublicProtocolSummary;
    atproto?: PublicProtocolSummary;
    nostr?: PublicProtocolSummary;
    matrix?: PublicProtocolSummary;
  };
}

export interface UpstreamAuthHeader {
  headerName: string;
  headerValue: string;
  targetUrl?: string;
  protocol: SupportedProtocol;
}

/**
 * Minimal Bech32 decoder/encoder for Nostr keys (nsec / npub)
 * to avoid external dependency issues while preventing key leaks.
 */
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Decode(str: string): { prefix: string; words: number[] } | null {
  const lower = str.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length || lower.length > 90) return null;
  const prefix = lower.slice(0, sep);
  const data = lower.slice(sep + 1);
  const words: number[] = [];
  for (let i = 0; i < data.length - 6; i++) {
    const idx = BECH32_ALPHABET.indexOf(data[i]);
    if (idx === -1) return null;
    words.push(idx);
  }
  return { prefix, words };
}

function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null;
  }
  return ret;
}

export function nsecToHex(nsec: string): string | null {
  try {
    const decoded = bech32Decode(nsec);
    if (!decoded || decoded.prefix !== 'nsec') return null;
    const bytes = convertBits(decoded.words, 5, 8, false);
    if (!bytes) return null;
    return Buffer.from(bytes).toString('hex');
  } catch {
    return null;
  }
}

/**
 * Server-Side In-Memory Session Registry
 * Manages multi-protocol account credentials isolated from the browser.
 */
export class SessionVault {
  private profiles = new Map<string, ProfileCredentials>();
  private activeStreams = new Map<string, { profileId: string; columnId: string; startedAt: number }>();

  /**
   * Register or update a profile's credentials in memory.
   */
  public registerProfile(profile: ProfileCredentials): void {
    if (!profile.profileId) {
      throw new Error('Profile must contain a unique profileId');
    }
    const cleanId = profile.profileId.trim().toLowerCase();
    this.profiles.set(cleanId, {
      ...profile,
      profileId: cleanId,
      name: profile.name || cleanId,
    });
  }

  /**
   * Server-internal credential accessor. NEVER expose to API responses.
   */
  public getInternalCredentials(profileId: string): ProfileCredentials | undefined {
    return this.profiles.get(profileId.trim().toLowerCase());
  }

  public hasProfile(profileId: string): boolean {
    return this.profiles.has(profileId.trim().toLowerCase());
  }

  public removeProfile(profileId: string): boolean {
    return this.profiles.delete(profileId.trim().toLowerCase());
  }

  public getProfileCount(): number {
    return this.profiles.size;
  }

  /**
   * Returns a sanitized, public view of all registered profiles.
   * STRICT SECURITY GUARANTEE: Never includes bearer tokens, access JWTs, passwords, or nsec keys.
   */
  public listPublicProfiles(): PublicSessionProfile[] {
    const list: PublicSessionProfile[] = [];
    for (const [id, creds] of this.profiles.entries()) {
      const pub = this.sanitizeProfile(id, creds);
      list.push(pub);
    }
    return list;
  }

  /**
   * Get public profile by id without secrets.
   */
  public getPublicProfile(profileId: string): PublicSessionProfile | null {
    const creds = this.profiles.get(profileId.trim().toLowerCase());
    if (!creds) return null;
    return this.sanitizeProfile(profileId, creds);
  }

  private sanitizeProfile(id: string, creds: ProfileCredentials): PublicSessionProfile {
    const publicProfile: PublicSessionProfile = {
      profileId: id,
      name: creds.name || id,
      protocols: {},
    };

    if (creds.mastodon?.token) {
      publicProfile.protocols.mastodon = {
        configured: true,
        instance: creds.mastodon.instance || 'https://social.pennant.laylinedigital.com',
      };
    }

    if (creds.atproto?.handle) {
      publicProfile.protocols.atproto = {
        configured: true,
        handle: creds.atproto.handle,
        did: creds.atproto.did,
      };
    }

    if (creds.nostr?.nsec || creds.nostr?.pubkey || creds.nostr?.npub) {
      publicProfile.protocols.nostr = {
        configured: true,
        npub: creds.nostr.npub,
        pubkey: creds.nostr.pubkey,
        relays: creds.nostr.relays || ['wss://relay.damus.io', 'wss://nos.lol'],
      };
    }

    if (creds.matrix?.token) {
      publicProfile.protocols.matrix = {
        configured: true,
        homeserver: creds.matrix.homeserver,
        roomId: creds.matrix.roomId,
      };
    }

    return publicProfile;
  }

  /**
   * Parse environment variables (e.g. from .env.broadcaster) and hydrate the vault in memory.
   */
  public loadFromEnv(envSource: Record<string, string | undefined> | string): void {
    let envMap: Record<string, string> = {};

    if (typeof envSource === 'string') {
      const content = fs.existsSync(envSource) ? fs.readFileSync(envSource, 'utf-8') : envSource;
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        const k = trimmed.substring(0, eqIdx).trim();
        const v = trimmed.substring(eqIdx + 1).trim();
        envMap[k] = v;
      }
    } else {
      for (const [k, v] of Object.entries(envSource)) {
        if (v !== undefined) envMap[k] = v;
      }
    }

    // Discover accounts from keys
    const accounts = new Set<string>();
    for (const key of Object.keys(envMap)) {
      const match = key.match(/^(?:MASTO_TOKEN|BSKY_PASS|BSKY_HANDLE|NOSTR_NSEC|MATRIX_TOKEN)_([A-Z0-9_-]+)$/);
      if (match) {
        accounts.add(match[1]);
      }
    }

    if (accounts.size === 0 && (envMap['MASTO_TOKEN'] || envMap['MASTODON_TOKEN'] || envMap['BSKY_PASS'])) {
      accounts.add('DEFAULT');
    }

    for (const acct of accounts) {
      const profileId = acct.toLowerCase();
      const existing = this.profiles.get(profileId) || { profileId, name: acct };

      // Mastodon
      const mastoToken = envMap[`MASTO_TOKEN_${acct}`] || envMap['MASTO_TOKEN'] || envMap['MASTODON_TOKEN'];
      const mastoInstance = envMap[`MASTO_INSTANCE_${acct}`] || envMap['MASTODON_INSTANCE'] || 'https://social.pennant.laylinedigital.com';
      if (mastoToken) {
        existing.mastodon = {
          token: mastoToken,
          instance: mastoInstance,
        };
      }

      // Bluesky / ATProto
      const bskyHandle = envMap[`BSKY_HANDLE_${acct}`] || envMap['BSKY_HANDLE'] || `${profileId}.laylinedigital.com`;
      const bskyPass = envMap[`BSKY_PASS_${acct}`] || envMap['BSKY_PASS'];
      if (bskyPass) {
        existing.atproto = {
          handle: bskyHandle,
          password: bskyPass,
          pdsUrl: envMap['BSKY_PDS_URL'] || 'https://bsky.social',
        };
      }

      // Nostr
      const nostrNsec = envMap[`NOSTR_NSEC_${acct}`] || envMap['NOSTR_NSEC'];
      if (nostrNsec) {
        existing.nostr = {
          nsec: nostrNsec,
          relays: ['wss://relay.damus.io', 'wss://nos.lol'],
        };
      }

      // Matrix
      const matrixToken = envMap[`MATRIX_TOKEN_${acct}`] || envMap['MATRIX_TOKEN'];
      const matrixHs = envMap[`MATRIX_HOMESERVER_${acct}`] || envMap['MATRIX_HOMESERVER'] || 'https://matrix.org';
      const matrixRoom = envMap[`MATRIX_ROOM_ID_${acct}`] || envMap['MATRIX_ROOM_ID'];
      if (matrixToken) {
        existing.matrix = {
          token: matrixToken,
          homeserver: matrixHs,
          roomId: matrixRoom,
        };
      }

      this.registerProfile(existing);
    }
  }

  /**
   * Generates dynamic upstream authentication headers for an active stream or request.
   * Returns null if the specified protocol credentials are not configured.
   */
  public getUpstreamAuth(profileId: string, protocol: SupportedProtocol): UpstreamAuthHeader | null {
    const creds = this.getInternalCredentials(profileId);
    if (!creds) return null;

    const normProto = protocol.toLowerCase() as SupportedProtocol;

    switch (normProto) {
      case 'mastodon':
      case 'activitypub': {
        if (!creds.mastodon?.token) return null;
        return {
          protocol: 'mastodon',
          headerName: 'Authorization',
          headerValue: `Bearer ${creds.mastodon.token}`,
          targetUrl: creds.mastodon.instance,
        };
      }

      case 'atproto':
      case 'bluesky': {
        if (!creds.atproto) return null;
        const token = creds.atproto.accessJwt || creds.atproto.password;
        if (!token) return null;
        return {
          protocol: 'atproto',
          headerName: 'Authorization',
          headerValue: `Bearer ${token}`,
          targetUrl: creds.atproto.pdsUrl || 'https://bsky.social',
        };
      }

      case 'matrix': {
        if (!creds.matrix?.token) return null;
        return {
          protocol: 'matrix',
          headerName: 'Authorization',
          headerValue: `Bearer ${creds.matrix.token}`,
          targetUrl: creds.matrix.homeserver,
        };
      }

      case 'nostr': {
        if (!creds.nostr?.nsec && !creds.nostr?.hexPrivateKey) return null;
        const key = creds.nostr.nsec || creds.nostr.hexPrivateKey;
        return {
          protocol: 'nostr',
          headerName: 'X-Nostr-Identity',
          headerValue: `NostrSecret ${key?.slice(0, 8)}...[server-locked]`,
          targetUrl: creds.nostr.relays?.[0] || 'wss://relay.damus.io',
        };
      }

      default:
        return null;
    }
  }

  /**
   * Dynamic Stream API Router
   * Exposes /api/stream?profile=:profileId&column=:columnId
   * Attaches upstream auth header dynamically while keeping client credentials zero-knowledge.
   */
  public async handleStreamRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (reqUrl.pathname !== '/api/stream') {
      return false;
    }

    const profileId = reqUrl.searchParams.get('profile') || reqUrl.searchParams.get('profileId');
    const columnId = reqUrl.searchParams.get('column') || reqUrl.searchParams.get('columnId');
    const protocolReq = (reqUrl.searchParams.get('protocol') || 'mastodon').toLowerCase() as SupportedProtocol;

    if (!profileId || !columnId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameters: profile and column' }));
      return true;
    }

    const creds = this.getInternalCredentials(profileId);
    if (!creds) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Identity profile '${profileId}' not found in session vault` }));
      return true;
    }

    const upstreamAuth = this.getUpstreamAuth(profileId, protocolReq);
    if (!upstreamAuth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Protocol '${protocolReq}' credentials not configured for profile '${profileId}'` }));
      return true;
    }

    const streamKey = `${profileId}:${columnId}`;
    this.activeStreams.set(streamKey, { profileId, columnId, startedAt: Date.now() });

    // Establish Server-Sent Events (SSE) stream to client
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Pennant-Stream-Profile': profileId,
      'X-Pennant-Stream-Column': columnId,
      'X-Pennant-Upstream-Protocol': upstreamAuth.protocol,
    });

    // Send connection established event (Notice: upstream auth token is NOT emitted to client)
    const initEvent = {
      type: 'stream:connected',
      profileId,
      columnId,
      protocol: upstreamAuth.protocol,
      targetEndpoint: upstreamAuth.targetUrl,
      timestamp: new Date().toISOString(),
    };
    res.write(`event: init\ndata: ${JSON.stringify(initEvent)}\n\n`);

    // Periodic heartbeat / ping keep-alive
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(heartbeat);
        this.activeStreams.delete(streamKey);
        return;
      }
      res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      this.activeStreams.delete(streamKey);
    });

    return true;
  }

  public getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  public getActiveStreams(): Array<{ profileId: string; columnId: string; startedAt: number }> {
    return Array.from(this.activeStreams.values());
  }
}

// Global default singleton instance
export const globalSessionVault = new SessionVault();
