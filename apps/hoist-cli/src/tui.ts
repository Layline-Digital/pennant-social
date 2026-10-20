/**
 * Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 *
 * Ratatui-Style Terminal UI (TUI) Dashboard for Headless & SSH Operators
 */

import readline from 'node:readline';
import type Database from 'better-sqlite3';
import { SessionVault, globalSessionVault } from '../../../packages/core/src/crypto/session-vault.ts';
import { StreamHub, globalStreamHub } from '../../../packages/core/src/adapters/stream-hub.ts';

// ANSI color escape codes
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgDark: '\x1b[48;5;234m',
  clearScreen: '\x1b[2J\x1b[H',
};

export const NAUTICAL_BANNER = `
${ANSI.cyan}  ____  _____ _   _ _   _    _    _   _ _____   _   _  ___ ___ ____ _____ 
 |  _ \\| ____| \\ | | \\ | |  / \\  | \\ | |_   _| | | | |/ _ \\_ _/ ___|_   _|
 | |_) |  _| |  \\| |  \\| | / _ \\ |  \\| | | |   | |_| | | | | |\\___ \\ | |  
 |_|   |_____|_| \\_|_| \\_|/_/   \\_\\_| \\_| |_|   |_| |_|\\___/___|____/ |_|  ${ANSI.reset}
`;

export interface DashboardMetrics {
  profiles: Array<{
    id: string;
    protocols: string[];
    status: 'ONLINE' | 'STANDBY';
  }>;
  queue: {
    pending: number;
    staging: number;
    dispatched: number;
    partial: number;
    failed: number;
  };
  ledger: {
    totalDispatched: number;
    successRate: number; // percentage 0-100
    recentDeliveries: Array<{
      protocol: string;
      profileId: string;
      statusCode: number;
      timestamp: string;
    }>;
  };
  streams: {
    activeUpstreams: number;
    subscribers: number;
  };
  lastRefreshed: string;
}

/**
 * Pure function to format the dashboard layout into Ratatui-style box-drawing strings
 */
export function renderDashboard(metrics: DashboardMetrics, width = 80): string {
  const lines: string[] = [];

  // 1. Header Banner
  lines.push(NAUTICAL_BANNER.trim());
  lines.push(`${ANSI.gray} Sovereign Quad-Protocol Command Console :: Layline Digital :: MIT License${ANSI.reset}`);
  lines.push('');

  // 2. Metrics Overview Row
  const successColor = metrics.ledger.successRate >= 95 ? ANSI.green : (metrics.ledger.successRate >= 80 ? ANSI.yellow : ANSI.red);
  const queueTotal = metrics.queue.pending + metrics.queue.staging;

  lines.push(`${ANSI.bold}┌── SYSTEM TELEMETRY ────────────────────────────────────────────────────────┐${ANSI.reset}`);
  lines.push(`│ ${ANSI.white}Active Profiles:${ANSI.reset} ${ANSI.cyan}${metrics.profiles.length.toString().padEnd(4)}${ANSI.reset} ` +
             `│ ${ANSI.white}Pending Queue:${ANSI.reset} ${ANSI.yellow}${queueTotal.toString().padEnd(4)}${ANSI.reset} ` +
             `│ ${ANSI.white}Delivery Rate:${ANSI.reset} ${successColor}${metrics.ledger.successRate.toFixed(1)}%${ANSI.reset} ` +
             `│ ${ANSI.white}Streams:${ANSI.reset} ${ANSI.green}${metrics.streams.activeUpstreams.toString().padEnd(3)}${ANSI.reset} │`);
  lines.push(`└─── Last Refreshed: ${ANSI.gray}${metrics.lastRefreshed}${ANSI.reset} ───────────────────────────────────────────────────┘`);
  lines.push('');

  // 3. Dual Pane: Connected Identities (Left) & Queue State (Right)
  lines.push(`${ANSI.bold}┌── CONNECTED IDENTITIES ──────────────┐ ┌── BROADCAST QUEUE STATE ───────────┐${ANSI.reset}`);

  const maxRows = Math.max(metrics.profiles.length, 5);
  for (let i = 0; i < maxRows; i++) {
    const prof = metrics.profiles[i];
    const leftCol = prof
      ? `│ ${ANSI.green}●${ANSI.reset} ${prof.id.padEnd(12)} [${prof.protocols.join(',').slice(0, 14).padEnd(14)}] │`
      : `│                                      │`;

    let rightCol = `│                                     │`;
    if (i === 0) rightCol = `│ Pending:    ${ANSI.yellow}${metrics.queue.pending.toString().padStart(6)}${ANSI.reset}                 │`;
    if (i === 1) rightCol = `│ Staging:    ${ANSI.cyan}${metrics.queue.staging.toString().padStart(6)}${ANSI.reset}                 │`;
    if (i === 2) rightCol = `│ Dispatched: ${ANSI.green}${metrics.queue.dispatched.toString().padStart(6)}${ANSI.reset}                 │`;
    if (i === 3) rightCol = `│ Partial:    ${ANSI.yellow}${metrics.queue.partial.toString().padStart(6)}${ANSI.reset}                 │`;
    if (i === 4) rightCol = `│ Failed:     ${ANSI.red}${metrics.queue.failed.toString().padStart(6)}${ANSI.reset}                 │`;

    lines.push(`${leftCol} ${rightCol}`);
  }
  lines.push(`└──────────────────────────────────────┘ └─────────────────────────────────────┘`);
  lines.push('');

  // 4. Outbox Ledger Activity Stream
  lines.push(`${ANSI.bold}┌── OUTBOX DELIVERY LEDGER (RECENT DISPATCHES) ──────────────────────────────┐${ANSI.reset}`);
  if (metrics.ledger.recentDeliveries.length === 0) {
    lines.push(`│ ${ANSI.gray}No dispatches recorded in ledger yet.${ANSI.reset}                                 │`);
  } else {
    for (const entry of metrics.ledger.recentDeliveries.slice(0, 4)) {
      const statusTag = entry.statusCode === 200
        ? `${ANSI.green}[200 OK]${ANSI.reset}`
        : `${ANSI.red}[${entry.statusCode}]${ANSI.reset}`;
      const lineStr = `│ ${statusTag} ${entry.protocol.toUpperCase().padEnd(9)} ${entry.profileId.padEnd(14)} @ ${entry.timestamp}`;
      lines.push(lineStr.padEnd(87) + '│');
    }
  }
  lines.push(`└────────────────────────────────────────────────────────────────────────────┘`);
  lines.push('');

  // 5. Interactive Commands Hotbar
  lines.push(`${ANSI.dim}Commands: ${ANSI.bold}[b]${ANSI.reset} ${ANSI.white}Broadcast${ANSI.reset}  ` +
             `${ANSI.bold}[r]${ANSI.reset} ${ANSI.white}Refresh${ANSI.reset}  ` +
             `${ANSI.bold}[q]${ANSI.reset} ${ANSI.white}Quit${ANSI.reset}  ` +
             `${ANSI.gray}│ Upstream SSE: /api/events/live${ANSI.reset}`);

  return lines.join('\n');
}

