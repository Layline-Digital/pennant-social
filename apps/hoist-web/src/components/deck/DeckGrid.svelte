<!--
  Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine

  Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
  Licensed under the MIT License.

  2D Virtualized Command Deck Grid Component
  Supports running up to 35 concurrent monitoring streams across arbitrary account pools without cookie conflicts.
  - Horizontal Virtualization: Mounts only visible columns (4-6) + 1 buffer column on each side.
  - Vertical Virtualization: Mounts only visible post cards per active column.
  - Off-screen columns remain strictly as lightweight JavaScript arrays in memory.
  - Zero layout shifts (CLS = 0) via BlurHash aspect-ratio pre-allocation.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    DeckVirtualizer,
    calculateCardLayout,
    type DeckColumn,
    type DeckPost,
    type DeckVirtualizerConfig,
    type VirtualHorizontalWindow,
    type VirtualVerticalWindow,
  } from './deck-virtualizer.ts';

  export let columns: DeckColumn[] = [];
  export let columnWidth = 360;
  export let columnGap = 16;
  export let horizontalBuffer = 1;
  export let verticalBuffer = 2;
  export let defaultCardHeight = 180;

  let rootElement: HTMLDivElement | null = null;
  let viewportWidth = 1920;
  let viewportHeight = 1080;
  let scrollLeft = 0;

  // Track vertical scroll positions per column
  let columnScrollTops: Record<string, number> = {};

  const virtualizer = new DeckVirtualizer({
    columnWidth,
    columnGap,
    horizontalBuffer,
    verticalBuffer,
    defaultCardHeight,
    viewportWidth,
    viewportHeight,
  });

  $: {
    virtualizer.setViewport(viewportWidth, viewportHeight);
    virtualizer.setScrollLeft(scrollLeft);
    virtualizer.setColumns(columns);
    for (const [id, top] of Object.entries(columnScrollTops)) {
      virtualizer.setColumnScrollTop(id, top);
    }
  }

  $: hWindow = virtualizer.getHorizontalWindow();

  function handleHorizontalScroll(e: Event) {
    const target = e.currentTarget as HTMLElement;
    if (target) {
      scrollLeft = target.scrollLeft;
    }
  }

  function handleColumnScroll(columnId: string, e: Event) {
    const target = e.currentTarget as HTMLElement;
    if (target) {
      columnScrollTops[columnId] = target.scrollTop;
      columnScrollTops = { ...columnScrollTops };
    }
  }

  let resizeObserver: ResizeObserver | null = null;

  onMount(() => {
    if (rootElement) {
      viewportWidth = rootElement.clientWidth || 1920;
      viewportHeight = rootElement.clientHeight || 1080;

      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          viewportWidth = entry.contentRect.width;
          viewportHeight = entry.contentRect.height;
        }
      });
      resizeObserver.observe(rootElement);
    }
  });

  onDestroy(() => {
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
  });
</script>

<div
  bind:this={rootElement}
  class="hoist-deck-root"
  on:scroll={handleHorizontalScroll}
  role="region"
  aria-label="Pennant Hoist Multi-Identity Deck"
