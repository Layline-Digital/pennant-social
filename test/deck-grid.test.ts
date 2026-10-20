/**
 * Pennant Hoist - 2D Virtualized Multi-Column Deck Grid Unit Tests
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 */

import assert from 'node:assert';
import {
  DeckVirtualizer,
  calculateCardLayout,
  blurhashToCssPlaceholder,
  type DeckColumn,
  type DeckPost,
} from '../apps/hoist-web/src/components/deck/deck-virtualizer.ts';

async function runDeckGridTests() {
  console.log('[*] Testing Pennant Hoist 2D Virtualized Command Deck Engine...');

  const columnWidth = 360;
  const columnGap = 16;
  const viewportWidth = 1920; // At 1920px wide: floor(1920 / (360 + 16)) = ~5 visible columns
  const viewportHeight = 1080;

  const virtualizer = new DeckVirtualizer({
    columnWidth,
    columnGap,
    horizontalBuffer: 1, // 1 buffer column on each side
    verticalBuffer: 2,   // 2 buffer cards top/bottom
    defaultCardHeight: 180,
    viewportWidth,
    viewportHeight,
  });

  // 1. Invariant: Scale up to 35 concurrent monitoring streams across arbitrary account pools
  console.log('[*] Seeding 35 concurrent monitoring streams in memory...');
  const protocols: Array<'mastodon' | 'atproto' | 'nostr' | 'matrix'> = [
    'mastodon',
    'atproto',
    'nostr',
    'matrix',
  ];

  const columns: DeckColumn[] = [];
  for (let c = 1; c <= 35; c++) {
    const proto = protocols[(c - 1) % protocols.length];
    const profileId = `profile-deck-${Math.ceil(c / 4)}`;
    const posts: DeckPost[] = [];

    // Each column holds 200 posts in memory
    for (let p = 1; p <= 200; p++) {
      posts.push({
        id: `post-${c}-${p}`,
        profileId,
        protocol: proto,
        author: {
          name: `Pilot ${c}`,
          handle: `@pilot${c}@social.pennant.io`,
        },
        content: `Dispatched operational telemetry payload #${p} across sovereign channel ${c}.`,
        timestamp: new Date(Date.now() - p * 60000).toISOString(),
        media: p % 3 === 0 ? [{
          url: `https://social.pennant.io/media/${c}-${p}.png`,
          previewUrl: `https://social.pennant.io/media/thumb_${c}-${p}.png`,
          width: 1200,
          height: 675,
          blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4',
        }] : undefined,
      });
    }

    columns.push({
      id: `col-stream-${c}`,
      profileId,
      title: `Monitoring Stream #${c}`,
      protocol: proto,
      posts,
      scrollTop: 0,
    });
  }

  virtualizer.setColumns(columns);
  assert.strictEqual(virtualizer.getTotalColumns(), 35, 'Failed to hold 35 concurrent stream columns');

  // 2. Horizontal Virtualization: Initial view (scrollLeft = 0)
  // At 1920px with 376px step:
  // Step = 376. 1920 / 376 = ~5.1 columns.
  // Visible: indices 0..5 (6 columns). With buffer of 1 on each side:
  // startIndex = 0, endIndex = 5 + 1 = 6 (7 mounted columns out of 35).
  console.log('[*] Verifying horizontal virtualization at scrollLeft = 0...');
  virtualizer.setScrollLeft(0);
  const hWin0 = virtualizer.getHorizontalWindow();

  assert.strictEqual(hWin0.totalColumns, 35);
  assert.strictEqual(hWin0.startIndex, 0);
  assert.ok(hWin0.visibleCount >= 5 && hWin0.visibleCount <= 8, `Expected 5-8 mounted columns, got ${hWin0.visibleCount}`);
  assert.strictEqual(hWin0.offsetStart, 0);
  assert.ok(hWin0.offsetEnd > 0, 'Off-screen trailing columns must be offset via spacer');

  // Verify off-screen columns remain strictly in memory
  const mountedIds0 = new Set(hWin0.mountedColumns.map((c) => c.id));
  assert.ok(mountedIds0.has('col-stream-1'));
  assert.strictEqual(mountedIds0.has('col-stream-35'), false, 'Off-screen column #35 must NOT be mounted');

  // 3. Horizontal Virtualization: Scroll to column 15 (scrollLeft = 15 * 376 = 5640)
  console.log('[*] Verifying horizontal virtualization window shift on scroll...');
  virtualizer.setScrollLeft(15 * (columnWidth + columnGap));
  const hWin15 = virtualizer.getHorizontalWindow();

  assert.ok(hWin15.startIndex >= 14, `Expected startIndex >= 14, got ${hWin15.startIndex}`);
  assert.ok(hWin15.offsetStart > 0, 'Leading off-screen columns must have positive start spacer');
  assert.ok(hWin15.offsetEnd > 0, 'Trailing off-screen columns must have positive end spacer');

  const mountedIds15 = new Set(hWin15.mountedColumns.map((c) => c.id));
  assert.strictEqual(mountedIds15.has('col-stream-1'), false, 'Column #1 must now be unmounted');
  assert.ok(mountedIds15.has('col-stream-16'), 'Column #16 should be mounted in view');

  // Total width matches all 35 columns
  const expectedTotalWidth = 35 * (columnWidth + columnGap) - columnGap;
  assert.strictEqual(hWin15.totalWidth, expectedTotalWidth);

  // 4. Vertical Virtualization: Per active column (200 posts)
  console.log('[*] Verifying vertical post card virtualization...');
  const vColId = 'col-stream-1';
  virtualizer.setColumnScrollTop(vColId, 0);
  const vWin0 = virtualizer.getVerticalWindow(vColId);

  assert.strictEqual(vWin0.totalPosts, 200);
  assert.strictEqual(vWin0.startIndex, 0);
  // Viewport 1080 / 180 = 6 cards + 2 buffer cards = ~8-9 mounted posts out of 200
  assert.ok(vWin0.visibleCount >= 6 && vWin0.visibleCount <= 12, `Expected 6-12 mounted cards, got ${vWin0.visibleCount}`);
  assert.strictEqual(vWin0.offsetStart, 0);
  assert.ok(vWin0.offsetEnd > 0, 'Trailing post cards must be spaced vertically');

  // Scroll column vertically to item 50 (scrollTop = 50 * 180 = 9000px)
  virtualizer.setColumnScrollTop(vColId, 50 * 180);
  const vWin50 = virtualizer.getVerticalWindow(vColId);

  assert.ok(vWin50.startIndex >= 48);
  assert.ok(vWin50.offsetStart > 0);
  const mountedPostIds = new Set(vWin50.mountedPosts.map((p) => p.id));
  assert.strictEqual(mountedPostIds.has('post-1-1'), false, 'Post #1 must be unmounted');
  assert.ok(mountedPostIds.has('post-1-51'), 'Post #51 must be mounted in view');

  // 5. Zero Layout Shifts (CLS = 0) Verification via BlurHash & Aspect-Ratio Bounding Boxes
  console.log('[*] Verifying CLS = 0 layout pre-allocation with BlurHash...');
  const postWithMedia: DeckPost = {
    id: 'post-cls-test',
    profileId: 'brand-alpha',
    protocol: 'mastodon',
    author: { name: 'Alpha', handle: '@alpha' },
    content: 'Testing cumulative layout shift prevention with exact aspect ratio container pre-allocation.',
    timestamp: new Date().toISOString(),
    media: [{
      url: 'https://example.com/photo.png',
      width: 1600,
      height: 900,
      blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4',
    }],
  };

  const layout = calculateCardLayout(postWithMedia, 360);
  assert.ok(layout.mediaAspectRatio);
  assert.strictEqual(layout.mediaAspectRatio, '1600 / 900', 'Aspect ratio must match image dimensions exactly');
  assert.ok(layout.mediaHeightPx && layout.mediaHeightPx > 0);
  assert.ok(layout.placeholderBg);
  assert.ok(layout.placeholderBg.startsWith('linear-gradient'), 'Placeholder background must be generated from BlurHash');

  const cssPlaceholder = blurhashToCssPlaceholder('L6PZfSi_.AyE_3t7t7R**0o#DgR4');
  assert.ok(cssPlaceholder.includes('linear-gradient'));

  console.log('[+] PASS: 2D virtualized multi-column deck engine validated.');
  console.log('[+] PASS: 35 concurrent streams, horizontal/vertical virtualization, and CLS=0 bounding boxes verified.');
}

runDeckGridTests().catch((err) => {
  console.error('[-] Deck Grid test failed:', err);
  process.exit(1);
});
