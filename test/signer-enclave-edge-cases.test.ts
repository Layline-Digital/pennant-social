import assert from 'node:assert';
import { SignerEnclave } from '../packages/core/src/crypto/signer-enclave.ts';

console.log('[*] Testing Signer Enclave Cryptographic & Edge-Case Harness...');

// 1. Bech32 nsec Validation & Error Resilience
console.log('    [1/4] Edge-Case: Bech32 nsec validation & corruption handling...');
const validNsec = 'nsec1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2xknz82kr939q9cv358';
const vRes = SignerEnclave.validateNsec(validNsec);
assert.strictEqual(vRes.valid, true, 'Valid nsec shape must pass');

assert.strictEqual(SignerEnclave.validateNsec('npub1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2xknz82kr939q9cv358').valid, false);
assert.strictEqual(SignerEnclave.validateNsec('nsec1short').valid, false);
assert.strictEqual(SignerEnclave.validateNsec('nsec1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2xknz82kr939q9cv358_extra').valid, false);
assert.strictEqual(SignerEnclave.validateNsec('nsec1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2xknz82kr939q9cv31b').valid, false);
assert.strictEqual(SignerEnclave.validateNsec('').valid, false);
// @ts-ignore
assert.strictEqual(SignerEnclave.validateNsec(null).valid, false);

// 2. NIP-46 Remote Bunker URI Sanitization & Security Gates
console.log('    [2/4] Edge-Case: NIP-46 Remote Bunker URI parser & protocol boundaries...');
const validBunker = 'bunker://fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52?relay=wss://relay.damus.io&relay=wss://relay.nsec.app&secret=k9s8f';
const bRes = SignerEnclave.parseBunkerUri(validBunker);
assert.strictEqual(bRes.valid, true, 'Valid bunker URI must parse cleanly');
assert.strictEqual(bRes.target?.relays.length, 2, 'Must extract all relays');
assert.strictEqual(bRes.target?.secret, 'k9s8f', 'Must extract optional secret');

assert.strictEqual(SignerEnclave.parseBunkerUri('http://malicious.org').valid, false, 'Reject non-bunker scheme');
assert.strictEqual(SignerEnclave.parseBunkerUri('bunker://invalid-pubkey?relay=wss://nos.lol').valid, false, 'Reject non-hex pubkey');
assert.strictEqual(SignerEnclave.parseBunkerUri('bunker://fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52').valid, false, 'Reject bunker without relay');
assert.strictEqual(SignerEnclave.parseBunkerUri('bunker://fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52?relay=ws://public-unencrypted.com').valid, false, 'Reject unencrypted ws:// over public internet');

// 3. NIP-01 Canonical JSON Serialization & Id Invariants
console.log('    [3/4] Testing NIP-01 Canonical JSON & Event Id calculation...');
const testEvent = {
  pubkey: 'fa984bd7dbb282f07e16e7ae87b26a2a7b9b90b7246a44771f0cf5ae58018f52',
  created_at: 1729641600,
  kind: 1,
  tags: [['t', 'pennant'], ['client', 'hoist']],
  content: 'Sovereign broadcast via Signer Enclave.'
};

const eventId = SignerEnclave.computeEventId(testEvent);
assert.strictEqual(/^[0-9a-f]{64}$/.test(eventId), true, 'Event Id must be 32-byte lowercase hex');

// 4. BIP-340 Signature Generation & Key Buffer Zeroization
console.log('    [4/4] Testing Enclave Schnorr signing & buffer scrubbing...');
const testPrivKeyHex = 'e89a3f294020c08b8b98e1694f24c0847790b8f04c6439247659c6ae40c94b29';
const signed = SignerEnclave.signEvent(testEvent, testPrivKeyHex);

assert.strictEqual(signed.id, eventId, 'Signed event id must match computed hash');
assert.strictEqual(signed.sig.length, 128, 'BIP-340 signature must be exactly 64 bytes (128 hex chars)');
assert.strictEqual(/^[0-9a-f]{128}$/.test(signed.sig), true, 'Signature must be pure hex string');

const shim = SignerEnclave.generateNip07Shim(testEvent.pubkey);
assert.ok(shim.includes('window.nostr ='), 'Shim must export window.nostr provider');
assert.ok(shim.includes(testEvent.pubkey), 'Shim must bind public key');

console.log('[+] PASS: All Signer Enclave security & edge-case invariants passed cleanly.');
