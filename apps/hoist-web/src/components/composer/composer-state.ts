/**
 * Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 *
 * Dynamic Composer State Machine
 * Manages multi-target state, grapheme counting, auto-facets, thread-splitting,
 * protocol constraint validation, and per-target overrides.
 */

import type { PreStagedMedia } from '../../../../../packages/core/src/adapters/media-airlock.ts';

export type TargetProtocol = 'bluesky' | 'mastodon' | 'nostr' | 'matrix';

export interface TargetProfile {
  profileId: string;
  protocol: TargetProtocol;
  customTextOverride?: string;
  contentWarning?: string;
}

export interface TextFacet {
  index: {
    byteStart: number;
    byteEnd: number;
  };
  features: Array<{
    $type: string;
    uri?: string;
    did?: string;
    tag?: string;
  }>;
}

export interface ThreadPost {
  index: number;
  total: number;
  text: string;
  facets?: TextFacet[];
  media?: PreStagedMedia[];
  contentWarning?: string;
}

export interface TargetValidation {
  profileId: string;
  protocol: TargetProtocol;
  length: number;
  limit: number;
  remaining: number;
  isValid: boolean;
  isOverLimit: boolean;
  needsSplit: boolean;
  threadCount: number;
  effectiveText: string;
  renderedHtml?: string;
  facets?: TextFacet[];
}

export interface ComposerSnapshot {
  baseText: string;
  media: PreStagedMedia[];
  targets: TargetProfile[];
  splitThread: boolean;
  contentWarning: string;
  scheduledFor?: string;
  syncToEdge: boolean;
  validations: TargetValidation[];
  isSubmittable: boolean;
}

/**
 * Counts unicode grapheme clusters accurately (e.g. multi-byte emojis, skin tones, ZWJ sequences)
 */
export function countGraphemes(text: string): number {
  if (!text) return 0;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    let count = 0;
    for (const _ of segmenter.segment(text)) {
      count++;
    }
    return count;
  }
  // Fallback for environments without Intl.Segmenter
  return Array.from(text).length;
}

/**
 * Calculates UTF-8 byte length and UTF-8 byte offsets for ATProto facets
 */
function getUtf8ByteOffsets(fullText: string, charStart: number, charEnd: number): { byteStart: number; byteEnd: number } {
  const enc = new TextEncoder();
  const leadingText = fullText.slice(0, charStart);
  const targetText = fullText.slice(charStart, charEnd);
  const byteStart = enc.encode(leadingText).length;
  const byteEnd = byteStart + enc.encode(targetText).length;
  return { byteStart, byteEnd };
}

/**
 * Detects URL and mention facets for ATProto records
 */
export function detectFacets(text: string): TextFacet[] {
  const facets: TextFacet[] = [];
  if (!text) return facets;

  // 1. Detect URLs
  const urlRegex = /https?:\/\/[^\s]+/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const { byteStart, byteEnd } = getUtf8ByteOffsets(text, start, end);
    facets.push({
      index: { byteStart, byteEnd },
      features: [{
        $type: 'app.bsky.richtext.facet#link',
        uri: match[0],
      }],
    });
  }

  // 2. Detect Mentions (@handle.domain)
  const mentionRegex = /(^|\s)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  while ((match = mentionRegex.exec(text)) !== null) {
    const leadingSpace = match[1].length;
    const handle = match[2];
    const start = match.index + leadingSpace;
    const end = start + handle.length + 1; // including '@'
    const { byteStart, byteEnd } = getUtf8ByteOffsets(text, start, end);
    facets.push({
      index: { byteStart, byteEnd },
      features: [{
        $type: 'app.bsky.richtext.facet#mention',
        did: `did:plc:${handle}`, // Staged DID placeholder
      }],
    });
  }

  return facets;
}

/**
 * Maps Nostr NIP-27 mentions (@npub1... -> nostr:npub1...)
 */
export function mapNostrMentions(text: string): string {
  if (!text) return '';
  return text.replace(/(^|\s)@(npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58})/g, '$1nostr:$2');
}

/**
 * Renders Markdown-lite plaintext into Matrix-compliant HTML
 */
export function renderMatrixHtml(text: string): string {
  if (!text) return '';
  let escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Bold **text**
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italic *text*
  escaped = escaped.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Linebreaks to <br/>
  escaped = escaped.replace(/\n/g, '<br/>');

  return `<p>${escaped}</p>`;
}

