/**
 * Pennant Hoist - Dynamic Composer State Machine Unit Tests
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 */

import assert from 'node:assert';
import {
  ComposerStateMachine,
  countGraphemes,
  detectFacets,
  mapNostrMentions,
  renderMatrixHtml,
  calculateThreadSplit,
} from '../apps/hoist-web/src/components/composer/composer-state.ts';

async function runComposerStateTests() {
  console.log('[*] Testing Composer State Machine & Multi-Protocol Constraints...');

  // 1. Test Unicode Grapheme Counting
  console.log('[*] Testing Grapheme Counting...');
  const asciiText = 'Hello Pennant';
  assert.strictEqual(countGraphemes(asciiText), 13);

  // Emojis with zero-width joiners / modifiers should count as 1 grapheme
  const emojiText = '🚀';
  assert.strictEqual(countGraphemes(emojiText), 1);

  const familyEmoji = '👨‍👩‍👧‍👦'; // 4 people joined with ZWJ
  assert.strictEqual(countGraphemes(familyEmoji), 1, 'ZWJ sequence should count as 1 grapheme');

  const mixedText = 'Pennant 🛰️ Fleet 👨‍👩‍👧‍👦';
  // 'Pennant ' (8) + '🛰️' (1) + ' Fleet ' (7) + '👨‍👩‍👧‍👦' (1) = 17 graphemes
  assert.strictEqual(countGraphemes(mixedText), 17);

  // 2. Test ATProto Auto-Facet Detection
  console.log('[*] Testing Auto-Facet Detection (URLs and Mentions)...');
  const postWithLinks = 'Check out the update at https://pennant.laylinedigital.com/docs and ping @alice.bsky.social for access.';
  const facets = detectFacets(postWithLinks);
  assert.strictEqual(facets.length, 2);

  // Link facet
  const linkFacet = facets.find((f) => f.features[0].$type === 'app.bsky.richtext.facet#link');
  assert.ok(linkFacet);
  assert.strictEqual(linkFacet.features[0].uri, 'https://pennant.laylinedigital.com/docs');
  assert.ok(linkFacet.index.byteEnd > linkFacet.index.byteStart);

  // Mention facet
  const mentionFacet = facets.find((f) => f.features[0].$type === 'app.bsky.richtext.facet#mention');
  assert.ok(mentionFacet);
  assert.ok(mentionFacet.features[0].did?.includes('alice.bsky.social'));

  // 3. Test Nostr NIP-27 Mention Mapping
  console.log('[*] Testing Nostr NIP-27 Mention Mapping...');
  const nostrRaw = 'Broadcasting to @npub1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2x2z82wm2tshq3ng093 on Damus';
  const nostrMapped = mapNostrMentions(nostrRaw);
  assert.ok(nostrMapped.includes('nostr:npub1vl029mgpspedva04g90vltkh6fvh240eqtv9xxl2x2z82wm2tshq3ng093'));
  assert.strictEqual(nostrMapped.includes('@npub1'), false);

  // 4. Test Matrix HTML Rendering
  console.log('[*] Testing Matrix HTML Rendering...');
  const markdownText = 'Fleet status: **ALL SYSTEMS GO**\nReview *telemetry* logs & report.';
  const html = renderMatrixHtml(markdownText);
  assert.ok(html.includes('<strong>ALL SYSTEMS GO</strong>'));
  assert.ok(html.includes('<em>telemetry</em>'));
  assert.ok(html.includes('<br/>'));
  assert.ok(html.includes('&amp;')); // sanitized '&'

  // 5. Test Thread Splitting Logic
  console.log('[*] Testing Thread Splitting Logic...');
  // Construct a 400-character text exceeding ATProto 300 grapheme ceiling
  const longText = 'Pennant Hoist delivers a high-density, multi-column command deck capable of running up to 35 concurrent monitoring streams across arbitrary account pools without cookie conflicts. Equipped with an adaptive background media airlock and WAL-cached SQLite dispatch queues, it coordinates live broadcast streams across ActivityPub, ATProto, Nostr, and Matrix simultaneously with sub-millisecond local scheduling.';
  assert.ok(countGraphemes(longText) > 300);

  const thread = calculateThreadSplit(longText, 300);
  assert.ok(thread.length >= 2, `Expected thread length >= 2, got ${thread.length}`);
  assert.strictEqual(thread[0].index, 1);
  assert.strictEqual(thread[0].total, thread.length);
  assert.ok(thread[0].text.startsWith('1/'));
  assert.ok(thread[1].text.startsWith('2/'));

  // Each chunk must strictly be under the 300 limit
  for (const part of thread) {
    assert.ok(countGraphemes(part.text) <= 300, `Thread part exceeded limit: ${countGraphemes(part.text)}`);
  }

  // 6. Test Composer State Machine & Per-Target Overrides
  console.log('[*] Testing Composer State Machine & Per-Target Overrides...');
  const composer = new ComposerStateMachine();

  composer.addTarget({ profileId: 'brand-alpha', protocol: 'bluesky' });
  composer.addTarget({ profileId: 'brand-alpha', protocol: 'mastodon' });
  composer.addTarget({ profileId: 'personal-key', protocol: 'nostr' });

  composer.setBaseText('Universal fleet broadcast update across networks.');

  let snap = composer.getSnapshot();
  assert.strictEqual(snap.isSubmittable, true);
  assert.strictEqual(snap.validations.length, 3);
  assert.strictEqual(snap.validations.every((v) => v.isValid), true);

  // Over limit for Bluesky but under for Mastodon
  const overLimitText = 'A'.repeat(350);
  composer.setBaseText(overLimitText);
  snap = composer.getSnapshot();

  const bskyVal = snap.validations.find((v) => v.protocol === 'bluesky');
  const mastoVal = snap.validations.find((v) => v.protocol === 'mastodon');

  assert.ok(bskyVal);
  assert.ok(mastoVal);
  assert.strictEqual(bskyVal.isOverLimit, true);
  assert.strictEqual(bskyVal.isValid, false, 'Bluesky should be invalid without thread-split');
  assert.strictEqual(mastoVal.isOverLimit, false);
  assert.strictEqual(mastoVal.isValid, true);
  assert.strictEqual(snap.isSubmittable, false);

  // Enable split thread
  composer.toggleSplitThread(true);
  snap = composer.getSnapshot();
  const bskyValSplit = snap.validations.find((v) => v.protocol === 'bluesky');
  assert.ok(bskyValSplit);
  assert.strictEqual(bskyValSplit.isValid, true, 'Bluesky should be valid when split-thread is enabled');
  assert.ok(bskyValSplit.threadCount >= 2);
  assert.strictEqual(snap.isSubmittable, true);

  // Per-target custom override
  console.log('[*] Testing per-target custom text override...');
  composer.setCustomOverride('brand-alpha', 'bluesky', 'Custom short text for Bluesky');
  snap = composer.getSnapshot();
  const bskyOverrideVal = snap.validations.find((v) => v.protocol === 'bluesky');
  const mastoBaseVal = snap.validations.find((v) => v.protocol === 'mastodon');

  assert.ok(bskyOverrideVal);
  assert.ok(mastoBaseVal);
  assert.strictEqual(bskyOverrideVal.effectiveText, 'Custom short text for Bluesky');
  assert.strictEqual(mastoBaseVal.effectiveText, overLimitText);

  // Clear override
  composer.clearCustomOverride('brand-alpha', 'bluesky');
  snap = composer.getSnapshot();
  const bskyClearedVal = snap.validations.find((v) => v.protocol === 'bluesky');
  assert.strictEqual(bskyClearedVal?.effectiveText, overLimitText);

  console.log('[+] PASS: Composer state machine unit tests clean.');
  console.log('[+] PASS: Grapheme counting, facet detection, and thread-split verified.');
}

runComposerStateTests().catch((err) => {
  console.error('[-] Composer state test failed:', err);
  process.exit(1);
});
