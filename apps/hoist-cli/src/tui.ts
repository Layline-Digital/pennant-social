#!/usr/bin/env node
/**
 * Pennant Hoist Terminal TUI
 * Attribution: Alan Woodyard <alan@alanwoodyard.com> | MIT License
 */
import readline from 'node:readline';
import path from 'node:path';
import { SessionVault } from '../../../packages/core/src/crypto/session-vault.ts';
import Database from 'better-sqlite3';

function stripAnsi(str: string): string {
  return String(str).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function fit(str: string, width: number): string {
  const visible = stripAnsi(str);
  if (visible.length > width) {
    return visible.slice(0, width - 1) + '…';
  }
  return str + ' '.repeat(Math.max(0, width - visible.length));
}

function resolveProfile(p: any): { proto: string; label: string } {
  if (typeof p === 'string') return { proto: 'PENN', label: p };
  if (!p || typeof p !== 'object') return { proto: '????', label: String(p) };

  let proto = 'PENN';
  const rawProto = (p.protocol || p.platform || p.networkType || p.type || p.service || '').toLowerCase();
  const protocols = Array.isArray(p.protocols) ? p.protocols.map((x: any) => String(x).toLowerCase()) : [];
  const targets = Array.isArray(p.targets) ? p.targets.map((x: any) => String(x).toLowerCase()) : [];
  const allProtos = [rawProto, ...protocols, ...targets].join(' ');

  const hasBlue = allProtos.includes('blue') || allProtos.includes('atproto') || !!p.did;
  const hasMasto = allProtos.includes('masto') || allProtos.includes('activitypub') || !!p.instance;
  const hasNostr = allProtos.includes('nostr') || !!p.nsec || !!p.npub;

  if (hasBlue && hasMasto && hasNostr) proto = 'TRI ';
  else if (hasBlue && hasMasto) proto = 'B+M ';
  else if (hasBlue) proto = 'BLUE';
  else if (hasMasto) proto = 'MAST';
  else if (hasNostr) proto = 'NOST';
  else if (rawProto) proto = rawProto.toUpperCase().slice(0, 4);

  const label = p.handle || p.name || p.username || p.displayName || p.account || p.profileId || p.profile_id || p.identifier || p.id || 'unnamed';
  return { proto, label: String(label) };
}

export class HoistTUI {
  private db: any = null;
  private vault: any;
  private timer: any = null;
  private isRunning = false;

  constructor(existingVault?: any, existingDb?: any) {
    if (existingVault && typeof existingVault.listPublicProfiles === 'function') {
      this.vault = existingVault;
    } else {
      this.vault = new SessionVault();
      try {
        const envPath = path.resolve(process.cwd(), '.env.broadcaster');
        this.vault.hydrateFromEnv(envPath);
      } catch (e) {}
    }

    if (existingDb) {
      this.db = existingDb;
    } else {
      const dbPath = process.env.PENNANT_DB_PATH || path.resolve(process.cwd(), 'pennant.db');
      try {
        const DBClass: any = typeof Database === 'function' ? Database : (Database as any).default;
        this.db = new DBClass(dbPath);
      } catch (e) {
        this.db = null;
      }
    }
  }

  public startInteractive() {
    this.start();
  }

  public start() {
    this.isRunning = true;
    process.stdout.write('\x1b[?1049h');
    process.stdout.write('\x1b[?25l');

    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.on('keypress', (_str, key) => {
        if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
          this.stop();
          process.exit(0);
        } else if (key.name === 'r') {
          this.render();
        }
      });
    }

    this.render();
    this.timer = setInterval(() => this.render(), 2000);
    process.on('SIGINT', () => { this.stop(); process.exit(0); });
    process.on('exit', () => { this.stop(); });
  }

  public stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) clearInterval(this.timer);
    process.stdout.write('\x1b[?25h');
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch (e) {}
    }
    process.stdout.write('\x1b[?1049l');
  }

  private render() {
    if (!this.isRunning) return;
    const termRows = process.stdout.rows || 28;

    let queueStats = { pending: 0, staging: 0, dispatched: 0, partial: 0, failed: 0 };
    let recentLedger: any[] = [];

    if (this.db) {
      try {
        const counts = this.db.prepare("SELECT status, count(*) as cnt FROM broadcast_queue GROUP BY status").all();
        counts.forEach((c: any) => {
          const s = String(c.status).toLowerCase();
          if (s in queueStats) (queueStats as any)[s] = c.cnt;
        });
      } catch (e) {}

      try {
        recentLedger = this.db.prepare("SELECT * FROM broadcast_ledger ORDER BY rowid DESC LIMIT 8").all();
      } catch (e) {}
    }

    const rawProfiles = this.vault ? this.vault.listPublicProfiles() : [];
    const capacity = Math.max(8, termRows - 16);
    const visibleProfiles = rawProfiles.slice(0, capacity);

    const timeStr = new Date().toLocaleTimeString();

    let out = '\x1b[H\x1b[2J';

    // Banner
    out += '\x1b[36m ____  _____ _   _ _   _    _    _   _ _____   _   _  ___ ___ ____ _____ \n';
    out += '|  _ \\| ____| \\ | | \\ | |  / \\  | \\ | |_   _| | | | |/ _ \\_ _/ ___|_   _|\n';
    out += '| |_) |  _| |  \\| |  \\| | / _ \\ |  \\| | | |   | |_| | | | | |\\___ \\ | |  \n';
    out += '|  __/| |___| |\\  | |\\  |/ ___ \\| |\\  | | |   |  _  | |_| | | ___) || |  \n';
    out += '|_|   |_____|_| \\_|_| \\_/_/   \\_\\_| \\_| |_|   |_| |_|\\___/___|____/ |_|  \x1b[0m\n';
    out += '\x1b[90mSovereign Quad-Protocol Command Console :: Layline Digital :: MIT License\x1b[0m\n\n';

    // System Telemetry (Exactly 78 cols)
    out += '┌── SYSTEM TELEMETRY ────────────────────────────────────────────────────────┐\n';

    const pCount = '\x1b[32m' + rawProfiles.length + '\x1b[0m';
    const qCount = '\x1b[33m' + queueStats.pending + ' pending\x1b[0m / ' + (queueStats.failed > 0 ? '\x1b[31m' + queueStats.failed + ' fail\x1b[0m' : '\x1b[32m0 fail\x1b[0m');
    const sCount = '\x1b[36m4 active\x1b[0m';

    const col1 = fit('Active Profiles: ' + pCount, 24);
    const col2 = fit('Queue: ' + qCount, 30);
    const col3 = fit('Streams: ' + sCount, 18);

    out += '│ ' + col1 + ' ' + col2 + ' ' + col3 + ' │\n';
    out += '└── Last Refreshed: ' + fit(timeStr, 11) + '──────────────────────────────────────────────┘\n\n';

    // Lower Dual-Panes (Left 42 cols + Space 1 + Right 35 cols = 78 cols)
    out += '┌── ' + fit('IDENTITIES (' + rawProfiles.length + ')', 37) + '┐ ┌── ' + fit('QUEUE & DISPATCH', 30) + '┐\n';

    const rightRow0 = fit('Pending: \x1b[33m' + queueStats.pending + '\x1b[0m  Staging: \x1b[36m' + queueStats.staging + '\x1b[0m', 31);
    const rightRow1 = fit('Sent: \x1b[32m' + queueStats.dispatched + '\x1b[0m     Failed: \x1b[31m' + queueStats.failed + '\x1b[0m', 31);
    const rightDiv  = '├' + '─'.repeat(33) + '┤';
    const rightRow3 = fit('\x1b[1mRECENT DISPATCH LEDGER\x1b[0m', 31);

    const maxLines = Math.max(visibleProfiles.length, recentLedger.length + 4, 8);

    for (let i = 0; i < maxLines; i++) {
      // 1. Left Column (Identities) - ALWAYS exactly 38 visible characters
      let leftContent = '';
      if (i < visibleProfiles.length) {
        const resolved = resolveProfile(visibleProfiles[i]);
        leftContent = fit('\x1b[36m[' + resolved.proto + ']\x1b[0m ' + resolved.label, 38);
      } else if (i === 0 && visibleProfiles.length === 0) {
        leftContent = fit('\x1b[90m(No profiles in vault)\x1b[0m', 38);
      } else {
        leftContent = ' '.repeat(38);
      }

      // 2. Right Column (Queue & Ledger) - ALWAYS exactly 31 visible characters (or 35 for divider)
      let rightContent = '';
      let isDivider = false;

      if (i === 0) {
        rightContent = rightRow0;
      } else if (i === 1) {
        rightContent = rightRow1;
      } else if (i === 2) {
        rightContent = rightDiv;
        isDivider = true;
      } else if (i === 3) {
        rightContent = rightRow3;
      } else {
        const ledgerIdx = i - 4;
        if (ledgerIdx < recentLedger.length) {
          const entry = recentLedger[ledgerIdx];
          const code = entry.status_code || entry.status || 200;
          const codeColor = (code === 200 || code === 201) ? '\x1b[32m' : '\x1b[31m';
          const proto = (entry.protocol || entry.target || '').toUpperCase().slice(0, 4);
          const target = entry.profile_id || entry.account || '';
          rightContent = fit(codeColor + '[' + code + ']\x1b[0m ' + fit(proto, 4) + ' ' + target, 31);
        } else if (recentLedger.length === 0 && i === 4) {
          rightContent = fit('\x1b[90mNo dispatches recorded.\x1b[0m', 31);
        } else {
          rightContent = ' '.repeat(31);
        }
      }

      if (isDivider) {
        out += '│ ' + leftContent + ' │ ' + rightContent + '\n';
      } else {
        out += '│ ' + leftContent + ' │ │ ' + rightContent + ' │\n';
      }
    }

    out += '└───' + '─'.repeat(37) + '┘ └───' + '─'.repeat(30) + '┘\n\n';
    out += 'Commands: [r] Refresh   [q] Quit  |  Web Console: http://localhost:7420\n';

    process.stdout.write(out);
  }
}