/**
 * Intelligent thread split calculator
 * Breaks long text across word boundaries while appending numbered thread markers (e.g. "1/3 ")
 */
export function calculateThreadSplit(
  text: string,
  limit: number,
  media: PreStagedMedia[] = [],
  contentWarning?: string
): ThreadPost[] {
  const graphemeLen = countGraphemes(text);
  if (graphemeLen <= limit) {
    return [{
      index: 1,
      total: 1,
      text,
      facets: detectFacets(text),
      media,
      contentWarning,
    }];
  }

  const reservedGraphemes = 7;
  const chunkLimit = limit - reservedGraphemes;
  const rawChunks: string[] = [];

  const words = text.split(/(\s+)/);
  let currentChunk = '';

  for (let part of words) {
    // If a single word itself exceeds chunkLimit, split it
    while (countGraphemes(part) > chunkLimit) {
      if (currentChunk.trim().length > 0) {
        rawChunks.push(currentChunk.trim());
        currentChunk = '';
      }
      const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
      const graphemes = Array.from(segmenter.segment(part)).map((s) => s.segment);
      const head = graphemes.slice(0, chunkLimit).join('');
      part = graphemes.slice(chunkLimit).join('');
      rawChunks.push(head);
    }

    if (countGraphemes(currentChunk + part) <= chunkLimit) {
      currentChunk += part;
    } else {
      if (currentChunk.trim().length > 0) {
        rawChunks.push(currentChunk.trim());
      }
      currentChunk = part;
    }
  }

  if (currentChunk.trim().length > 0) {
    rawChunks.push(currentChunk.trim());
  }

  const total = rawChunks.length;
  return rawChunks.map((chunk, idx) => {
    const threadPrefix = `${idx + 1}/${total} `;
    const postText = `${threadPrefix}${chunk}`;
    return {
      index: idx + 1,
      total,
      text: postText,
      facets: detectFacets(postText),
      // Assign media to the first post of the thread
      media: idx === 0 ? media : [],
      contentWarning: idx === 0 ? contentWarning : undefined,
    };
  });
}

/**
 * Composer State Machine
 */
export class ComposerStateMachine {
  private baseText = '';
  private media: PreStagedMedia[] = [];
  private targets: TargetProfile[] = [];
  private splitThread = false;
  private contentWarning = '';
  private scheduledFor?: string;
  private syncToEdge = true;
  private listeners: Array<(snapshot: ComposerSnapshot) => void> = [];

  constructor(initial?: {
    baseText?: string;
    media?: PreStagedMedia[];
    targets?: TargetProfile[];
  }) {
    if (initial?.baseText) this.baseText = initial.baseText;
    if (initial?.media) this.media = [...initial.media];
    if (initial?.targets) this.targets = [...initial.targets];
  }

