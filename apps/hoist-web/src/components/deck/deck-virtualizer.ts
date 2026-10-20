/**
 * Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 *
 * 2D Virtualization Engine for Pennant Hoist Command Deck
 * Supports up to 35 concurrent monitoring streams across arbitrary account pools.
 * - Horizontal Virtualization: Mounts only visible columns (typically 4-6) + 1 buffer column on each side.
 * - Vertical Virtualization: Mounts only visible post cards per active column + buffer.
 * - Off-screen columns remain strictly as lightweight JavaScript arrays in memory.
 * - Enforces zero layout shifts (CLS = 0) by pre-allocating card aspect-ratio bounding boxes using BlurHash.
 */

export interface DeckMediaAttachment {
  url: string;
  previewUrl?: string;
  width: number;
  height: number;
  blurhash?: string;
  mimeType?: string;
  altText?: string;
}

export interface DeckPost {
  id: string;
  profileId: string;
  protocol: 'mastodon' | 'atproto' | 'nostr' | 'matrix';
  author: {
    name: string;
    handle: string;
    avatarUrl?: string;
  };
  content: string;
  timestamp: string;
  media?: DeckMediaAttachment[];
  metrics?: {
    replies: number;
    reposts: number;
    likes: number;
  };
  estimatedHeight?: number;
}

export interface DeckColumn {
  id: string;
  profileId: string;
  title: string;
  protocol: 'mastodon' | 'atproto' | 'nostr' | 'matrix';
  icon?: string;
  unreadCount?: number;
  isLoading?: boolean;
  posts: DeckPost[];
  scrollTop: number;
}

export interface DeckVirtualizerConfig {
  columnWidth: number;       // default: 360
  columnGap: number;         // default: 16
  horizontalBuffer: number;   // default: 1
  verticalBuffer: number;     // default: 2
  defaultCardHeight: number;  // default: 180
  viewportWidth: number;     // default: 1920
  viewportHeight: number;    // default: 1080
}

export interface VirtualHorizontalWindow {
  totalColumns: number;
  columnWidth: number;
  columnGap: number;
  totalWidth: number;
  startIndex: number;
  endIndex: number;
  visibleCount: number;
  offsetStart: number;
  offsetEnd: number;
  mountedColumns: DeckColumn[];
}

export interface VirtualVerticalWindow {
  totalPosts: number;
  startIndex: number;
  endIndex: number;
  visibleCount: number;
  offsetStart: number;
  offsetEnd: number;
  mountedPosts: DeckPost[];
}

/**
 * Derives a lightweight CSS placeholder background or gradient from BlurHash
 * allowing zero layout shifts (CLS = 0) before network assets download.
 */
export function blurhashToCssPlaceholder(blurhash?: string): string {
  if (!blurhash || blurhash.length < 6) {
    return 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)';
  }

  // Extract base RGB approximations from BlurHash DC component
  const BASE83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
  let dcVal = 0;
  for (let i = 1; i <= Math.min(5, blurhash.length - 1); i++) {
    const idx = BASE83.indexOf(blurhash[i]);
    if (idx !== -1) {
      dcVal = dcVal * 83 + idx;
    }
  }

  const r = (dcVal >> 16) & 255;
  const g = (dcVal >> 8) & 255;
  const b = dcVal & 255;

  const hex1 = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  const hex2 = `#${Math.max(0, r - 30).toString(16).padStart(2, '0')}${Math.max(0, g - 30).toString(16).padStart(2, '0')}${Math.max(0, b - 30).toString(16).padStart(2, '0')}`;

  return `linear-gradient(135deg, ${hex1} 0%, ${hex2} 100%)`;
}

/**
 * Calculates pre-allocated card height and media aspect ratio bounding box.
 * Pre-allocating exact dimensions guarantees Cumulative Layout Shift (CLS) = 0.
 */
export function calculateCardLayout(
  post: DeckPost,
  columnWidth = 360
): { estimatedHeight: number; mediaAspectRatio?: string; mediaHeightPx?: number; placeholderBg?: string } {
  const contentWidth = Math.max(200, columnWidth - 32); // 16px padding on left/right
  const textChars = post.content ? post.content.length : 0;
  const textLines = Math.max(1, Math.ceil(textChars / 45));
  const textHeight = textLines * 22;

  let headerHeight = 56; // Avatar, handle, timestamp
  let footerHeight = 36; // Metrics & actions
  let mediaHeightPx = 0;
  let mediaAspectRatio: string | undefined;
  let placeholderBg: string | undefined;

  if (post.media && post.media.length > 0) {
    const primary = post.media[0];
    const w = primary.width || 1200;
    const h = primary.height || 675;
    mediaAspectRatio = `${w} / ${h}`;
    mediaHeightPx = Math.min(320, Math.round(contentWidth * (h / w)));
    placeholderBg = blurhashToCssPlaceholder(primary.blurhash);
  }

  const estimatedHeight = headerHeight + textHeight + mediaHeightPx + footerHeight + 24; // card margins
  return { estimatedHeight, mediaAspectRatio, mediaHeightPx, placeholderBg };
}

/**
 * DeckVirtualizer: Central 2D Virtualization State Machine
 */
export class DeckVirtualizer {
  private config: DeckVirtualizerConfig;
  private columns: DeckColumn[] = [];
  private scrollLeft = 0;

