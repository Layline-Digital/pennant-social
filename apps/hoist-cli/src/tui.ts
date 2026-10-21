import readline from 'node:readline';
import { SessionVault } from '../../../packages/core/src/crypto/session-vault.ts';
import Database from 'better-sqlite3';

export class HoistTUI {
  private db: Database.Database | null = null;
  private vault: SessionVault;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor() {
    this.vault = new SessionVault();
    try { this.vault.hydrateFromEnv(); } catch (e) {}
    const dbPath = process.env.PENNANT_DB_PATH || './pennant.db';
    try { this.db = new Database(dbPath); } catch (e) { this.db = null; }
  }

  public startInteractive() { return this.start(); }
  public start() {
    this.isRunning = true;
    process.stdout.write('\x1b[?1049h'); // Enter alternate screen buffer
    process.stdout.write('\x1b[?25l');   // Hide cursor

    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.on('keypress', (str, key) => {
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
    process.stdout.write('\x1b[?25h');   // Show cursor
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write('\x1b[?1049l'); // Exit alternate screen buffer
  }

  private render() {
    if (!this.isRunning) return;
    const rows = process.stdout.rows || 24;
    let queueStats = { pending: 0, staging: 0, dispatched: 0, partial: 0, failed: 0 };
    let recentLedger: any[] = [];

    if (this.db) {
      try {
        const counts = this.db.prepare("SELECT status, count(*) as cnt FROM broadcast_queue GROUP BY status").all() as any[];
        counts.forEach(c => {
          if (c.status in queueStats) (queueStats as any)[c.status] = c.cnt;
        });
        recentLedger = this.db.prepare(
          "SELECT status_code, protocol, profile_id, dispatched_at FROM broadcast_ledger ORDER BY dispatched_at DESC LIMIT 4"
        ).all() as any[];
      } catch (e) {}
    }

    const profiles = this.vault.listPublicProfiles();
    const maxProfiles = Math.max(3, rows - 18);
    const visibleProfiles = profiles.slice(0, maxProfiles);

    let buf = '\x1b[H\x1b[2J'; // Clear screen & position cursor at home

    buf += '\x1b[36m ____  _____ _   _ _   _    _    _   _ _____   _   _  ___ ___ ____ _____ \n';
    buf += '|  _ \\| ____| \\ | | \\ | |  / \\  | \\ | |_   _| | | | |/ _ \\_ _/ ___|_   _|\n';
    buf += '| |_) |  _| |  \\| |  \\| | / _ \\ |  \\| | | |   | |_| | | | | |\\___ \\ | |  \n';
    buf += '|_|   |_____|_| \\_|_| \\_|/_/   \\_\\_| \\_| |_|   |_| |_|\\___/___|____/ |_|  \x1b[0m\n';
    buf += '\x1b[90mSovereign Quad-Protocol Command Console :: Layline Digital :: MIT License\x1b[0m\n\n';

    buf += '\x1b[1m┌── SYSTEM TELEMETRY ────────────────────────────────────────────────────────┐\x1b[0m\n';
    buf += '│ Active Profiles: \x1b[32m' + String(profiles.length).padEnd(4) + '\x1b[0m│ Pending Queue: \x1b[33m' + String(queueStats.pending).padEnd(4) + '\x1b[0m│ Failed: \x1b[31m' + String(queueStats.failed).padEnd(4) + '\x1b[0m│ Streams: \x1b[36m4   \x1b[0m│\n';
    buf += '└─── Last Refreshed: ' + new Date().toLocaleTimeString() + ' ─────────────────────────────────────┘\n\n';

    buf += '\x1b[1mCONNECTED IDENTITIES (' + profiles.length + ' total, showing top ' + visibleProfiles.length + '):\x1b[0m\n';
    visibleProfiles.forEach(p => {
      buf += ' \x1b[32m●\x1b[0m ' + p.id.padEnd(16) + ' [' + p.protocol.padEnd(8) + '] ' + p.label + '\n';
    });
    if (profiles.length > visibleProfiles.length) {
      buf += ' \x1b[90m... and ' + (profiles.length - visibleProfiles.length) + ' more profiles (expand terminal window to see more)\x1b[0m\n';
    }

    buf += '\n\x1b[1mOUTBOX DELIVERY LEDGER (RECENT DISPATCHES):\x1b[0m\n';
    if (recentLedger.length === 0) {
      buf += ' \x1b[90mNo recent dispatches in ledger.\x1b[0m\n';
    } else {
      recentLedger.forEach(l => {
        const color = (l.status_code >= 200 && l.status_code < 300) ? '\x1b[32m' : '\x1b[31m';
        buf += ' [' + color + l.status_code + '\x1b[0m] ' + l.protocol.toUpperCase().padEnd(9) + ' ' + l.profile_id.padEnd(14) + ' @ ' + l.dispatched_at + '\n';
      });
    }

    buf += '\n\x1b[90mCommands: [r] Refresh  [q] Quit  │ Web Console: http://localhost:7420\x1b[0m';
    process.stdout.write(buf);
  }
}

if (process.argv[1]?.endsWith('tui.ts') || process.argv.includes('--tui')) {
  const tui = new HoistTUI();
  tui.start();
}


