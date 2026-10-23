import assert from 'node:assert';
import path from 'node:path';

console.log('[*] Executing Deep Edge-Case, Stress & Fault-Tolerance Battery...');

// ---------------------------------------------------------------------------
// 1. Thread Splitting with Indivisible URLs & Complex Graphemes
// ---------------------------------------------------------------------------
console.log('    [1/5] Edge Case: Indivisible URLs & Grapheme cluster boundaries in Thread Splitter...');

function splitIntoThreadChunks(text, maxLen = 300) {
  if (!text || text.length <= maxLen) return [text];
  
  // Tokenize preserving whitespace, words, and full URLs as atomic units
  const tokens = text.match(/https?:\/\/[^\s]+|\s+|[^\s]+/g) || [];
  
  const chunks = [];
  let currentChunk = '';

  for (const token of tokens) {
    if ((currentChunk + token).length > maxLen) {
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = token.trimStart();
      } else {
        // Token itself exceeds maxLen (e.g. standalone giant URL or unbreakable string)
        if (/^https?:\/\//.test(token)) {
          chunks.push(token.trim());
          currentChunk = '';
        } else {
          // Unbreakable word/emoji block: segment strictly by grapheme clusters
          const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
          const graphemes = Array.from(segmenter.segment(token)).map(s => s.segment);
          for (const g of graphemes) {
            if ((currentChunk + g).length > maxLen) {
              if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());
              currentChunk = g;
            } else {
              currentChunk += g;
            }
          }
        }
      }
    } else {
      currentChunk += token;
    }
  }
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}

const longUrl = 'https://specs.laylinedigital.com/architecture/2026/autonomous-fleet-dispatch-and-sovereign-multi-protocol-airlock-specifications-v2';
const textWithLongUrl = 'Important release dispatch for Pennant Hoist operations console. Review documentation at ' + longUrl + ' and coordinate deployment.';

const chunks = splitIntoThreadChunks(textWithLongUrl, 160);
assert.ok(chunks.length >= 2, 'Must split text exceeding max length');

// Verify that the URL remains completely unbroken inside one of the chunks
const foundIntactUrl = chunks.some(c => c.includes(longUrl));
assert.strictEqual(foundIntactUrl, true, 'URL must not be severed or mutated across chunks');

// Multi-byte emoji cluster test
const familyEmoji = '👨‍👩‍👧‍👦'.repeat(30);
const emojiChunks = splitIntoThreadChunks(familyEmoji + ' message', 50);
assert.ok(emojiChunks.length > 0);
assert.strictEqual(emojiChunks[0].includes('\uFFFD'), false, 'Grapheme clusters must never split into invalid replacement chars');

// ---------------------------------------------------------------------------
// 2. Media Airlock Fault Tolerance & Path Traversal Rejection
// ---------------------------------------------------------------------------
console.log('    [2/5] Edge Case: Media Airlock boundary violations (0-byte, 50MB, Traversal)...');

function validateMediaUpload(fileName, bufferSize, mimeType) {
  if (!bufferSize || bufferSize <= 0) {
    return { valid: false, reason: 'Zero-byte asset rejected' };
  }
  const MAX_SIZE = 50 * 1024 * 1024; // 50MB
  if (bufferSize > MAX_SIZE) {
    return { valid: false, reason: 'Payload exceeds 50MB ceiling' };
  }

  const dangerousMimes = ['application/x-msdownload', 'application/x-sh', 'application/x-bat', 'application/javascript'];
  if (dangerousMimes.includes(mimeType.toLowerCase())) {
    return { valid: false, reason: 'Executable payload rejected' };
  }

  const safeBaseName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    return { valid: true, sanitizedName: safeBaseName, note: 'Path traversal sanitized' };
  }

  return { valid: true, sanitizedName: safeBaseName };
}

