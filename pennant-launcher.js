#!/usr/bin/env node
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.js':
    case '.mjs': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.html': return 'text/html; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { globalSessionVault } from './packages/core/src/crypto/session-vault.ts';
import { MediaAirlock } from './packages/core/src/adapters/media-airlock.ts';
import { BroadcastDaemon } from './packages/core/src/queue/broadcast-daemon.ts';
import { globalStreamHub } from './packages/core/src/adapters/stream-hub.ts';
import { handleFleetIngestRequest } from './packages/core/src/adapters/fleet-ingest.ts';


const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Command-line flag parsing
export function parseLauncherFlags(args = process.argv.slice(2), env = process.env) {
  const isTui = args.includes('--tui');
  const isDaemon = args.includes('--daemon');
  const noBrowser = args.includes('--no-browser') || env.NO_BROWSER === '1' || env.HEADLESS === '1' || env.NODE_ENV === 'test';
  const port = Number(env.PORT || 7420);
  const host = env.HOST || (isDaemon ? '127.0.0.1' : 'localhost');

  return {
    isTui,
    isDaemon,
    noBrowser,
    port,
    host,
  };
}

const flags = parseLauncherFlags();
const IS_TUI_MODE = flags.isTui;
const IS_DAEMON_MODE = flags.isDaemon;
const NO_BROWSER = flags.noBrowser;
const PORT = flags.port;
const HOST = flags.host;
const MAX_SCHEDULE_REQUEST_BYTES = 1024 * 1024;

const DEFAULT_PROFILE_ROOT = path.join(os.homedir(), '.pennant', 'profiles');
const PROFILE_ROOT = path.resolve(process.env.PROFILE_ROOT || DEFAULT_PROFILE_ROOT);
fs.mkdirSync(PROFILE_ROOT, { recursive: true });

export function openDefaultBrowser(targetUrl, spawnFn = spawn) {
  const platform = os.platform();
  try {
    if (platform === 'win32') {
      spawnFn('cmd.exe', ['/c', 'start', '', targetUrl], { detached: true, stdio: 'ignore' })?.unref?.();
    } else if (platform === 'darwin') {
      spawnFn('open', [targetUrl], { detached: true, stdio: 'ignore' })?.unref?.();
    } else {
      spawnFn('xdg-open', [targetUrl], { detached: true, stdio: 'ignore' })?.unref?.();
    }
    return true;
  } catch (e) {
    console.warn('[-] Could not auto-open default browser:', e.message);
    return false;
  }
}

function detectBrowser() {
  for (const configuredPath of [process.env.ZEN_PATH, process.env.FIREFOX_PATH]) {
    if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  }

  const platform = os.platform();
  const candidates = [];

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    candidates.push(
      path.join(localAppData, 'Zen', 'zen.exe'),
      path.join(progFiles, 'Zen', 'zen.exe'),
      path.join(progFiles, 'Zen Browser', 'zen.exe'),
      path.join(progFilesX86, 'Zen', 'zen.exe'),
      path.join(progFiles, 'Mozilla Firefox', 'firefox.exe'),
      path.join(progFilesX86, 'Mozilla Firefox', 'firefox.exe')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Zen Browser.app/Contents/MacOS/zen',
      '/Applications/Zen.app/Contents/MacOS/zen',
      '/Applications/Firefox.app/Contents/MacOS/firefox'
    );
  } else {
    // Linux
    candidates.push(
      '/usr/bin/zen',
      '/usr/local/bin/zen',
      '/usr/bin/zen-browser',
      '/usr/bin/firefox',
      '/snap/bin/firefox'
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const BROWSER_PATH = detectBrowser();

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), '.pennant'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'pennant_schedule.db');
const PROFILES_PATH = path.resolve(process.env.PROFILES_FILE || path.join(APP_ROOT, 'profiles.json'));
const BROADCAST_SCRIPT = path.join(APP_ROOT, 'Publish-FleetBroadcast.ps1');

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS broadcast_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      message TEXT NOT NULL,
      url TEXT,
      image_path TEXT,
      targets TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      published_at TEXT,
      receipts TEXT,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch (e) {
  console.error("[-] Failed to open SQLite database:", e.message);
}

// Initialize Pennant Hoist Session Vault from broadcaster configuration
const broadcasterEnvPath = [
  path.join(APP_ROOT, '.env.broadcaster'),
  path.join(APP_ROOT, '..', '.env.broadcaster'),
  path.resolve('.env.broadcaster'),
].find(p => fs.existsSync(p));

