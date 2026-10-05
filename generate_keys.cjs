const { generateSecretKey, getPublicKey } = require('nostr-tools/pure');
const { npubEncode, nsecEncode } = require('nostr-tools/nip19');
const { bytesToHex } = require('@noble/hashes/utils');
const fs = require('fs');

const entities = ['personal-brand', 'studio-lab', 'community-news'];
let envOutput = '';
console.log('=== NOSTR KEYS GENERATED ===');

entities.forEach(entity => {
  const envName = entity.toUpperCase().replace(/-/g, '_');
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const hexSec = bytesToHex(sk);
  const nsec = nsecEncode(sk);
  const npub = npubEncode(pk);

  console.log(`[${entity}] public key: ${pk}`);

  envOutput += `# ${envName}\n`;
  envOutput += `${envName}_NOSTR_HEX_PUB="${pk}"\n`;
  envOutput += `${envName}_NOSTR_NPUB="${npub}"\n`;
  envOutput += `${envName}_NOSTR_NSEC="${nsec}"\n`;
  envOutput += `${envName}_NOSTR_HEX_SEC="${hexSec}"\n\n`;
});

fs.appendFileSync('.env.fleet-nostr-keys', envOutput, { encoding: 'utf8', mode: 0o600 });
console.log('[OK] Private keys written to ignored file .env.fleet-nostr-keys; protect this file.');
