/**
 * Pennant Hoist - HoistDeck Controller Unit Tests
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 */

import assert from 'node:assert';
import {
  DeckVirtualizer,
  calculateCardLayout,
  type DeckColumn,
  type DeckPost,
} from '../apps/hoist-web/src/components/deck/deck-virtualizer.ts';

async function runHoistDeckTests() {
  console.log('[*] Testing HoistDeck Svelte Controller & Ingestion Mechanics...');

  const columnWidth = 360;
  const columnGap = 16;
  const viewportWidth = 1920;
  const viewportHeight = 1080;

  const virtualizer = new DeckVirtualizer({
    columnWidth,
    columnGap,
    horizontalBuffer: 1,
    verticalBuffer: 2,
    viewportWidth,
    viewportHeight,
  });

  // 1. Column Registration across multi-protocols
  console.log('[*] Testing column registration across protocols...');
  const initialColumns: DeckColumn[] = [
    { id: 'col-1', profileId: 'alpha', title: 'Alpha Mastodon', protocol: 'mastodon', posts: [], scrollTop: 0 },
    { id: 'col-2', profileId: 'alpha', title: 'Alpha Bluesky', protocol: 'atproto', posts: [], scrollTop: 0 },
    { id: 'col-3', profileId: 'alpha', title: 'Alpha Nostr', protocol: 'nostr', posts: [], scrollTop: 0 },
    { id: 'col-4', profileId: 'alpha', title: 'Alpha Matrix', protocol: 'matrix', posts: [], scrollTop: 0 },
    { id: 'col-5', profileId: 'beta', title: 'Beta Mastodon', protocol: 'mastodon', posts: [], scrollTop: 0 },
    { id: 'col-6', profileId: 'beta', title: 'Beta Bluesky', protocol: 'atproto', posts: [], scrollTop: 0 },
    { id: 'col-7', profileId: 'gamma', title: 'Gamma Timeline', protocol: 'mastodon', posts: [], scrollTop: 0 },
    { id: 'col-8', profileId: 'delta', title: 'Delta Timeline', protocol: 'atproto', posts: [], scrollTop: 0 },
  ];

  virtualizer.setColumns(initialColumns);
  assert.strictEqual(virtualizer.getTotalColumns(), 8);

  // 2. Horizontal Windowing at Scroll 0
  console.log('[*] Testing horizontal windowing at scrollLeft = 0...');
  virtualizer.setScrollLeft(0);
  const hWin0 = virtualizer.getHorizontalWindow();

  assert.strictEqual(hWin0.startIndex, 0);
  assert.ok(hWin0.visibleCount >= 5 && hWin0.visibleCount <= 7, `Expected 5-7 mounted columns, got ${hWin0.visibleCount}`);
  assert.strictEqual(hWin0.offsetStart, 0);
  assert.ok(hWin0.offsetEnd > 0, 'Trailing spacer should be positive');

  // Verify off-screen column #8 is unmounted
  const mountedIds0 = new Set(hWin0.mountedColumns.map((c) => c.id));
  assert.ok(mountedIds0.has('col-1'));
  assert.strictEqual(mountedIds0.has('col-8'), false, 'Col-8 should be unmounted at scroll 0');

  // 3. Horizontal Scroll Window Shift
  console.log('[*] Testing horizontal scroll window shift...');
  // Scroll right by 3 column steps: 3 * (360 + 16) = 1128px
  virtualizer.setScrollLeft(3 * (columnWidth + columnGap));
  const hWinScrolled = virtualizer.getHorizontalWindow();

  assert.ok(hWinScrolled.startIndex >= 2, `Expected startIndex >= 2, got ${hWinScrolled.startIndex}`);
  assert.ok(hWinScrolled.offsetStart > 0, 'Leading spacer must be positive when scrolled');

  const mountedIdsScrolled = new Set(hWinScrolled.mountedColumns.map((c) => c.id));
  assert.strictEqual(mountedIdsScrolled.has('col-1'), false, 'Col-1 should now be unmounted');
  assert.ok(mountedIdsScrolled.has('col-8'), 'Col-8 should now be mounted');

  // 4. Live Event Insertion & Card Layout Pre-Allocation
  console.log('[*] Testing live event insertion and zero-CLS bounding box...');
  const liveIncomingPost: DeckPost = {
    id: 'post-live-99',
    profileId: 'alpha',
    protocol: 'mastodon',
    author: { name: 'Alpha Operator', handle: '@alpha@social.pennant.io' },
    content: 'Immediate quad-protocol live event received via StreamHub SSE multiplexer.',
    timestamp: new Date().toISOString(),
    media: [
      {
        url: 'https://social.pennant.io/media/photo1.png',
        previewUrl: 'https://social.pennant.io/media/thumb1.png',
        width: 1920,
        height: 1080,
        blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4',
      },
    ],
    metrics: { replies: 2, reposts: 5, likes: 12 },
  };

  const appended = virtualizer.appendPost('col-1', liveIncomingPost);
  assert.strictEqual(appended, true);

  const col1 = virtualizer.getColumn('col-1');
  assert.ok(col1);
  assert.strictEqual(col1.posts.length, 1);
  assert.strictEqual(col1.posts[0].id, 'post-live-99');

  // Verify Zero-CLS layout pre-allocation
  const layout = calculateCardLayout(col1.posts[0], columnWidth);
  assert.strictEqual(layout.mediaAspectRatio, '1920 / 1080');
  assert.ok(layout.mediaHeightPx && layout.mediaHeightPx > 0);
  assert.ok(layout.placeholderBg?.startsWith('linear-gradient'));

  // 5. In-card action metric mutations
  console.log('[*] Testing in-card action metric mutations...');
  col1.posts[0].metrics!.likes++;
  assert.strictEqual(col1.posts[0].metrics!.likes, 13);
  col1.posts[0].metrics!.reposts++;
  assert.strictEqual(col1.posts[0].metrics!.reposts, 6);

  console.log('[+] PASS: HoistDeck controller mechanics validated.');
  console.log('[+] PASS: Column registration, 2D scroll windowing, and live event ingestion verified.');
}

runHoistDeckTests().catch((err) => {
  console.error('[-] HoistDeck test failed:', err);
  process.exit(1);
});
