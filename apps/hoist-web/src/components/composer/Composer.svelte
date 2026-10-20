<!--
  Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine

  Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
  Licensed under the MIT License.

  Adaptive Composer Component
  Features:
  - Multi-target live character/grapheme counters (BSKY 300, MASTO 500, NOSTR, MATRIX)
  - Instant background media airlock dropzone with BlurHash zero-CLS pre-allocation
  - Action drawer: Content Warnings, scheduled date/time picker, Split-Thread toggle
  - Per-target custom text overrides
-->
<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import {
    ComposerStateMachine,
    type TargetProfile,
    type TargetProtocol,
    type ComposerSnapshot,
  } from './composer-state.ts';
  import type { PreStagedMedia } from '../../../../../packages/core/src/adapters/media-airlock.ts';

  export let availableProfiles: Array<{ id: string; name: string; protocols: string[] }> = [];
  export let initialTargets: TargetProfile[] = [];
  export let stageMediaFn: ((file: File) => Promise<PreStagedMedia>) | null = null;

  const dispatch = createEventDispatcher<{
    broadcast: { payloads: any[]; scheduledFor?: string };
    cancel: void;
  }>();

  const composer = new ComposerStateMachine({
    targets: initialTargets.length > 0
      ? initialTargets
      : [
          { profileId: 'default', protocol: 'bluesky' },
          { profileId: 'default', protocol: 'mastodon' },
          { profileId: 'default', protocol: 'nostr' },
        ],
  });

  let snapshot: ComposerSnapshot = composer.getSnapshot();
  const unsubscribe = composer.subscribe((snap) => {
    snapshot = snap;
  });

  let baseInput = '';
  let showDrawer = false;
  let activeOverrideTarget: TargetProfile | null = null;
  let overrideText = '';
  let isDragging = false;
  let isStagingMedia = false;
  let fileInput: HTMLInputElement;

  function handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    baseInput = target.value;
    composer.setBaseText(baseInput);
  }

  function handleCwInput(e: Event) {
    const target = e.target as HTMLInputElement;
    composer.setContentWarning(target.value);
  }

  function handleScheduleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    composer.setScheduledFor(target.value ? new Date(target.value).toISOString() : undefined);
  }

  function handleSplitToggle() {
    composer.toggleSplitThread();
  }

  function toggleTarget(profileId: string, protocol: TargetProtocol) {
    const exists = snapshot.targets.some((t) => t.profileId === profileId && t.protocol === protocol);
    if (exists) {
      composer.removeTarget(profileId, protocol);
      if (activeOverrideTarget?.profileId === profileId && activeOverrideTarget?.protocol === protocol) {
        activeOverrideTarget = null;
      }
    } else {
      composer.addTarget({ profileId, protocol });
    }
  }

  function openOverrideEditor(target: TargetProfile) {
    activeOverrideTarget = target;
    overrideText = target.customTextOverride !== undefined ? target.customTextOverride : snapshot.baseText;
  }

  function saveOverride() {
    if (activeOverrideTarget) {
      if (overrideText === snapshot.baseText || overrideText.trim() === '') {
        composer.clearCustomOverride(activeOverrideTarget.profileId, activeOverrideTarget.protocol);
      } else {
        composer.setCustomOverride(activeOverrideTarget.profileId, activeOverrideTarget.protocol, overrideText);
      }
      activeOverrideTarget = null;
    }
  }

  function clearOverride() {
    if (activeOverrideTarget) {
      composer.clearCustomOverride(activeOverrideTarget.profileId, activeOverrideTarget.protocol);
      activeOverrideTarget = null;
    }
  }

  async function handleFileDrop(files: FileList | null) {
    if (!files || files.length === 0) return;
    isStagingMedia = true;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        let preStaged: PreStagedMedia;
        if (stageMediaFn) {
          preStaged = await stageMediaFn(file);
        } else {
          // Direct browser POST to Pennant Media Airlock API endpoint
          const formData = new FormData();
          formData.append('file', file);
          const resp = await fetch(`/api/media/stage?profile=default&targets=atproto,mastodon,nostr`, {
            method: 'POST',
            body: await file.arrayBuffer(),
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
            },
          });
          if (!resp.ok) throw new Error(`Media staging failed with HTTP ${resp.status}`);
          preStaged = await resp.json();
        }
        composer.addMedia(preStaged);
      } catch (err: any) {
        console.error('Failed to stage dropped media asset:', err.message);
      }
    }
    isStagingMedia = false;
  }

  function removeMedia(idOrHash: string) {
    composer.removeMedia(idOrHash);
  }

  function handleBroadcast() {
    if (!snapshot.isSubmittable) return;
    const payloads = composer.getBroadcastPayloads();
    dispatch('broadcast', {
      payloads,
      scheduledFor: snapshot.scheduledFor,
    });
  }

  function getBadgeColor(validation: any): string {
    if (validation.isOverLimit && !snapshot.splitThread) return '#ef4444';
    if (validation.isOverLimit && snapshot.splitThread) return '#f59e0b';
    if (validation.remaining <= 20) return '#f59e0b';
    return '#10b981';
  }