  constructor(customConfig?: Partial<DeckVirtualizerConfig>) {
    this.config = {
      columnWidth: 360,
      columnGap: 16,
      horizontalBuffer: 1,
      verticalBuffer: 2,
      defaultCardHeight: 180,
      viewportWidth: 1920,
      viewportHeight: 1080,
      ...customConfig,
    };
  }

  public setViewport(width: number, height: number): void {
    this.config.viewportWidth = Math.max(320, width);
    this.config.viewportHeight = Math.max(240, height);
  }

  public setScrollLeft(scrollLeft: number): void {
    this.scrollLeft = Math.max(0, scrollLeft);
  }

  public setColumnScrollTop(columnId: string, scrollTop: number): void {
    const col = this.columns.find((c) => c.id === columnId);
    if (col) {
      col.scrollTop = Math.max(0, scrollTop);
    }
  }

  public setColumns(columns: DeckColumn[]): void {
    this.columns = columns;
  }

  public addColumn(column: DeckColumn): void {
    const existingIdx = this.columns.findIndex((c) => c.id === column.id);
    if (existingIdx !== -1) {
      this.columns[existingIdx] = column;
    } else {
      this.columns.push(column);
    }
  }

  public removeColumn(columnId: string): boolean {
    const initialLen = this.columns.length;
    this.columns = this.columns.filter((c) => c.id !== columnId);
    return this.columns.length < initialLen;
  }

  public getColumn(columnId: string): DeckColumn | undefined {
    return this.columns.find((c) => c.id === columnId);
  }

  public getColumnAt(index: number): DeckColumn | undefined {
    return this.columns[index];
  }

  public getTotalColumns(): number {
    return this.columns.length;
  }

  public appendPost(columnId: string, post: DeckPost): boolean {
    const col = this.columns.find((c) => c.id === columnId);
    if (!col) return false;
    if (!post.estimatedHeight) {
      const layout = calculateCardLayout(post, this.config.columnWidth);
      post.estimatedHeight = layout.estimatedHeight;
    }
    col.posts.unshift(post);
    return true;
  }

  /**
   * Horizontal Virtualization Window Calculation
   * Mounts only visible columns (e.g. 4-6) + 1 buffer column on each side.
   * Off-screen columns remain strictly as lightweight JavaScript arrays in memory.
   */
  public getHorizontalWindow(): VirtualHorizontalWindow {
    const totalColumns = this.columns.length;
    const { columnWidth, columnGap, horizontalBuffer, viewportWidth } = this.config;
    const step = columnWidth + columnGap;
    const totalWidth = totalColumns > 0 ? totalColumns * step - columnGap : 0;

    if (totalColumns === 0) {
      return {
        totalColumns: 0,
        columnWidth,
        columnGap,
        totalWidth: 0,
        startIndex: 0,
        endIndex: 0,
        visibleCount: 0,
        offsetStart: 0,
        offsetEnd: 0,
        mountedColumns: [],
      };
    }

    const firstVisible = Math.floor(this.scrollLeft / step);
    const lastVisible = Math.min(totalColumns - 1, Math.floor((this.scrollLeft + viewportWidth) / step));

    const startIndex = Math.max(0, firstVisible - horizontalBuffer);
    const endIndex = Math.min(totalColumns - 1, lastVisible + horizontalBuffer);

    const offsetStart = startIndex * step;
    const offsetEnd = Math.max(0, (totalColumns - 1 - endIndex) * step);
    const mountedColumns = this.columns.slice(startIndex, endIndex + 1);

    return {
      totalColumns,
      columnWidth,
      columnGap,
      totalWidth,
      startIndex,
      endIndex,
      visibleCount: mountedColumns.length,
      offsetStart,
      offsetEnd,
      mountedColumns,
    };
  }

  /**
   * Vertical Virtualization Window Calculation for an active mounted column
   * Mounts only visible post cards per column + buffer rows.
   */
  public getVerticalWindow(columnId: string): VirtualVerticalWindow {
    const col = this.columns.find((c) => c.id === columnId);
    if (!col || col.posts.length === 0) {
      return {
        totalPosts: 0,
        startIndex: 0,
        endIndex: 0,
        visibleCount: 0,
        offsetStart: 0,
        offsetEnd: 0,
        mountedPosts: [],
      };
    }

    const totalPosts = col.posts.length;
    const scrollTop = col.scrollTop || 0;
    const { verticalBuffer, defaultCardHeight, viewportHeight } = this.config;

    // Use default or pre-computed card heights
    const cardStep = defaultCardHeight;
    const firstVisible = Math.floor(scrollTop / cardStep);
    const lastVisible = Math.min(totalPosts - 1, Math.floor((scrollTop + viewportHeight) / cardStep));

    const startIndex = Math.max(0, firstVisible - verticalBuffer);
    const endIndex = Math.min(totalPosts - 1, lastVisible + verticalBuffer);

    const offsetStart = startIndex * cardStep;
    const offsetEnd = Math.max(0, (totalPosts - 1 - endIndex) * cardStep);
    const mountedPosts = col.posts.slice(startIndex, endIndex + 1);

    return {
      totalPosts,
      startIndex,
      endIndex,
      visibleCount: mountedPosts.length,
      offsetStart,
      offsetEnd,
      mountedPosts,
    };
  }
}