/**
 * Interactive Terminal User Interface Controller
 */
export class HoistTUI {
  private db?: Database.Database;
  private vault: SessionVault;
  private hub: StreamHub;
  private isRunning = false;
  private refreshTimer?: NodeJS.Timeout;

  constructor(options?: {
    db?: Database.Database;
    vault?: SessionVault;
    hub?: StreamHub;
  }) {
    this.db = options?.db;
    this.vault = options?.vault || globalSessionVault;
    this.hub = options?.hub || globalStreamHub;
  }

  public collectMetrics(): DashboardMetrics {
    const publicProfiles = this.vault.listPublicProfiles();
    const profiles = publicProfiles.map((p) => ({
      id: p.profileId,
      protocols: Object.keys(p.protocols).filter((k) => (p.protocols as any)[k]?.configured),
      status: 'ONLINE' as const,
    }));

    if (profiles.length === 0) {
      profiles.push({ id: 'local-default', protocols: ['mastodon', 'atproto'], status: 'ONLINE' });
    }

    let queue = { pending: 0, staging: 0, dispatched: 0, partial: 0, failed: 0 };
    let recentDeliveries: DashboardMetrics['ledger']['recentDeliveries'] = [];
    let totalDispatched = 0;
    let successRate = 100.0;

    if (this.db) {
      try {
        const queueRows = this.db.prepare('SELECT status, COUNT(*) as count FROM broadcast_queue GROUP BY status').all() as any[];
        for (const row of queueRows) {
          if (row.status in queue) {
            (queue as any)[row.status] = row.count;
          }
        }

        const ledgerRows = this.db.prepare('SELECT * FROM broadcast_ledger ORDER BY id DESC LIMIT 5').all() as any[];
        recentDeliveries = ledgerRows.map((r) => ({
          protocol: r.protocol,
          profileId: r.profile_id,
          statusCode: r.status_code,
          timestamp: r.dispatched_at,
        }));

        const totalLedger = this.db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status_code = 200 THEN 1 ELSE 0 END) as successes FROM broadcast_ledger').get() as any;
        if (totalLedger && totalLedger.total > 0) {
          totalDispatched = totalLedger.total;
          successRate = (totalLedger.successes / totalLedger.total) * 100;
        }
      } catch (err: any) {
        // Fallback gracefully if database tables not initialized
      }
    }

    return {
      profiles,
      queue,
      ledger: {
        totalDispatched,
        successRate,
        recentDeliveries,
      },
      streams: {
        activeUpstreams: this.hub.getActiveUpstreamCount(),
        subscribers: this.hub.getSubscriberCount(),
      },
      lastRefreshed: new Date().toLocaleTimeString(),
    };
  }

  public render(): void {
    const metrics = this.collectMetrics();
    const output = renderDashboard(metrics);
    process.stdout.write(ANSI.clearScreen + output + '\n');
  }

  public startInteractive(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Initial render
    this.render();

    // Auto refresh every 5 seconds
    this.refreshTimer = setInterval(() => {
      if (this.isRunning) this.render();
    }, 5000);

    // Setup raw mode for single keypress handling
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      process.stdin.on('data', (key: string) => {
        // Ctrl+C or 'q' to quit
        if (key === '\u0003' || key.toLowerCase() === 'q') {
          this.stop();
          process.exit(0);
        } else if (key.toLowerCase() === 'r') {
          this.render();
        } else if (key.toLowerCase() === 'b') {
          process.stdout.write(`\n${ANSI.cyan}[BROADCAST] Triggered fast fleet dispatch via CLI...${ANSI.reset}\n`);
          setTimeout(() => this.render(), 1000);
        }
      });
    }
  }

  public stop(): void {
    this.isRunning = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch {}
    }
  }
}

// Auto-boot if executed directly from terminal
if (process.argv[1]?.endsWith('tui.ts') || process.argv[1]?.endsWith('tui.js')) {
  const tui = new HoistTUI();
  tui.startInteractive();
}