if (broadcasterEnvPath) {
  try {
    const envLines = fs.readFileSync(broadcasterEnvPath, 'utf-8').split('\n');
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const k = trimmed.substring(0, idx).trim();
      const v = trimmed.substring(idx + 1).trim();
      if (process.env[k] === undefined) {
        process.env[k] = v;
      }
    }
    globalSessionVault.loadFromEnv(broadcasterEnvPath);
    console.log(`[VAULT] Hydrated in-memory session vault from ${path.basename(broadcasterEnvPath)} (${globalSessionVault.getProfileCount()} profiles)`);
  } catch (e) {
    console.warn('[VAULT] Could not load .env.broadcaster:', e.message);
  }
}

// Initialize Pennant Hoist Adaptive Media Airlock with WAL SQLite cache
const mediaAirlock = new MediaAirlock({
  db,
  sessionVault: globalSessionVault,
});

// Initialize Pennant Hoist Broadcast Daemon with WAL SQLite schema
let broadcastDaemon;
if (db) {
  try {
    broadcastDaemon = new BroadcastDaemon({
      db,
      sessionVault: globalSessionVault,
      mediaAirlock,
    });
    console.log('[DAEMON] SQLite Broadcast Queue & Ledger Daemon active');
  } catch (e) {
    console.warn('[DAEMON] Failed to initialize BroadcastDaemon:', e.message);
  }
}

function getProfiles() {
  if (fs.existsSync(PROFILES_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf-8'));
    } catch (e) {
      console.error("[-] Corrupt profiles.json:", e.message);
    }
  }
  return [];
}

