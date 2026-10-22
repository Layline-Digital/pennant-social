import readline from 'node:readline';
import path from 'node:path';
import { SessionVault } from '../../../packages/core/src/crypto/session-vault.ts';
import Database from 'better-sqlite3';

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function fit(str: string, width: number): string {
  const visible = stripAnsi(str);
  if (visible.length > width) {
    // Truncate cleanly with ellipsis
    const plain = visible.slice(0, width - 1) + '…';
    return plain;
  }
  return str + ' '.repeat(width - visible.length);
}

export class HoistTUI {
  private db: Database.Database | null = null;
  private vault: SessionVault;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(existingVault?: any) {
    if (existingVault && typeof existingVault.listPublicProfiles === 'function') {
      this.vault = existingVault;
    } else {
      this.vault = new SessionVault();
      try {
        const envPath = path.resolve(process.cwd(), '.env.broadcaster');
        this.vault.hydrateFromEnv(envPath);
      } catch (e) {}
    }

    const dbPath = process.env.PENNANT_DB_PATH || './pennant.db';
    try {
      this.db = new Database(dbPath);
    } catch (e) {
      this.db = null;
    }
  }

  public startInteractive() {
    this.start();
  }

  public start() {
    this.isRunning = true;
    process.stdout.write('\x1b[?1049h'); // Enter alternate screen buffer
    process.stdout.write('\x1b[?25l');   // Hide cursor

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
    process.stdout.write('\x1b[?25h');   // Show cursor
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch (e) {}
    }
    process.stdout.write('\x1b[?1049l'); // Exit alternate screen buffer
  }

  private render() {
    if (!this.isRunning) return;
    const termRows = process.stdout.rows || 28;

    let queueStats = { pending: 0, staging: 0, dispatched: 0, partial: 0, failed: 0 };
    let recentLedger: any[] = [];

    if (this.db) {
      try {
        const counts = this.db.prepare("SELECT status, count(*) as cnt FROM broadcast_queue GROUP BY status").all() as any[];
        counts.forEach(c => {
          if (c.status in queueStats) (queueStats as any)[c.status] = c.cnt;
        });
        recentLedger = this.db.prepare(
          "SELECT status_code, protocol, profile_id, dispatched_at FROM broadcast_ledger ORDER BY dispatched_at DESC LIMIT 6"
        ).all() as any[];
      } catch (e) {}
    }

    const profiles = this.vault.listPublicProfiles();
    const capacity = Math.max(6, termRows - 16);
    const visibleProfiles = profiles.slice(0, capacity);

    let out = '\x1b[H\x1b[2J'; // Home cursor & clear buffer

    // 1. Rock-solid block banner (Zero backslashes, impossible to misalign)
    out += '\x1b[36m' +
      '  ██████╗ ███████╗███╗   ██╗███╗   ██╗ █████╗ ███╗   ██╗████████╗  ██╗  ██╗ ██████╗ ██╗███████╗████████╗\n' +
      '  ██╔══██╗██╔════╝████╗  ██║████╗  ██║██╔══██╗████╗  ██║╚══██╔══╝  ██║  ██║██╔═══██╗██║██╔════╝╚══██╔══╝\n' +
      '  ██████╔╝█████╗  ██╔██╗ ██║██╔██╗ ██║███████║██╔██╗ ██║   ██║     ███████║██║   ██║██║███████╗   ██║   \n' +
      '  ██╔═══╝ ██╔══╝  ██║╚██╗██║██║╚██╗██║██╔══██║██║╚██╗██║   ██║     ██╔══██║██║   ██║██║╚════██║   ██║   \n' +
      '  ██║     ███████╗██║ ╚████║██║ ╚████║██║  ██║██║ ╚████║   ██║     ██║  ██║╚██████╔╝██║███████║   ██║   \n' +
      '  ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝╚══════╝   ╚═╝   \n' +
      '\x1b[0m';
    out += '  \x1b[90mSovereign Quad-Protocol Command Console  ::  Layline Digital  ::  MIT License\x1b[0m\n\n';

    // 2. Top Telemetry Card (Fixed 80-col box)
    const timeStr = new Date().toLocaleTimeString();
    out += '┌── SYSTEM TELEMETRY ────────────────────────────────────────────────────────┐\n';
    out += '│ ' +
      fit(`Active Profiles: \x1b[32m${profiles.length}\x1b[0m`, 24) +
      fit(`Queue: \x1b[33m${queueStats.pending}\x1b[0m pending / \x1b[31m${queueStats.failed}\x1b[0m fail`, 30) +
      fit(`Streams: \x1b[36m4 active\x1b[0m`, 21) +
      '│\n';
    out += '└── Last Refreshed: ' + fit(timeStr, 12) + '────────────────────────────────────────────────┘\n\n';

    // 3. Dual-Column Grid Setup: Left = 44 cols, Right = 33 cols (Total = 79 cols)
    const leftW = 44;
    const rightW = 33;
    const rowCount = Math.max(visibleProfiles.length, 7);

    // Header
    const leftHeader = `┌── IDENTITIES (${profiles.length}) ` + '─'.repeat(leftW - 19 - String(profiles.length).length) + '┐';
    const rightHeader = '┌── QUEUE & DISPATCH ' + '─'.repeat(rightW - 22) + '┐';
    out += leftHeader + '  ' + rightHeader + '\n';

    // Build row arrays
    const leftRows: string[] = [];
    visibleProfiles.forEach(p => {
      const icon = '\x1b[32m●\x1b[0m';
      const idStr = p.id.length > 14 ? p.id.slice(0, 13) + '…' : p.id;
      const protoStr = `[${p.protocol}]`;
      const cell = `${icon} ${idStr.padEnd(14)} ${protoStr.padEnd(12)}`;
      leftRows.push('│ ' + fit(cell, leftW - 4) + ' │');
    });
    while (leftRows.length < rowCount) {
      leftRows.push('│ ' + ' '.repeat(leftW - 4) + ' │');
    }

    const rightRows: string[] = [];
    // Row 0: Queue counts
    rightRows.push('│ ' + fit(`Pending: \x1b[33m${queueStats.pending}\x1b[0m  Staging: \x1b[36m${queueStats.staging}\x1b[0m`, rightW - 4) + ' │');
    // Row 1: Dispatch counts
    rightRows.push('│ ' + fit(`Sent: \x1b[32m${queueStats.dispatched}\x1b[0m     Failed: \x1b[31m${queueStats.failed}\x1b[0m`, rightW - 4) + ' │');
    // Row 2: Sub-divider
    rightRows.push('├' + '─'.repeat(rightW - 2) + '┤');
    // Row 3: Ledger title
    rightRows.push('│ ' + fit('\x1b[1mRECENT DISPATCH LEDGER\x1b[0m', rightW - 4) + ' │');

    // Rows 4+: Recent ledger entries
    if (recentLedger.length === 0) {
      rightRows.push('│ ' + fit('\x1b[90mNo dispatches recorded.\x1b[0m', rightW - 4) + ' │');
    } else {
      recentLedger.forEach(l => {
        const color = (l.status_code >= 200 && l.status_code < 300) ? '\x1b[32m' : '\x1b[31m';
        const line = `[${color}${l.status_code}\x1b[0m] ${l.protocol.slice(0, 5).toUpperCase()} ${l.profile_id.slice(0, 10)}`;
        rightRows.push('│ ' + fit(line, rightW - 4) + ' │');
      });
    }
    while (rightRows.length < rowCount) {
      rightRows.push('│ ' + ' '.repeat(rightW - 4) + ' │');
    }

    // Zip and print rows together
    for (let i = 0; i < rowCount; i++) {
      out += leftRows[i] + '  ' + rightRows[i] + '\n';
    }

    // Footers
    const leftFooter = '└' + '─'.repeat(leftW - 2) + '┘';
    const rightFooter = '└' + '─'.repeat(rightW - 2) + '┘';
    out += leftFooter + '  ' + rightFooter + '\n\n';

    // Commands Bar
    out += '\x1b[90mCommands: [r] Refresh  [q] Quit  │ Web Console: http://localhost:7420\x1b[0m';

    process.stdout.write(out);
  }
}

if (process.argv[1]?.endsWith('tui.ts') || process.argv.includes('--tui')) {
  const tui = new HoistTUI();
  tui.start();
}