</script>

<div class="hoist-composer-shell">
  <!-- Top Bar: Target Network Selector & Status Counters -->
  <header class="composer-header">
    <div class="target-pills-row">
      <span class="label">Targets:</span>
      {#each snapshot.validations as v}
        <button
          type="button"
          class="target-pill"
          class:has-override={snapshot.targets.find(t => t.profileId === v.profileId && t.protocol === v.protocol)?.customTextOverride !== undefined}
          style="--pill-accent: {getBadgeColor(v)}"
          on:click={() => openOverrideEditor({ profileId: v.profileId, protocol: v.protocol })}
          title="Click to configure custom override for {v.profileId} ({v.protocol})"
        >
          <span class="protocol-name">{v.protocol}</span>
          <span class="counter-badge" style="color: {getBadgeColor(v)};">
            {#if v.needsSplit}
              OVER ({v.remaining})
            {:else if v.threadCount > 1}
              {v.threadCount}p ({v.remaining})
            {:else}
              {v.remaining}
            {/if}
          </span>
        </button>
      {/each}
    </div>

    <!-- Toggle Action Drawer Button -->
    <div class="header-actions">
      <button
        type="button"
        class="icon-btn"
        class:active={showDrawer || snapshot.contentWarning || snapshot.scheduledFor || snapshot.splitThread}
        on:click={() => (showDrawer = !showDrawer)}
        title="Options (Content Warnings, Schedule, Split-Thread)"
      >
        ⚙️ Options
      </button>
    </div>
  </header>

  <!-- Collapsible Action Drawer -->
  {#if showDrawer}
    <div class="composer-action-drawer">
      <div class="drawer-field">
        <label for="cw-input">Content Warning (CW / Sensitive):</label>
        <input
          id="cw-input"
          type="text"
          placeholder="e.g. Spoilers, sensitive topic"
          value={snapshot.contentWarning}
          on:input={handleCwInput}
        />
      </div>

      <div class="drawer-row">
        <div class="drawer-field">
          <label for="schedule-input">Schedule Dispatch (T-10m Pre-Staging):</label>
          <input
            id="schedule-input"
            type="datetime-local"
            on:input={handleScheduleInput}
          />
        </div>

        <div class="drawer-field toggle-field">
          <label class="toggle-label">
            <input
              type="checkbox"
              checked={snapshot.splitThread}
              on:change={handleSplitToggle}
            />
            <span>Auto Split Long Threads (300 grapheme ceiling)</span>
          </label>
        </div>
      </div>
    </div>
  {/if}

  <!-- Per-Target Override Editor Modal / Overlay -->
  {#if activeOverrideTarget}
    <div class="override-panel">
      <div class="override-header">
        <span>Custom Override for <strong>{activeOverrideTarget.profileId} ({activeOverrideTarget.protocol})</strong></span>
        <button type="button" class="close-btn" on:click={() => (activeOverrideTarget = null)}>✕</button>
      </div>
      <textarea
        class="override-textarea"
        bind:value={overrideText}
        placeholder="Custom text specifically for this target..."
      ></textarea>
      <div class="override-actions">
        <button type="button" class="btn-secondary" on:click={clearOverride}>Revert to Base</button>
        <button type="button" class="btn-primary" on:click={saveOverride}>Apply Override</button>
      </div>
    </div>
  {/if}

  <!-- Main Text Input Area -->
  <div class="textarea-container">
    <textarea
      class="main-textarea"
      placeholder="Compose universal broadcast... (Drop media or paste URLs)"
      value={baseInput}
      on:input={handleInput}
    ></textarea>
  </div>

  <!-- Media Airlock Dropzone & Staged Asset Bounding Boxes (Zero-CLS) -->
  <div
    class="media-airlock-zone"
    class:dragging={isDragging}
    role="region"
    aria-label="Media drop zone"
    on:dragenter|preventDefault={() => (isDragging = true)}
    on:dragover|preventDefault={() => (isDragging = true)}
    on:dragleave|preventDefault={() => (isDragging = false)}
    on:drop|preventDefault={(e) => {
      isDragging = false;
      handleFileDrop(e.dataTransfer?.files || null);
    }}
  >
    {#if snapshot.media.length > 0}
      <div class="staged-assets-grid">
        {#each snapshot.media as asset (asset.hash)}
          <div
            class="staged-asset-card"
            style="aspect-ratio: {asset.dimensions ? `${asset.dimensions.width} / ${asset.dimensions.height}` : '16 / 9'};"
          >
            <!-- BlurHash or preview placeholder with zero layout shift -->
            <img
              src={asset.mastodon?.previewUrl || asset.nostr?.url || ''}
              alt="Pre-staged asset"
              loading="lazy"
            />
            <div class="asset-meta-overlay">
              <span class="status-pill status-{asset.status}">{asset.status}</span>
              <button
                type="button"
                class="remove-asset-btn"
                on:click={() => removeMedia(asset.hash)}
                title="Remove asset"
              >
                ✕
              </button>
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="drop-hint" on:click={() => fileInput.click()} role="button" tabindex="0">
        <span>📎 Drop media assets here for instant background airlock staging (ATProto, Mastodon, Nostr, Matrix)</span>
      </div>
    {/if}

    <input
      bind:this={fileInput}
      type="file"
      multiple
      accept="image/*,video/*"
      style="display: none;"
      on:change={(e) => handleFileDrop((e.target as HTMLInputElement).files)}
    />
  </div>

  <!-- Footer Controls: Cancel and Broadcast Buttons -->
  <footer class="composer-footer">
    <div class="footer-left">
      {#if snapshot.scheduledFor}
        <span class="schedule-tag">⏰ Scheduled: {new Date(snapshot.scheduledFor).toLocaleString()}</span>
      {/if}
      {#if isStagingMedia}
        <span class="staging-indicator">⏳ Staging media across protocol airlocks...</span>
      {/if}
    </div>

    <div class="footer-right">
      <button type="button" class="btn-cancel" on:click={() => dispatch('cancel')}>
        Cancel
      </button>
      <button
        type="button"
        class="btn-broadcast"
        disabled={!snapshot.isSubmittable || isStagingMedia}
        on:click={handleBroadcast}
      >
        {snapshot.scheduledFor ? 'Schedule Broadcast' : 'Broadcast Now'}
      </button>
    </div>
  </footer>
</div>

<style>
  .hoist-composer-shell {
    display: flex;
    flex-direction: column;
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 8px;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow: hidden;
  }

  .composer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    background: #111827;
    border-bottom: 1px solid #1f2937;
  }

  .target-pills-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .target-pills-row .label {
    font-size: 12px;
    color: #94a3b8;
    font-weight: 600;
  }

  .target-pill {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    color: #cbd5e1;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .target-pill:hover {
    border-color: #64748b;
  }

  .target-pill.has-override {
    border-color: #38bdf8;
    background: rgba(56, 189, 248, 0.12);
  }

  .protocol-name {
    font-weight: 700;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.05em;
  }

  .counter-badge {
    font-weight: 600;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .icon-btn {
    background: transparent;
    border: 1px solid #334155;
    color: #94a3b8;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
  }

  .icon-btn.active {
    color: #38bdf8;
    border-color: #38bdf8;
    background: rgba(56, 189, 248, 0.1);
  }

  .composer-action-drawer {
    background: #1e293b;
    border-bottom: 1px solid #334155;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .drawer-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
  }

  .drawer-field label {
    font-size: 11px;
    font-weight: 600;
    color: #94a3b8;
  }

  .drawer-field input[type="text"],
  .drawer-field input[type="datetime-local"] {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 4px;
    padding: 6px 10px;
    color: #f8fafc;
    font-size: 13px;
  }

  .drawer-row {
    display: flex;
    gap: 16px;
    align-items: flex-end;
  }

  .toggle-field {
    justify-content: center;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #cbd5e1;
    cursor: pointer;
  }

  .override-panel {
    background: #1e293b;
    border: 1px solid #38bdf8;
    margin: 8px 12px;
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .override-header {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: #38bdf8;
  }

  .close-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    cursor: pointer;
  }

  .override-textarea {
    width: 100%;
    min-height: 70px;
    background: #090d16;
    border: 1px solid #334155;
    border-radius: 4px;
    color: #f8fafc;
    padding: 8px;
    font-size: 13px;
    resize: vertical;
    box-sizing: border-box;
  }

  .override-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .textarea-container {
    padding: 12px 14px;
  }

  .main-textarea {
    width: 100%;
    min-height: 120px;
    background: transparent;
    border: none;
    outline: none;
    color: #f8fafc;
    font-size: 14px;
    line-height: 1.5;
    resize: vertical;
    box-sizing: border-box;
    font-family: inherit;
  }

  .media-airlock-zone {
    margin: 0 14px 12px;
    border: 1px dashed #334155;
    border-radius: 6px;
    padding: 10px;
    background: rgba(15, 23, 42, 0.6);
    transition: all 0.15s ease;
  }

  .media-airlock-zone.dragging {
    border-color: #38bdf8;
    background: rgba(56, 189, 248, 0.08);
  }

  .drop-hint {
    text-align: center;
    font-size: 12px;
    color: #64748b;
    cursor: pointer;
    padding: 12px 0;
  }

  .drop-hint:hover {
    color: #94a3b8;
  }

  .staged-assets-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 10px;
  }

  .staged-asset-card {
    position: relative;
    border-radius: 4px;
    overflow: hidden;
    background: #1e293b;
    border: 1px solid #334155;
  }

  .staged-asset-card img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .asset-meta-overlay {
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    gap: 4px;
  }

  .status-pill {
    font-size: 9px;
    font-weight: 700;
    padding: 2px 4px;
    border-radius: 2px;
    text-transform: uppercase;
  }

  .status-ready { background: #10b981; color: #fff; }
  .status-processing { background: #f59e0b; color: #fff; }

  .remove-asset-btn {
    background: rgba(0, 0, 0, 0.6);
    border: none;
    color: #fff;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .composer-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    background: #111827;
    border-top: 1px solid #1f2937;
  }

  .schedule-tag {
    font-size: 12px;
    color: #38bdf8;
  }

  .staging-indicator {
    font-size: 12px;
    color: #f59e0b;
  }

  .footer-right {
    display: flex;
    gap: 10px;
  }

  .btn-cancel {
    background: transparent;
    border: 1px solid #334155;
    color: #94a3b8;
    padding: 6px 14px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
  }

  .btn-broadcast {
    background: #3b82f6;
    border: none;
    color: #fff;
    padding: 6px 16px;
    border-radius: 4px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .btn-broadcast:hover:not(:disabled) {
    background: #2563eb;
  }

  .btn-broadcast:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: #38bdf8;
    border: none;
    color: #0f172a;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
  }

  .btn-secondary {
    background: transparent;
    border: 1px solid #475569;
    color: #94a3b8;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
  }
</style>
