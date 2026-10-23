import assert from 'node:assert';
import { LicenseVerifier } from '../packages/core/src/licensing/license-verifier.ts';

console.log('[*] Testing Stripe Annual License Verifier...');
const verifier = new LicenseVerifier();

// 1. Valid active license
const futureDate = new Date();
futureDate.setFullYear(futureDate.getFullYear() + 1);

const validLicense = {
  key: 'PH-SOLO-2026-X892-F891',
  email: 'creator@sovereign.net',
  tier: 'solo' as const,
  expiresAt: futureDate.toISOString(),
  signature: 'sig_test_verified_stripe_token_88921'
};

const res = verifier.verifyLicense(validLicense);
assert.strictEqual(res.valid, true, 'Valid license must pass verification');

// 2. Expired license beyond grace period
const pastDate = new Date('2024-01-01T00:00:00Z');
const expiredLicense = {
  key: 'PH-PRO-2024-EXPIRED',
  email: 'old@account.net',
  tier: 'pro' as const,
  expiresAt: pastDate.toISOString(),
  signature: 'sig_test_valid_but_old'
};

const expiredRes = verifier.verifyLicense(expiredLicense);
assert.strictEqual(expiredRes.valid, false, 'Expired license must fail verification');
assert.ok(expiredRes.reason?.includes('expired'), 'Reason must specify expiration');

console.log('[+] PASS: Stripe annual licensing engine validated.');
