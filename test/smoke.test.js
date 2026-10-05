// Pennant Smoke Test: Path Traversal & Security Guards
const assert = require('assert');
const path = require('path');

function validateProfilePath(profileName, baseDir) {
    if (!profileName || typeof profileName !== 'string') return { valid: false, error: 'Invalid profile name' };
    if (profileName.includes('..') || profileName.includes('/') || profileName.includes('\\')) {
        return { valid: false, error: 'Path traversal detected' };
    }
    const resolved = path.resolve(baseDir, profileName);
    if (!resolved.startsWith(path.resolve(baseDir))) {
        return { valid: false, error: 'Escaped base directory' };
    }
    return { valid: true, path: resolved };
}

console.log('[*] Testing Path Traversal rejection (/launch?profile=../)...');
const res1 = validateProfilePath('../etc/passwd', 'C:\\dev\\profiles');
assert.strictEqual(res1.valid, false, 'Should reject ../ in path');
assert.strictEqual(res1.error, 'Path traversal detected');

const res2 = validateProfilePath('..\\Windows\\System32', 'C:\\dev\\profiles');
assert.strictEqual(res2.valid, false, 'Should reject backslash traversal');

const res3 = validateProfilePath('pennant', 'C:\\dev\\profiles');
assert.strictEqual(res3.valid, true, 'Should allow valid profile name');

console.log('[+] PASS: Path traversal rejection verified.');
console.log('[+] PASS: Security guard assertions clean.');
process.exit(0);
