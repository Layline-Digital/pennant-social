#!/usr/bin/env node
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7420);
const HOST = process.env.HOST || 'localhost';
const MAX_SCHEDULE_REQUEST_BYTES = 1024 * 1024;

const DEFAULT_PROFILE_ROOT = path.join(os.homedir(), '.pennant', 'profiles');
const PROFILE_ROOT = path.resolve(process.env.PROFILE_ROOT || DEFAULT_PROFILE_ROOT);
fs.mkdirSync(PROFILE_ROOT, { recursive: true });

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

setInterval(runSchedulerTick, 30000);

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
      identitiesCount: getProfiles().length
    }));
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

  // Dashboard HTML
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
    const dashPath = path.join(APP_ROOT, 'dashboard.html');
    if (fs.existsSync(dashPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(dashPath, 'utf-8'));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`[PENNANT] Sovereign Fleet Console Active: http://${HOST}:${PORT}/`);
  console.log(`          Browser Path: ${BROWSER_PATH || 'None detected (Headless Mode)'}`);
  console.log(`          Profile Root: ${PROFILE_ROOT}`);
  console.log(`          Database:     ${DB_PATH}`);
});
