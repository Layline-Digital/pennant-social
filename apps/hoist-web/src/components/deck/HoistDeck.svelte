<!--
  Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine

  Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
  Licensed under the MIT License.

  HoistDeck Svelte Controller
  Connects 2D deck-virtualizer with real-time SSE updates from /api/events/live.
  - Horizontal virtualized container (mounts 4-6 columns + buffer)
  - Live connection health badge (SSE multiplexer)
  - Theme toggle (Slate Modern, Paper Clean, Amber Phosphor)
  - "New Broadcast" action opening Composer.svelte
  - In-card actions (Like, Repost, Reply with pre-seeded identity/parent context)
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    DeckVirtualizer,
    calculateCardLayout,
    type DeckColumn,
    type DeckPost,
    type DeckMediaAttachment,
  } from './deck-virtualizer.ts';
  import Composer from '../composer/Composer.svelte';
  import type { TargetProfile } from '../composer/composer-state.ts';

  export let columns: DeckColumn[] = [];
  export let availableProfiles: Array<{ id: string; name: string; protocols: string[] }> = [];
  export let sseUrl = '/api/events/live';
  export let theme: 'slate' | 'paper' | 'amber' = 'slate';

  let showComposer = false;
  let composerInitialTargets: TargetProfile[] = [];
  let composerInitialText = '';
  let inReplyToId: string | null = null;

  type ConnectionStatus = 'connecting' | 'live' | 'offline';
  let connectionStatus: ConnectionStatus = 'connecting';
  let eventSource: EventSource | null = null;

  let viewportWidth = 1920;
  let viewportHeight = 1080;
  let scrollLeft = 0;
  let columnScrollTops: Record<string, number> = {};
  let rootElement: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const virtualizer = new DeckVirtualizer({
    columnWidth: 360,
    columnGap: 16,
    horizontalBuffer: 1,
    verticalBuffer: 2,
    defaultCardHeight: 180,
    viewportWidth,
    viewportHeight,
  });

  // Reactive virtualization update
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

  function handleColumnScroll(colId: string, e: Event) {
    const target = e.currentTarget as HTMLElement;
    if (target) {
      columnScrollTops[colId] = target.scrollTop;
      columnScrollTops = { ...columnScrollTops };
    }
  }

  // SSE Real-Time Updates from /api/events/live
  function initSSE() {
    if (typeof EventSource === 'undefined') return;

    connectionStatus = 'connecting';
    try {
      eventSource = new EventSource(sseUrl);

      eventSource.addEventListener('init', () => {
        connectionStatus = 'live';
      });

      eventSource.addEventListener('ping', () => {
        connectionStatus = 'live';
      });

      eventSource.onmessage = (e) => {
        try {
          const multiplexed = JSON.parse(e.data);
          if (multiplexed?.event) {
            handleIncomingLiveEvent(multiplexed);
          }
        } catch (err: any) {
          console.warn('[HOIST DECK] Error parsing live event:', err.message);
        }
      };

      eventSource.onerror = () => {
        connectionStatus = 'offline';
      };
    } catch {
      connectionStatus = 'offline';
    }
  }

  export function handleIncomingLiveEvent(multiplexed: { streamId: string; profileId: string; event: any }) {
    const { streamId, profileId, event } = multiplexed;
    // Find matching columns by profileId or protocol
    const matchingCol = columns.find(
      (c) =>
        c.profileId.toLowerCase() === profileId.toLowerCase() &&
        (c.protocol === event.protocol || !event.protocol)
    );

    if (matchingCol && event.data) {
      const newPost: DeckPost = {
        id: event.id || `live-${Date.now()}`,
        profileId,
        protocol: event.protocol || matchingCol.protocol,
        author: event.data.author || { name: 'Unknown', handle: '@unknown' },
        content: event.data.content || '',
        timestamp: event.timestamp || new Date().toISOString(),
        media: event.data.media,
        metrics: event.data.metrics || { replies: 0, reposts: 0, likes: 0 },
      };

      virtualizer.appendPost(matchingCol.id, newPost);
      columns = [...columns];
    }
  }

  function openComposerNew() {
    composerInitialTargets = availableProfiles.length > 0
      ? availableProfiles.map((p) => ({ profileId: p.id, protocol: (p.protocols[0] as any) || 'mastodon' }))
      : [{ profileId: 'default', protocol: 'mastodon' }];
    composerInitialText = '';
    inReplyToId = null;
    showComposer = true;
  }

  function openReplyComposer(post: DeckPost, col: DeckColumn) {
    composerInitialTargets = [{ profileId: col.profileId, protocol: col.protocol }];
    composerInitialText = `${post.author.handle} `;
    inReplyToId = post.id;
    showComposer = true;
  }

  function handleBroadcastSubmitted(e: CustomEvent) {
    showComposer = false;
  }

  function toggleLike(post: DeckPost) {
    if (!post.metrics) post.metrics = { replies: 0, reposts: 0, likes: 0 };
    post.metrics.likes++;
    columns = [...columns];
  }

  function toggleRepost(post: DeckPost) {
    if (!post.metrics) post.metrics = { replies: 0, reposts: 0, likes: 0 };
    post.metrics.reposts++;
    columns = [...columns];
  }

  onMount(() => {
    initSSE();

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
    if (eventSource) {
      eventSource.close();
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
  });
</script>

<div class="hoist-deck-app theme-{theme}">
  <!-- Top Navigation & Control Header -->
  <header class="deck-topbar">
    <div class="brand-cluster">
      <span class="nautical-flag">🚩</span>
      <h1 class="brand-title">PENNANT HOIST</h1>
      <span class="brand-badge">DECK V1</span>
    </div>

    <!-- Center: Stream Health Badge -->
    <div class="health-cluster">
      <div class="health-badge status-{connectionStatus}">
        <span class="status-dot"></span>
        <span class="status-text">
          {#if connectionStatus === 'live'}
            STREAM LIVE (SSE MULTIPLEXED)
          {:else if connectionStatus === 'connecting'}
            CONNECTING STREAMHUB...
          {:else}
            OFFLINE (RETRYING)
          {/if}
        </span>
      </div>
      <span class="stream-count-tag">{columns.length} Active Streams</span>
    </div>

    <!-- Right Controls: Theme Toggle & New Broadcast -->
    <div class="controls-cluster">
      <div class="theme-picker" role="radiogroup" aria-label="Deck Theme">
        <button
          type="button"
          class="theme-btn"
          class:active={theme === 'slate'}
          on:click={() => (theme = 'slate')}
          title="Slate Modern Theme"
        >
          Slate
        </button>
        <button
          type="button"
          class="theme-btn"
          class:active={theme === 'paper'}
          on:click={() => (theme = 'paper')}
          title="Paper Clean Theme"
        >
          Paper
        </button>
        <button
          type="button"
          class="theme-btn"
          class:active={theme === 'amber'}
          on:click={() => (theme = 'amber')}
          title="Amber Phosphor Retro TUI Theme"
        >
          Amber
        </button>
      </div>

      <button type="button" class="btn-broadcast-cta" on:click={openComposerNew}>
        + New Broadcast
      </button>
    </div>
  </header>

  <!-- Composer Modal Overlay -->
  {#if showComposer}
    <div class="composer-modal-backdrop" on:click|self={() => (showComposer = false)}>
      <div class="composer-modal-content">
        <Composer
          initialTargets={composerInitialTargets}
          on:cancel={() => (showComposer = false)}
          on:broadcast={handleBroadcastSubmitted}
        />
      </div>
    </div>
  {/if}

  <!-- Main 2D Virtualized Deck Container -->
  <main
    bind:this={rootElement}
    class="deck-viewport"
    on:scroll={handleHorizontalScroll}
  >
    <div class="deck-track" style="gap: {virtualizer['config'].columnGap}px;">
      <!-- Leading Spacer for Off-Screen Columns -->
      <div
        class="h-spacer-start"
        style="width: {hWindow.offsetStart}px;"
        aria-hidden="true"
      ></div>

      <!-- Mounted Columns (4-6 columns + buffer) -->
      {#each hWindow.mountedColumns as col (col.id)}
        {@const vWin = virtualizer.getVerticalWindow(col.id)}
        <section class="deck-column col-proto-{col.protocol}" data-column-id={col.id}>
          <!-- Column Header -->
          <header class="column-header">
            <div class="col-title-wrap">
              <span class="col-title">{col.title || col.id}</span>
              <span class="proto-badge proto-{col.protocol}">{col.protocol}</span>
            </div>
            <span class="col-profile">{col.profileId}</span>
          </header>

          <!-- Column Scrollable Body with Vertical Virtualization -->
          <div
            class="column-scroll"
            on:scroll={(e) => handleColumnScroll(col.id, e)}
          >
            <!-- Top vertical spacer for off-screen cards -->
            <div class="v-spacer-top" style="height: {vWin.offsetStart}px;" aria-hidden="true"></div>

            <div class="column-cards-list">
              {#each vWin.mountedPosts as post (post.id)}
                {@const layout = calculateCardLayout(post, 360)}
                <article class="deck-card" data-post-id={post.id}>
                  <!-- Card Header -->
                  <div class="card-author-row">
                    <div class="author-details">
                      {#if post.author.avatarUrl}
                        <img class="avatar" src={post.author.avatarUrl} alt={post.author.name} loading="lazy" />
                      {:else}
                        <div class="avatar-ph">{post.author.name.slice(0, 2).toUpperCase()}</div>
                      {/if}
                      <div class="name-block">
                        <strong class="display-name">{post.author.name}</strong>
                        <span class="handle">{post.author.handle}</span>
                      </div>
                    </div>
                    <time class="time-stamp">
                      {new Date(post.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </time>
                  </div>

                  <!-- Card Text Content -->
                  <div class="card-content">
                    <p>{post.content}</p>
                  </div>

                  <!-- Zero-CLS Pre-Allocated Media Slot -->
                  {#if post.media && post.media.length > 0}
                    {@const media = post.media[0]}
                    <div
                      class="card-media-box"
                      style="aspect-ratio: {layout.mediaAspectRatio || '16 / 9'}; background: {layout.placeholderBg || '#1e293b'};"
                    >
                      <img src={media.previewUrl || media.url} alt="Media" loading="lazy" />
                    </div>
                  {/if}

                  <!-- Card Action Footer (Like, Repost, Reply) -->
                  <footer class="card-actions">
                    <button type="button" class="act-btn reply-btn" on:click={() => openReplyComposer(post, col)} title="Reply">
                      💬 <span class="act-count">{post.metrics?.replies || 0}</span>
                    </button>
                    <button type="button" class="act-btn repost-btn" on:click={() => toggleRepost(post)} title="Repost">
                      🔄 <span class="act-count">{post.metrics?.reposts || 0}</span>
                    </button>
                    <button type="button" class="act-btn like-btn" on:click={() => toggleLike(post)} title="Like">
                      ❤️ <span class="act-count">{post.metrics?.likes || 0}</span>
                    </button>
                  </footer>
                </article>
              {/each}
            </div>

            <!-- Bottom vertical spacer for off-screen cards -->
            <div class="v-spacer-bottom" style="height: {vWin.offsetEnd}px;" aria-hidden="true"></div>
          </div>
        </section>
      {/each}

      <!-- Trailing Spacer for Off-Screen Columns -->
      <div
        class="h-spacer-end"
        style="width: {hWindow.offsetEnd}px;"
        aria-hidden="true"
      ></div>
    </div>
  </main>
</div>

<style>
  /* Base Container */
  .hoist-deck-app {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  /* Theme: Slate Modern (Default) */
  .theme-slate {
    background: #090d16;
    color: #e2e8f0;
    --deck-topbar-bg: #0f172a;
    --deck-topbar-border: #1e293b;
    --col-bg: #111827;
    --col-border: #1f2937;
    --col-header-bg: #1e293b;
    --col-header-border: #334155;
    --card-bg: #1e293b;
    --card-border: #334155;
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --accent: #38bdf8;
  }

  /* Theme: Paper Clean */
  .theme-paper {
    background: #f8fafc;
    color: #1e293b;
    --deck-topbar-bg: #ffffff;
    --deck-topbar-border: #e2e8f0;
    --col-bg: #ffffff;
    --col-border: #e2e8f0;
    --col-header-bg: #f1f5f9;
    --col-header-border: #e2e8f0;
    --card-bg: #ffffff;
    --card-border: #e2e8f0;
    --text-primary: #0f172a;
    --text-secondary: #64748b;
    --accent: #2563eb;
  }

  /* Theme: Amber Phosphor Retro TUI */
  .theme-amber {
    background: #0d0a04;
    color: #f59e0b;
    --deck-topbar-bg: #181206;
    --deck-topbar-border: #78350f;
    --col-bg: #130e05;
    --col-border: #78350f;
    --col-header-bg: #271a07;
    --col-header-border: #92400e;
    --card-bg: #1e1408;
    --card-border: #78350f;
    --text-primary: #fbbf24;
    --text-secondary: #d97706;
    --accent: #f59e0b;
    font-family: "Courier New", Courier, monospace;
  }

  /* Top Navigation Bar */
  .deck-topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 18px;
    background: var(--deck-topbar-bg);
    border-bottom: 1px solid var(--deck-topbar-border);
    flex-shrink: 0;
  }

  .brand-cluster {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .brand-title {
    margin: 0;
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.08em;
    color: var(--text-primary);
  }

  .brand-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    background: rgba(56, 189, 248, 0.15);
    color: var(--accent);
    border-radius: 4px;
  }

  /* Health Badge */
  .health-cluster {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .health-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 4px 10px;
    border-radius: 12px;
  }

  .health-badge.status-live {
    background: rgba(16, 185, 129, 0.12);
    color: #10b981;
  }

  .health-badge.status-connecting {
    background: rgba(245, 158, 11, 0.12);
    color: #f59e0b;
  }

  .health-badge.status-offline {
    background: rgba(239, 68, 68, 0.12);
    color: #ef4444;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  .stream-count-tag {
    font-size: 12px;
    color: var(--text-secondary);
  }

  /* Controls */
  .controls-cluster {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .theme-picker {
    display: flex;
    border: 1px solid var(--deck-topbar-border);
    border-radius: 4px;
    overflow: hidden;
  }

  .theme-btn {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 11px;
    padding: 4px 10px;
    cursor: pointer;
  }

  .theme-btn.active {
    background: var(--accent);
    color: #090d16;
    font-weight: 700;
  }

  .btn-broadcast-cta {
    background: #2563eb;
    color: #ffffff;
    border: none;
    padding: 6px 14px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .btn-broadcast-cta:hover {
    background: #1d4ed8;
  }

  /* Modal Backdrop */
  .composer-modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
    z-index: 999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .composer-modal-content {
    width: 100%;
    max-width: 620px;
  }

  /* 2D Virtualized Viewport */
  .deck-viewport {
    flex: 1;
    overflow-x: auto;
    overflow-y: hidden;
    position: relative;
    contain: strict;
  }

  .deck-track {
    display: flex;
    flex-direction: row;
    height: 100%;
    align-items: stretch;
    padding: 12px 16px;
    box-sizing: border-box;
  }

  .h-spacer-start,
  .h-spacer-end {
    flex-shrink: 0;
  }

  /* Columns */
  .deck-column {
    width: 360px;
    min-width: 360px;
    max-width: 360px;
    height: 100%;
    background: var(--col-bg);
    border: 1px solid var(--col-border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
    box-sizing: border-box;
  }

  .column-header {
    padding: 10px 14px;
    background: var(--col-header-bg);
    border-bottom: 1px solid var(--col-header-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    user-select: none;
    flex-shrink: 0;
  }

  .col-title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .col-title {
    font-weight: 700;
    font-size: 13px;
    color: var(--text-primary);
  }

  .proto-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    font-weight: 700;
  }

  .proto-mastodon { background: rgba(99, 102, 241, 0.18); color: #818cf8; }
  .proto-atproto { background: rgba(14, 165, 233, 0.18); color: #38bdf8; }
  .proto-nostr { background: rgba(168, 85, 247, 0.18); color: #c084fc; }
  .proto-matrix { background: rgba(16, 185, 129, 0.18); color: #34d399; }

  .col-profile {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .column-scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 10px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  .column-cards-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Card */
  .deck-card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 6px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    word-break: break-word;
  }

  .card-author-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .author-details {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
  }

  .avatar-ph {
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

  .name-block {
    display: flex;
    flex-direction: column;
  }

  .display-name {
    color: var(--text-primary);
    font-size: 13px;
  }

  .handle {
    color: var(--text-secondary);
    font-size: 11px;
  }

  .time-stamp {
    color: var(--text-secondary);
    font-size: 11px;
  }

  .card-content p {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
    color: var(--text-primary);
  }

  .card-media-box {
    width: 100%;
    border-radius: 4px;
    overflow: hidden;
    position: relative;
    contain: size layout paint;
  }

  .card-media-box img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    position: absolute;
    top: 0;
    left: 0;
  }

  .card-actions {
    display: flex;
    gap: 16px;
    margin-top: 4px;
  }

  .act-btn {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    transition: all 0.12s ease;
  }

  .act-btn:hover {
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.05);
  }

  .act-count {
    font-size: 11px;
  }
</style>