  public subscribe(listener: (snapshot: ComposerSnapshot) => void): () => void {
    this.listeners.push(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }

  public setBaseText(text: string): void {
    this.baseText = text;
    this.notify();
  }

  public getBaseText(): string {
    return this.baseText;
  }

  public setContentWarning(cw: string): void {
    this.contentWarning = cw;
    this.notify();
  }

  public getContentWarning(): string {
    return this.contentWarning;
  }

  public setScheduledFor(dateTimeIso?: string): void {
    this.scheduledFor = dateTimeIso;
    this.notify();
  }

  public getScheduledFor(): string | undefined {
    return this.scheduledFor;
  }

  public toggleSplitThread(enabled?: boolean): void {
    this.splitThread = enabled !== undefined ? enabled : !this.splitThread;
    this.notify();
  }

  public isSplitThread(): boolean {
    return this.splitThread;
  }

  public addTarget(target: TargetProfile): void {
    const exists = this.targets.find(
      (t) => t.profileId === target.profileId && t.protocol === target.protocol
    );
    if (!exists) {
      this.targets.push({ ...target });
      this.notify();
    }
  }

  public removeTarget(profileId: string, protocol: TargetProtocol): void {
    this.targets = this.targets.filter(
      (t) => !(t.profileId === profileId && t.protocol === protocol)
    );
    this.notify();
  }

  public setTargets(targets: TargetProfile[]): void {
    this.targets = [...targets];
    this.notify();
  }

  public getTargets(): TargetProfile[] {
    return [...this.targets];
  }

  public setCustomOverride(profileId: string, protocol: TargetProtocol, text: string): void {
    const target = this.targets.find(
      (t) => t.profileId === profileId && t.protocol === protocol
    );
    if (target) {
      target.customTextOverride = text;
      this.notify();
    }
  }

  public clearCustomOverride(profileId: string, protocol: TargetProtocol): void {
    const target = this.targets.find(
      (t) => t.profileId === profileId && t.protocol === protocol
    );
    if (target) {
      delete target.customTextOverride;
      this.notify();
    }
  }

  public addMedia(asset: PreStagedMedia): void {
    if (!this.media.some((m) => m.hash === asset.hash)) {
      this.media.push(asset);
      this.notify();
    }
  }

  public removeMedia(idOrHash: string): void {
    this.media = this.media.filter((m) => m.id !== idOrHash && m.hash !== idOrHash);
    this.notify();
  }

  public getMedia(): PreStagedMedia[] {
    return [...this.media];
  }

  public clearMedia(): void {
    this.media = [];
    this.notify();
  }

  public setSyncToEdge(enabled: boolean): void {
    this.syncToEdge = enabled;
    this.notify();
  }

  public getSyncToEdge(): boolean {
    return this.syncToEdge;
  }

  /**
   * Calculates per-target constraints, character counts, and validity
   */
  public getValidationForTarget(target: TargetProfile): TargetValidation {
    const effectiveText = target.customTextOverride !== undefined
      ? target.customTextOverride
      : this.baseText;

    let limit = 500;
    let length = 0;
    let renderedHtml: string | undefined;
    let facets: TextFacet[] | undefined;

    switch (target.protocol) {
      case 'bluesky':
        limit = 300;
        length = countGraphemes(effectiveText);
        facets = detectFacets(effectiveText);
        break;

      case 'mastodon':
        limit = 500;
        length = effectiveText.length;
        break;

      case 'nostr':
        limit = 1000;
        length = effectiveText.length;
        break;

      case 'matrix':
        limit = 4000;
        length = effectiveText.length;
        renderedHtml = renderMatrixHtml(effectiveText);
        break;
    }

    const remaining = limit - length;
    const isOverLimit = remaining < 0;
    const hasContent = length > 0 || this.media.length > 0;
    const needsSplit = isOverLimit && !this.splitThread;

    let threadCount = 1;
    if (isOverLimit && this.splitThread) {
      const thread = calculateThreadSplit(effectiveText, limit, this.media, this.contentWarning);
      threadCount = thread.length;
    }

    const isValid = hasContent && (!isOverLimit || this.splitThread);

    return {
      profileId: target.profileId,
      protocol: target.protocol,
      length,
      limit,
      remaining,
      isValid,
      isOverLimit,
      needsSplit,
      threadCount,
      effectiveText,
      renderedHtml,
      facets,
    };
  }

  /**
   * Generates the multi-protocol broadcast payload ready for queueing or dispatch
   */
  public getBroadcastPayloads(): Array<{
    profileId: string;
    protocol: TargetProtocol;
    posts: ThreadPost[];
    media: PreStagedMedia[];
    scheduledFor?: string;
  }> {
    const payloads = [];

    for (const target of this.targets) {
      const validation = this.getValidationForTarget(target);
      const effectiveText = target.customTextOverride !== undefined
        ? target.customTextOverride
        : this.baseText;

      const posts = this.splitThread && validation.isOverLimit
        ? calculateThreadSplit(effectiveText, validation.limit, this.media, this.contentWarning)
        : [{
            index: 1,
            total: 1,
            text: effectiveText,
            facets: validation.facets,
            media: this.media,
            contentWarning: target.contentWarning || this.contentWarning || undefined,
          }];

      payloads.push({
        profileId: target.profileId,
        protocol: target.protocol,
        posts,
        media: this.media,
        scheduledFor: this.scheduledFor,
        sync_to_edge: this.syncToEdge && Boolean(this.scheduledFor),
      });
    }

    return payloads;
  }

  public getSnapshot(): ComposerSnapshot {
    const validations = this.targets.map((t) => this.getValidationForTarget(t));
    const isSubmittable = this.targets.length > 0 &&
      validations.every((v) => v.isValid) &&
      (this.baseText.trim().length > 0 || this.media.length > 0);

    return {
      baseText: this.baseText,
      media: [...this.media],
      targets: [...this.targets],
      splitThread: this.splitThread,
      contentWarning: this.contentWarning,
      scheduledFor: this.scheduledFor,
      syncToEdge: this.syncToEdge,
      validations,
      isSubmittable,
    };
  }
}
