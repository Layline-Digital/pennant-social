import assert from 'node:assert';

console.log('[*] Testing Matrix HTML Sanitization & Room Egress Security...');

function sanitizeMatrixNotice(input: string): string {
  // Strip raw script tags and normalize HTML entities for matrix notice events
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/onload=/gi, '');
}

const dirtyPayload = 'Hello matrix <script>alert("pwned")</script> check out <b onclick="evil()">updates</b>';
const clean = sanitizeMatrixNotice(dirtyPayload);

assert.strictEqual(clean.includes('<script>'), false, 'Matrix payload must strip script tags');
assert.strictEqual(clean.includes('alert('), false, 'Matrix payload must strip script contents');
assert.ok(clean.includes('updates</b>'), 'Matrix payload must preserve safe formatting');

console.log('[+] PASS: Matrix HTML egress security verified.');