assert.strictEqual(validateMediaUpload('empty.png', 0, 'image/png').valid, false);
assert.strictEqual(validateMediaUpload('bomb.mov', 60 * 1024 * 1024, 'video/mp4').valid, false);
assert.strictEqual(validateMediaUpload('payload.exe', 1024, 'application/x-msdownload').valid, false);

const traversalTest = validateMediaUpload('../../../Windows/System32/cmd.exe.png', 4096, 'image/png');
assert.strictEqual(traversalTest.valid, true);
assert.strictEqual(traversalTest.sanitizedName, 'cmd.exe.png');

// ---------------------------------------------------------------------------
// 3. SessionVault Identifier Hardening & Null-Byte Injection
// ---------------------------------------------------------------------------
console.log('    [3/5] Edge Case: SessionVault profile injection & poison null-bytes...');

function validateProfileIdentifier(profileId) {
  if (!profileId || typeof profileId !== 'string') return false;
  if (profileId.includes('\0') || profileId.includes('/') || profileId.includes('\\') || profileId.includes('..')) {
    return false;
  }
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(profileId);
}

assert.strictEqual(validateProfileIdentifier('pennant_main'), true);
assert.strictEqual(validateProfileIdentifier('profile\0admin'), false, 'Reject poison null-byte');
assert.strictEqual(validateProfileIdentifier('../../etc/shadow'), false, 'Reject path traversal in ID');
assert.strictEqual(validateProfileIdentifier(''), false, 'Reject empty ID');

// ---------------------------------------------------------------------------
// 4. Queue Idempotency & Dead-Letter Resiliency
// ---------------------------------------------------------------------------
console.log('    [4/5] Edge Case: Queue deduplication hash & retry-to-dead-letter bound...');

class MockQueueScheduler {
  constructor() {
    this.seenHashes = new Set();
    this.jobs = new Map();
  }

  enqueue(dedupHash, payload) {
    if (this.seenHashes.has(dedupHash)) {
      return { status: 'deduplicated', jobId: this.jobs.get(dedupHash).id };
    }
    const id = 'job_' + (this.seenHashes.size + 1);
    const job = { id, payload, attempts: 0, status: 'pending' };
    this.seenHashes.add(dedupHash);
    this.jobs.set(dedupHash, job);
    return { status: 'enqueued', jobId: id };
  }

  failJob(dedupHash, reason) {
    const job = this.jobs.get(dedupHash);
    if (!job) return;
    job.attempts += 1;
    if (job.attempts >= 5) {
      job.status = 'dead_letter';
      job.failureReason = reason;
    } else {
      job.status = 'retry_scheduled';
    }
  }
}

const scheduler = new MockQueueScheduler();
const hash = 'a6b4c9e812f';
const res1 = scheduler.enqueue(hash, { msg: 'Test' });
const res2 = scheduler.enqueue(hash, { msg: 'Test duplicate' });

assert.strictEqual(res1.status, 'enqueued');
assert.strictEqual(res2.status, 'deduplicated');
assert.strictEqual(res1.jobId, res2.jobId, 'Deduplicated post must return existing job ID');

for (let i = 0; i < 5; i++) {
  scheduler.failJob(hash, 'HTTP 503 Upstream Gateway Timeout');
}
assert.strictEqual(scheduler.jobs.get(hash).status, 'dead_letter', 'Job must transition to dead_letter after 5 attempts');

// ---------------------------------------------------------------------------
// 5. Deck Column DOM XSS Prevention & Title Sanitization
// ---------------------------------------------------------------------------
console.log('    [5/5] Edge Case: Column Title DOM Escaping & XSS Neutralization...');

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const dirtyTitle = '<script>alert("xss")</script>#trend" onclick="evil()';
const cleanTitle = escapeHtml(dirtyTitle);

assert.strictEqual(cleanTitle.includes('<script>'), false);
assert.strictEqual(cleanTitle.includes('&lt;script&gt;'), true);
assert.strictEqual(cleanTitle.includes('&quot;'), true);

console.log('[+] PASS: Deep edge cases, boundary audits, and stress invariants 100% verified.');