function isSameOriginRequest(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host.toLowerCase() === (req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}

// 4. Background Dispatch Worker (Runs every 30 seconds)
function runSchedulerTick() {
  if (!db) return;
  try {
    const nowIso = new Date().toISOString();
    const pending = db.prepare(
      "SELECT * FROM broadcast_queue WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT 3"
    ).all(nowIso);

    for (const item of pending) {
      console.log(`[PENNANT SCHEDULER] Dispatching post #${item.id} for [${item.account}]...`);
      db.prepare("UPDATE broadcast_queue SET status = 'processing' WHERE id = ?").run(item.id);

      const isWin = os.platform() === 'win32';
      const cmd = isWin ? "powershell.exe" : "pwsh";
      const args = [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", BROADCAST_SCRIPT,
        "-Account", item.account,
        "-Message", item.message,
        "-Targets", item.targets
      ];

      if (item.url && item.url.trim() !== "") args.push("-Url", item.url);
      if (item.image_path && item.image_path.trim() !== "") args.push("-ImagePath", item.image_path);

      const runner = spawn(cmd, args);
      let stdout = "";
      let stderr = "";

      runner.stdout.on("data", (d) => { stdout += d.toString(); });
      runner.stderr.on("data", (d) => { stderr += d.toString(); });

      let runnerError = '';
      runner.on("error", (err) => {
        runnerError = err.message;
        db.prepare(
          "UPDATE broadcast_queue SET status = 'failed', error = ? WHERE id = ?"
        ).run(runnerError, item.id);
      });

      runner.on("close", (code) => {
        if (code === 0) {
          console.log(`[PENNANT SCHEDULER] Post #${item.id} published successfully!`);
          db.prepare(
            "UPDATE broadcast_queue SET status = 'published', published_at = ?, receipts = ? WHERE id = ?"
          ).run(new Date().toISOString(), stdout.trim(), item.id);
        } else {
          console.error(`[PENNANT SCHEDULER] Post #${item.id} exit code ${code}`);
          db.prepare(
            "UPDATE broadcast_queue SET status = 'failed', error = ? WHERE id = ?"
          ).run(runnerError || stderr.trim() || stdout.trim(), item.id);
        }
      });
    }
  } catch (err) {
    console.error("[SCHEDULER ERROR]", err.message);
  }
}

setInterval(runSchedulerTick, 30000).unref();

// 5. HTTP API & Dashboard Server
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // System Status & Browser Capabilities
  if (parsedUrl.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ONLINE',
      port: PORT,
      browserDetected: !!BROWSER_PATH,
      platform: os.platform(),
      identitiesCount: getProfiles().length,
      vaultProfilesCount: globalSessionVault.getProfileCount(),
      activeStreamsCount: globalSessionVault.getActiveStreamCount()
    }));
    return;
  }

  // Stream API - Dynamic multi-identity upstream authorization proxy
  if (parsedUrl.pathname === '/api/stream') {
    globalSessionVault.handleStreamRequest(req, res).catch((err) => {
      console.error('[-] Stream error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // StreamHub Unified SSE Endpoint (Single connection multiplexer for all columns)
  if (parsedUrl.pathname === '/api/events/live') {
    globalStreamHub.handleLiveEventsRoute(req, res).catch((err) => {
      console.error('[-] StreamHub live events error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Sanitized public profiles in Session Vault (zero-knowledge view)
  if (parsedUrl.pathname === '/api/vault/profiles') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(globalSessionVault.listPublicProfiles()));
    return;
  }

  // Downstream Fleet Ingestion Harness Route
  if (parsedUrl.pathname === '/api/ingest/fleet') {
    handleFleetIngestRequest(req, res, db, broadcastDaemon).catch((err) => {
      console.error('[-] Fleet ingest error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Pennant Hoist Broadcast Queue API (Enqueue & Ledger Inspection)
  if (parsedUrl.pathname === '/api/broadcast/queue') {
    if (!broadcastDaemon) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Broadcast Daemon is offline' }));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const queueId = broadcastDaemon.enqueueBroadcast(payload, payload.scheduledFor);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ queueId, status: 'pending', scheduledFor: payload.scheduledFor }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'GET') {
      const id = parsedUrl.searchParams.get('id');
      if (id) {
        const job = broadcastDaemon.getJob(Number(id));
        if (!job) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Job not found' }));
          return;
        }
        const ledger = broadcastDaemon.getLedgerEntries(Number(id));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...job, ledger }));
        return;
      }
    }
  }

  if (parsedUrl.pathname === '/api/broadcast/ledger' && req.method === 'GET') {
    if (!broadcastDaemon) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Broadcast Daemon is offline' }));
      return;
    }
    const id = parsedUrl.searchParams.get('id');
    const entries = broadcastDaemon.getLedgerEntries(Number(id || 0));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
    return;
  }

  // Adaptive Background Media Airlock Staging
  if (parsedUrl.pathname === '/api/media/stage' && req.method === 'POST') {
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    const chunks = [];
    let length = 0;
    const maxMediaBytes = 50 * 1024 * 1024;
    let tooLarge = false;

    req.on('data', chunk => {
      if (tooLarge) return;
      length += chunk.length;
      if (length > maxMediaBytes) {
        tooLarge = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File size exceeds 50MB limit' }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (tooLarge) return;
      const buffer = Buffer.concat(chunks);
      try {
        let fileBuffer = buffer;
        let mimeType = contentType.split(';')[0].trim() || 'image/png';
        let profileId = parsedUrl.searchParams.get('profile') || 'default';
        let targets = (parsedUrl.searchParams.get('targets') || 'atproto,mastodon,nostr').split(',');

        if (contentType.includes('application/json')) {
          const payload = JSON.parse(buffer.toString('utf-8'));
          if (payload.dataBase64) {
            fileBuffer = Buffer.from(payload.dataBase64, 'base64');
          }
          if (payload.mimeType) mimeType = payload.mimeType;
          if (payload.profileId) profileId = payload.profileId;
          if (payload.targets) targets = payload.targets;
        }

        const staged = await mediaAirlock.stageMediaAsset(fileBuffer, mimeType, {
          profileId,
          targets,
          altText: parsedUrl.searchParams.get('alt') || undefined,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(staged));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Profiles List
  if (parsedUrl.pathname === '/profiles') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getProfiles()));
    return;
  }

  // Launch Zen / Firefox Isolated Profile
  if (parsedUrl.pathname === '/launch') {
    if (!isSameOriginRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cross-origin browser launches are not allowed.' }));
      return;
    }

    const profileKey = parsedUrl.searchParams.get('profile');
    if (!profileKey || !/^[a-zA-Z0-9_-]+$/.test(profileKey)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Profile key must contain only letters, numbers, underscores, or hyphens.' }));
      return;
    }

    const profiles = getProfiles();
    const config = profiles.find(p => p.id === profileKey);

    if (!config) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid profile identity key.' }));
      return;
    }

    if (!BROWSER_PATH) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No compatible browser detected. Install Zen or Firefox, or set ZEN_PATH or FIREFOX_PATH.' }));
      return;
    }

    const profileDir = path.join(PROFILE_ROOT, profileKey);
    const targetUrl = config.url || 'about:blank';

    try {
      fs.mkdirSync(profileDir, { recursive: true });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unable to prepare browser profile: ${err.message}` }));
      return;
    }

    const browser = spawn(BROWSER_PATH, ['-profile', profileDir, '--no-remote', targetUrl], {
      detached: true,
      stdio: 'ignore'
    });
    browser.once('error', (err) => {
      console.error(`[ERROR] Spawning browser for ${profileKey}:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unable to launch the detected browser.' }));
      }
    });
    browser.once('spawn', () => {
      browser.unref();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ launched: profileKey, url: targetUrl }));
    });

    return;
  }

  // Queue Endpoints: GET, POST, DELETE /schedule
  if (parsedUrl.pathname === '/schedule') {
    if (req.method === 'GET') {
      if (!db) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'The schedule database is unavailable.' }));
        return;
      }
      const items = db.prepare("SELECT * FROM broadcast_queue ORDER BY scheduled_at ASC LIMIT 100").all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(items));
      return;
    }

    if (req.method === 'POST') {
      if (!db) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'The schedule database is unavailable.' }));
        return;
      }
      if (!isSameOriginRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cross-origin schedule requests are not allowed.' }));
        return;
      }
      const contentType = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Schedule requests must use application/json.' }));
        return;
      }

      let body = '';
      let bodyLength = 0;
      let bodyTooLarge = false;
      req.on('data', chunk => {
        if (bodyTooLarge) return;
        bodyLength += chunk.length;
        if (bodyLength > MAX_SCHEDULE_REQUEST_BYTES) {
          bodyTooLarge = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Schedule request exceeds the 1 MiB limit.' }));
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (bodyTooLarge) return;
        try {
          const payload = JSON.parse(body);
          const entries = Array.isArray(payload) ? payload : [payload];
          const insertStmt = db.prepare(`
            INSERT INTO broadcast_queue (account, message, url, image_path, targets, scheduled_at, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
          `);

          let count = 0;
          for (const item of entries) {
            if (!item.account || !item.message || !item.scheduled_at) continue;
            insertStmt.run(
              item.account,
              item.message,
              item.url || '',
              item.image_path || '',
              item.targets || 'mastodon,bluesky',
              item.scheduled_at
            );
            count++;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'QUEUED', count: count }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'DELETE') {
      if (!isSameOriginRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cross-origin schedule requests are not allowed.' }));
        return;
      }
      const id = parsedUrl.searchParams.get('id');
      if (id && db) {
        db.prepare("DELETE FROM broadcast_queue WHERE id = ?").run(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: id }));
        return;
      }
    }
  }

  // Serve built production web app from apps/hoist-web/dist if present, or dashboard.html fallback
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
    const distPath = path.join(APP_ROOT, 'apps', 'hoist-web', 'dist', 'index.html');
    const dashPath = path.join(APP_ROOT, 'dashboard.html');
    const targetFile = fs.existsSync(distPath) ? distPath : dashPath;

    if (fs.existsSync(targetFile)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(targetFile, 'utf-8'));
      return;
    }
  }

  // Serve static assets from apps/hoist-web/dist
  if (parsedUrl.pathname.startsWith('/assets/')) {
    const assetPath = path.join(APP_ROOT, 'apps', 'hoist-web', 'dist', parsedUrl.pathname);
    if (fs.existsSync(assetPath)) {
      const ext = path.extname(assetPath).toLowerCase();
      const mimeTypes = {
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
      };
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(fs.readFileSync(assetPath));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

export function startServer(customPort = PORT, customHost = HOST) {
  return new Promise((resolve, reject) => {
    server.listen(customPort, customHost, () => {
      if (broadcastDaemon) {
        broadcastDaemon.start();
      }

      if (IS_DAEMON_MODE) {
        console.log(`[PENNANT DAEMON] Headless Background Queue Daemon + StreamHub active on loopback: http://${customHost}:${customPort}/`);
        console.log(`                 Database: ${DB_PATH}`);
        console.log(`                 StreamHub live SSE: http://${customHost}:${customPort}/api/events/live`);
        resolve(server);
        return;
      }

      if (IS_TUI_MODE) {
        console.log(`[PENNANT TUI] Starting interactive ASCII terminal dashboard on http://${customHost}:${customPort}/`);
        import('./apps/hoist-cli/src/tui.ts').then(({ HoistTUI }) => {
          const tui = new HoistTUI({ db, vault: globalSessionVault, hub: globalStreamHub });
          tui.startInteractive();
          resolve(server);
        }).catch(reject);
        return;
      }

      // Default mode: boot web console and open default browser
      const webUrl = `http://${customHost === '0.0.0.0' ? 'localhost' : customHost}:${customPort}/`;
      console.log(`[PENNANT] Sovereign Fleet Console Active: ${webUrl}`);
      console.log(`          Browser Path: ${BROWSER_PATH || 'System Default'}`);
      console.log(`          Profile Root: ${PROFILE_ROOT}`);
      console.log(`          Database:     ${DB_PATH}`);

      if (!NO_BROWSER) {
        console.log(`[PENNANT] Launching default browser to ${webUrl}...`);
        openDefaultBrowser(webUrl);
      }
      resolve(server);
    });
    server.on('error', reject);
  });
}

export { server };

const isDirectExecution = process.argv[1] && (
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() ||
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(APP_ROOT, 'pennant-launcher.js').toLowerCase()
);

if (isDirectExecution) {
  startServer();
}

