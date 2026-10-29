/**
 * Pennant Hoist - Launcher CLI Flags, Daemon Loopback & Browser Opener Unit Tests
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 */

import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLauncherFlags, openDefaultBrowser } from '../pennant-launcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const LAUNCHER_SCRIPT = path.join(ROOT_DIR, 'pennant-launcher.js');

function httpGet(url: string): Promise<{ statusCode?: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    }).on('error', reject);
  });
}

async function runLauncherCliTests() {
  console.log('[*] Testing Pennant Hoist Launcher CLI Flag Dispatcher & Environment Parsing...');

  // 1. Default Flag Parsing (No args, clean env)
  const defaultFlags = parseLauncherFlags([], {});
  assert.strictEqual(defaultFlags.isTui, false, 'Default should not enable TUI mode');
  assert.strictEqual(defaultFlags.isDaemon, false, 'Default should not enable daemon mode');
  assert.strictEqual(defaultFlags.noBrowser, false, 'Default should not suppress browser launch');
  assert.strictEqual(defaultFlags.port, 7420, 'Default port should be 7420');
  assert.strictEqual(defaultFlags.host, 'localhost', 'Default host should be localhost');

  // 2. Daemon Mode: Host must bind strictly to 127.0.0.1 (Loopback isolation)
  const daemonFlags = parseLauncherFlags(['--daemon'], {});
  assert.strictEqual(daemonFlags.isDaemon, true, '--daemon flag should set isDaemon true');
  assert.strictEqual(daemonFlags.host, '127.0.0.1', '--daemon mode must bind strictly to 127.0.0.1 loopback');
  assert.strictEqual(daemonFlags.isTui, false);

  // 3. TUI Mode Flag
  const tuiFlags = parseLauncherFlags(['--tui'], {});
  assert.strictEqual(tuiFlags.isTui, true, '--tui flag should set isTui true');
  assert.strictEqual(tuiFlags.isDaemon, false);

  // 4. Browser Suppression Flags & Environment Variables
  const noBrowserFlag = parseLauncherFlags(['--no-browser'], {});
  assert.strictEqual(noBrowserFlag.noBrowser, true, '--no-browser flag should set noBrowser true');

  const envNoBrowser = parseLauncherFlags([], { NO_BROWSER: '1' });
  assert.strictEqual(envNoBrowser.noBrowser, true, 'NO_BROWSER=1 env should set noBrowser true');

  const envHeadless = parseLauncherFlags([], { HEADLESS: '1' });
  assert.strictEqual(envHeadless.noBrowser, true, 'HEADLESS=1 env should set noBrowser true');

  const envNodeTest = parseLauncherFlags([], { NODE_ENV: 'test' });
  assert.strictEqual(envNodeTest.noBrowser, true, 'NODE_ENV=test env should set noBrowser true');

  // 5. Custom Port and Host Environment Variable Overrides
  const customEnvFlags = parseLauncherFlags([], { PORT: '8910', HOST: '192.168.1.100' });
  assert.strictEqual(customEnvFlags.port, 8910, 'PORT env override must take precedence');
  assert.strictEqual(customEnvFlags.host, '192.168.1.100', 'HOST env override must take precedence');

  
  // Test --status and --health parsing
  const statusFlags = parseLauncherFlags(['--status']);
  assert.strictEqual(statusFlags.isStatusCheck, true, 'isStatusCheck should be true when --status passed');

  const healthFlags = parseLauncherFlags(['--health']);
  assert.strictEqual(healthFlags.isStatusCheck, true, 'isStatusCheck should be true when --health passed');

  // Test custom --host parsing
  const customHostFlags = parseLauncherFlags(['--host=0.0.0.0']);
  assert.strictEqual(customHostFlags.host, '0.0.0.0', 'host should parse --host=0.0.0.0');

  const spaceHostFlags = parseLauncherFlags(['--host', '192.168.1.100']);
  assert.strictEqual(spaceHostFlags.host, '192.168.1.100', 'host should parse --host 192.168.1.100');

  console.log('[+] PASS: CLI flag parsing and loopback isolation rules validated.');

  // 6. Test Default Browser Opener Dispatch Logic
  console.log('[*] Testing Browser Opener Subprocess Invocation & Error Resilience...');
  let mockSpawnCalled = false;
  let mockSpawnCommand = '';
  let mockSpawnArgs: string[] = [];

  const mockSpawn = (command: string, args: string[], options: any) => {
    mockSpawnCalled = true;
    mockSpawnCommand = command;
    mockSpawnArgs = args;
    return {
      unref: () => {},
    };
  };

  const opened = openDefaultBrowser('http://127.0.0.1:7420/', mockSpawn as any);
  assert.strictEqual(opened, true, 'openDefaultBrowser should return true on success');
  assert.strictEqual(mockSpawnCalled, true, 'openDefaultBrowser must trigger spawn');
  assert.ok(mockSpawnArgs.includes('http://127.0.0.1:7420/'), 'Target URL must be passed to opener');

  // Test error handling in openDefaultBrowser (should not crash caller)
  const throwingSpawn = () => {
    throw new Error('Simulated spawn ENOENT failure');
  };
  const failedOpen = openDefaultBrowser('http://127.0.0.1:7420/', throwingSpawn as any);
  assert.strictEqual(failedOpen, false, 'openDefaultBrowser should safely return false on failure');
  console.log('[+] PASS: Browser opener command dispatch and safety guards verified.');

  // 7. Subprocess Live Integration Test: Boot with --daemon on Loopback
  console.log('[*] Testing Headless Subprocess Boot in --daemon mode...');
  const DAEMON_TEST_PORT = 7431;

  await new Promise<void>((resolve, reject) => {
    const daemonProcess = spawn('node', [LAUNCHER_SCRIPT, '--daemon'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PORT: String(DAEMON_TEST_PORT),
        NO_BROWSER: '1',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let daemonStarted = false;
    let stdoutData = '';

    const timeout = setTimeout(() => {
      daemonProcess.kill();
      reject(new Error(`Daemon failed to start within timeout. Stdout:\n${stdoutData}`));
    }, 8000);

    daemonProcess.stdout.on('data', async (chunk) => {
      stdoutData += chunk.toString();
      if (!daemonStarted && stdoutData.includes(`[PENNANT DAEMON] Headless Background Queue Daemon + StreamHub active on loopback: http://127.0.0.1:${DAEMON_TEST_PORT}/`)) {
        daemonStarted = true;
        clearTimeout(timeout);

        try {
          // Verify Root Web Asset / Dashboard is served
          const rootRes = await httpGet(`http://127.0.0.1:${DAEMON_TEST_PORT}/`);
          assert.strictEqual(rootRes.statusCode, 200, 'Root endpoint must return 200 OK');
          assert.ok(rootRes.body.includes('PENNANT') || rootRes.body.includes('Pennant'), 'Root must serve Pennant web console');

          // Verify Status API is reachable
          const statusRes = await httpGet(`http://127.0.0.1:${DAEMON_TEST_PORT}/status`);
          assert.strictEqual(statusRes.statusCode, 200, 'Status API must return 200 OK');
          const statusJson = JSON.parse(statusRes.body);
          assert.strictEqual(statusJson.status, 'ONLINE');

          // Verify /api/stream rejects missing profile parameters gracefully
          const streamRes = await httpGet(`http://127.0.0.1:${DAEMON_TEST_PORT}/api/stream`);
          assert.strictEqual(streamRes.statusCode, 400, '/api/stream without profile must return 400');

          console.log('[+] PASS: Daemon subprocess successfully bounded to 127.0.0.1 loopback with reachable API.');
          daemonProcess.kill();
          resolve();
        } catch (err) {
          daemonProcess.kill();
          reject(err);
        }
      }
    });

    daemonProcess.stderr.on('data', (errChunk) => {
      const errStr = errChunk.toString();
      // Ignore PowerShell profile warnings
      if (!errStr.includes('Set-PSReadLineOption')) {
        console.error('[DAEMON STDERR]', errStr);
      }
    });

    daemonProcess.on('exit', (code) => {
      if (!daemonStarted) {
        clearTimeout(timeout);
        reject(new Error(`Daemon exited prematurely with code ${code}. Output:\n${stdoutData}`));
      }
    });
  });

  // 8. Subprocess Live Integration Test: Default Mode with --no-browser
  console.log('[*] Testing Standard Subprocess Boot with --no-browser...');
  const DEFAULT_TEST_PORT = 7432;

  await new Promise<void>((resolve, reject) => {
    const webProcess = spawn('node', [LAUNCHER_SCRIPT, '--no-browser'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PORT: String(DEFAULT_TEST_PORT),
        NO_BROWSER: '1',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let webStarted = false;
    let stdoutData = '';

    const timeout = setTimeout(() => {
      webProcess.kill();
      reject(new Error(`Web launcher failed to start within timeout. Stdout:\n${stdoutData}`));
    }, 8000);

    webProcess.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
      if (!webStarted && stdoutData.includes(`[PENNANT] Sovereign Fleet Console Active: http://localhost:${DEFAULT_TEST_PORT}/`)) {
        webStarted = true;
        clearTimeout(timeout);
        assert.strictEqual(stdoutData.includes('Launching default browser'), false, 'Should not attempt browser launch when NO_BROWSER is set');
        console.log('[+] PASS: Standard mode booted with browser suppression intact.');
        webProcess.kill();
        resolve();
      }
    });

    webProcess.on('exit', (code) => {
      if (!webStarted) {
        clearTimeout(timeout);
        reject(new Error(`Web process exited prematurely with code ${code}. Output:\n${stdoutData}`));
      }
    });
  });

  console.log('[+] PASS: All Launcher CLI and packaging integration tests verified cleanly.');
  process.exit(0);
}

runLauncherCliTests().catch((err) => {
  console.error('[-] Launcher CLI unit tests failed:', err);
  process.exit(1);
});