>
  <div class="hoist-deck-track" style="gap: {columnGap}px;">
    <!-- Horizontal Leading Spacer for off-screen columns -->
    <div
      class="hoist-spacer-start"
      style="width: {hWindow.offsetStart}px;"
      aria-hidden="true"
    ></div>

    <!-- Active Mounted Columns in Viewport (4-6 columns + 1 buffer on each side) -->
    {#each hWindow.mountedColumns as col (col.id)}
      {@const vWindow = virtualizer.getVerticalWindow(col.id)}
      <div
        class="hoist-column hoist-col-{col.protocol}"
        style="width: {columnWidth}px; min-width: {columnWidth}px; max-width: {columnWidth}px;"
        data-column-id={col.id}
      >
        <!-- Column Header -->
        <header class="hoist-col-header">
          <div class="hoist-col-title-group">
            <span class="hoist-col-title">{col.title || col.id}</span>
            <span class="hoist-protocol-badge protocol-{col.protocol}">{col.protocol}</span>
          </div>
          <div class="hoist-col-profile-id">{col.profileId}</div>
        </header>

        <!-- Vertical Scroll Area with Row Virtualization -->
        <div
          class="hoist-col-scroll"
          on:scroll={(e) => handleColumnScroll(col.id, e)}
        >
          <!-- Top vertical spacer for off-screen posts -->
          <div
            class="hoist-v-spacer-top"
            style="height: {vWindow.offsetStart}px;"
            aria-hidden="true"
          ></div>

          <!-- Mounted Visible Post Cards -->
          <div class="hoist-cards-stream">
            {#each vWindow.mountedPosts as post (post.id)}
              {@const layout = calculateCardLayout(post, columnWidth)}
              <article class="hoist-card" data-post-id={post.id}>
                <!-- Card Header -->
                <div class="hoist-card-header">
                  <div class="hoist-author-info">
                    {#if post.author.avatarUrl}
                      <img class="hoist-avatar" src={post.author.avatarUrl} alt={post.author.name} loading="lazy" />
                    {:else}
                      <div class="hoist-avatar-placeholder">{post.author.name.slice(0, 2).toUpperCase()}</div>
                    {/if}
                    <div class="hoist-author-names">
                      <strong class="hoist-display-name">{post.author.name}</strong>
                      <span class="hoist-handle">{post.author.handle}</span>
                    </div>
                  </div>
                  <time class="hoist-timestamp" datetime={post.timestamp}>
                    {new Date(post.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </time>
                </div>

                <!-- Card Body -->
                <div class="hoist-card-body">
                  <p class="hoist-card-text">{post.content}</p>
                </div>

                <!-- Zero-CLS Media Slot with BlurHash Pre-allocation -->
                {#if post.media && post.media.length > 0}
                  {@const media = post.media[0]}
                  <div
                    class="hoist-media-bounding-box"
                    style="
                      aspect-ratio: {layout.mediaAspectRatio || '16 / 9'};
                      background: {layout.placeholderBg || '#1e293b'};
                    "
                  >
                    <img
                      class="hoist-media-img"
                      src={media.previewUrl || media.url}
                      alt={media.altText || 'Media attachment'}
                      loading="lazy"
                    />
                  </div>
                {/if}

                <!-- Card Footer Metrics -->
                {#if post.metrics}
                  <footer class="hoist-card-metrics">
                    <span title="Replies">💬 {post.metrics.replies || 0}</span>
                    <span title="Reposts">🔄 {post.metrics.reposts || 0}</span>
                    <span title="Likes">❤️ {post.metrics.likes || 0}</span>
                  </footer>
                {/if}
              </article>
            {/each}
          </div>

          <!-- Bottom vertical spacer for off-screen posts -->
          <div
            class="hoist-v-spacer-bottom"
            style="height: {vWindow.offsetEnd}px;"
            aria-hidden="true"
          ></div>
        </div>
      </div>
    {/each}

    <!-- Horizontal Trailing Spacer for off-screen columns -->
    <div
      class="hoist-spacer-end"
      style="width: {hWindow.offsetEnd}px;"
      aria-hidden="true"
    ></div>
  </div>
</div>

<style>
  .hoist-deck-root {
    display: flex;
    flex-direction: row;
    width: 100%;
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    background: #090d16;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    box-sizing: border-box;
    position: relative;
    contain: strict;
  }

  .hoist-deck-track {
    display: flex;
    flex-direction: row;
    height: 100%;
    position: relative;
    align-items: stretch;
    padding: 12px 16px;
    box-sizing: border-box;
  }

  .hoist-spacer-start,
  .hoist-spacer-end {
    flex-shrink: 0;
    pointer-events: none;
  }

  .hoist-column {
    height: 100%;
    background: #111827;
    border: 1px solid #1f2937;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    overflow: hidden;
    flex-shrink: 0;
  }

  .hoist-col-header {
    padding: 10px 14px;
    background: #1e293b;
    border-bottom: 1px solid #334155;
    display: flex;
    align-items: center;
    justify-content: space-between;
    user-select: none;
    flex-shrink: 0;
  }

  .hoist-col-title-group {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
  }

  .hoist-col-title {
    font-weight: 600;
    font-size: 14px;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  .hoist-protocol-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .protocol-mastodon { background: rgba(99, 102, 241, 0.18); color: #818cf8; }
  .protocol-atproto { background: rgba(14, 165, 233, 0.18); color: #38bdf8; }
  .protocol-nostr { background: rgba(168, 85, 247, 0.18); color: #c084fc; }
  .protocol-matrix { background: rgba(16, 185, 129, 0.18); color: #34d399; }

  .hoist-col-profile-id {
    font-size: 12px;
    color: #94a3b8;
  }

  .hoist-col-scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 8px;
    box-sizing: border-box;
  }

  .hoist-v-spacer-top,
  .hoist-v-spacer-bottom {
    flex-shrink: 0;
    pointer-events: none;
  }

  .hoist-cards-stream {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .hoist-card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
    word-break: break-word;
  }

  .hoist-card-header {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    align-items: baseline;
  }

  .hoist-author-info {
    display: flex;
    gap: 8px;
    align-items: center;
    overflow: hidden;
  }

  .hoist-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
  }

  .hoist-avatar-placeholder {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #334155;
    color: #94a3b8;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
  }

  .hoist-author-names {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .hoist-display-name {
    color: #f8fafc;
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  .hoist-handle {
    color: #94a3b8;
    font-size: 11px;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  .hoist-timestamp {
    color: #64748b;
    font-size: 11px;
    white-space: nowrap;
  }

  .hoist-card-body {
    font-size: 13px;
    line-height: 1.45;
    color: #cbd5e1;
  }

  .hoist-card-text {
    margin: 0;
    white-space: pre-wrap;
  }

  /* Zero-CLS Media Slot: strict aspect-ratio containment */
  .hoist-media-bounding-box {
    width: 100%;
    border-radius: 4px;
    overflow: hidden;
    position: relative;
    contain: size layout paint;
  }

  .hoist-media-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    position: absolute;
    top: 0;
    left: 0;
  }

  .hoist-card-metrics {
    display: flex;
    gap: 16px;
    font-size: 11px;
    color: #94a3b8;
    margin-top: 4px;
  }
</style>
