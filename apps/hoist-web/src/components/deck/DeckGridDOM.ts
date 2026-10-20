/**
 * Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine
 *
 * Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
 * Licensed under the MIT License.
 *
 * Lightweight DOM Implementation of the 2D Virtualized Deck Grid
 * Can run standalone in browsers or dashboards without bundling overhead.
 */

import {
  DeckVirtualizer,
  calculateCardLayout,
  type DeckColumn,
  type DeckPost,
  type DeckVirtualizerConfig,
} from './deck-virtualizer.ts';

export class DeckGridDOM {
  private container: HTMLElement;
  private virtualizer: DeckVirtualizer;
  private rootElement?: HTMLDivElement;
  private horizontalTrack?: HTMLDivElement;
  private spacerStart?: HTMLDivElement;
  private spacerEnd?: HTMLDivElement;
  private mountedColumnElements = new Map<string, HTMLDivElement>();
  private resizeObserver?: any;
  private onColumnScrollHandlers = new Map<string, (e: Event) => void>();

  constructor(container: HTMLElement, config?: Partial<DeckVirtualizerConfig>) {
    this.container = container;
    this.virtualizer = new DeckVirtualizer(config);
    this.initDOM();
  }

  public getVirtualizer(): DeckVirtualizer {
    return this.virtualizer;
  }

  private initDOM(): void {
    this.container.innerHTML = '';

    // Root viewport container (horizontally scrollable)
    const root = document.createElement('div');
    root.className = 'hoist-deck-root';
    root.style.cssText = `
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
    `;

    // Horizontal track containing spacers and mounted columns
    const track = document.createElement('div');
    track.className = 'hoist-deck-track';
    track.style.cssText = `
      display: flex;
      flex-direction: row;
      height: 100%;
      position: relative;
      align-items: stretch;
      padding: 12px 16px;
      gap: 16px;
      box-sizing: border-box;
    `;

    // Spacers for horizontal virtualization
    this.spacerStart = document.createElement('div');
    this.spacerStart.className = 'hoist-spacer-start';
    this.spacerStart.style.cssText = 'flex-shrink: 0; width: 0px;';

    this.spacerEnd = document.createElement('div');
    this.spacerEnd.className = 'hoist-spacer-end';
    this.spacerEnd.style.cssText = 'flex-shrink: 0; width: 0px;';

    track.appendChild(this.spacerStart);
    track.appendChild(this.spacerEnd);
    root.appendChild(track);
    this.container.appendChild(root);

    this.rootElement = root;
    this.horizontalTrack = track;

    // Listen to horizontal scroll
    root.addEventListener('scroll', () => {
      this.virtualizer.setScrollLeft(root.scrollLeft);
      this.render();
    }, { passive: true });

    // Set initial viewport size if available
    if (this.container.clientWidth && this.container.clientHeight) {
      this.virtualizer.setViewport(this.container.clientWidth, this.container.clientHeight);
    }
  }

  public setColumns(columns: DeckColumn[]): void {
    this.virtualizer.setColumns(columns);
    this.render();
  }

  public addColumn(column: DeckColumn): void {
    this.virtualizer.addColumn(column);
    this.render();
  }

  public appendPost(columnId: string, post: DeckPost): void {
    this.virtualizer.appendPost(columnId, post);
    this.renderColumnVertical(columnId);
  }

  /**
   * Main render loop: Updates mounted horizontal columns and vertical card windows.
   */
  public render(): void {
    if (!this.horizontalTrack || !this.spacerStart || !this.spacerEnd) return;

    const hWin = this.virtualizer.getHorizontalWindow();

    // Update horizontal spacers
    this.spacerStart.style.width = `${hWin.offsetStart}px`;
    this.spacerEnd.style.width = `${hWin.offsetEnd}px`;

    const mountedIds = new Set(hWin.mountedColumns.map((c) => c.id));

    // Remove columns that scrolled out of view
    for (const [colId, element] of this.mountedColumnElements.entries()) {
      if (!mountedIds.has(colId)) {
        element.remove();
        this.mountedColumnElements.delete(colId);
        this.onColumnScrollHandlers.delete(colId);
      }
    }

    // Mount / update visible columns (maintaining order before spacerEnd)
    for (const col of hWin.mountedColumns) {
      let colElem = this.mountedColumnElements.get(col.id);
      if (!colElem) {
        colElem = this.createColumnElement(col, hWin.columnWidth);
        this.mountedColumnElements.set(col.id, colElem);
        this.horizontalTrack.insertBefore(colElem, this.spacerEnd);
      }
      this.updateColumnContent(colElem, col);
    }
  }

  private createColumnElement(col: DeckColumn, width: number): HTMLDivElement {
    const colDiv = document.createElement('div');
    colDiv.className = `hoist-column hoist-col-${col.protocol}`;
    colDiv.dataset.columnId = col.id;
    colDiv.style.cssText = `
      width: ${width}px;
      min-width: ${width}px;
      max-width: ${width}px;
      height: 100%;
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      overflow: hidden;
      flex-shrink: 0;
    `;

    // Column Header
    const header = document.createElement('div');
    header.className = 'hoist-col-header';
    header.style.cssText = `
      padding: 10px 14px;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
      user-select: none;
      flex-shrink: 0;
    `;
    header.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
        <span style="font-weight:600; font-size:14px; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">
          ${col.title || col.id}
        </span>
        <span style="font-size:11px; padding:2px 6px; border-radius:4px; background:#3b82f622; color:#60a5fa; text-transform:uppercase; font-weight:700;">
          ${col.protocol}
        </span>
      </div>
      <div style="font-size:12px; color:#94a3b8;">
        ${col.profileId}
      </div>
    `;
    colDiv.appendChild(header);

    // Vertical Scroll Container
    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'hoist-col-scroll';
    scrollContainer.style.cssText = `
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      position: relative;
      display: flex;
      flex-direction: column;
      padding: 8px;
      gap: 12px;
      box-sizing: border-box;
    `;

    const vSpacerStart = document.createElement('div');
    vSpacerStart.className = 'hoist-v-spacer-start';
    vSpacerStart.style.cssText = 'flex-shrink: 0; height: 0px;';

    const cardsContainer = document.createElement('div');
    cardsContainer.className = 'hoist-cards-container';
    cardsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 10px;';

    const vSpacerEnd = document.createElement('div');
    vSpacerEnd.className = 'hoist-v-spacer-end';
    vSpacerEnd.style.cssText = 'flex-shrink: 0; height: 0px;';

    scrollContainer.appendChild(vSpacerStart);
    scrollContainer.appendChild(cardsContainer);
    scrollContainer.appendChild(vSpacerEnd);
    colDiv.appendChild(scrollContainer);

    // Scroll listener for vertical virtualization
    const scrollHandler = () => {
      this.virtualizer.setColumnScrollTop(col.id, scrollContainer.scrollTop);
      this.renderColumnVertical(col.id);
    };
    scrollContainer.addEventListener('scroll', scrollHandler, { passive: true });
    this.onColumnScrollHandlers.set(col.id, scrollHandler);

    return colDiv;
  }

  private updateColumnContent(colElem: HTMLDivElement, col: DeckColumn): void {
    this.renderColumnVertical(col.id);
  }

  private renderColumnVertical(columnId: string): void {
    const colElem = this.mountedColumnElements.get(columnId);
    if (!colElem) return;

    const vWin = this.virtualizer.getVerticalWindow(columnId);
    const vSpacerStart = colElem.querySelector('.hoist-v-spacer-start') as HTMLDivElement;
    const vSpacerEnd = colElem.querySelector('.hoist-v-spacer-end') as HTMLDivElement;
    const cardsContainer = colElem.querySelector('.hoist-cards-container') as HTMLDivElement;

    if (!vSpacerStart || !vSpacerEnd || !cardsContainer) return;

    vSpacerStart.style.height = `${vWin.offsetStart}px`;
    vSpacerEnd.style.height = `${vWin.offsetEnd}px`;

    // Render mounted post cards
    cardsContainer.innerHTML = '';
    for (const post of vWin.mountedPosts) {
      cardsContainer.appendChild(this.createPostCardElement(post));
    }
  }

  /**
   * Generates a zero-CLS post card element with pre-allocated BlurHash bounding boxes.
   */
  private createPostCardElement(post: DeckPost): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'hoist-post-card';
    card.style.cssText = `
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-sizing: border-box;
      word-break: break-word;
    `;

    const layout = calculateCardLayout(post, 360);

    // Header: Author & Timestamp
    const header = document.createElement('div');
    header.style.cssText = 'display: flex; justify-content: space-between; font-size: 13px; align-items: baseline;';
    header.innerHTML = `
      <div style="display:flex; gap:6px; align-items:center;">
        <strong style="color:#f8fafc;">${post.author.name}</strong>
        <span style="color:#94a3b8; font-size:12px;">${post.author.handle}</span>
      </div>
      <span style="color:#64748b; font-size:11px;">${new Date(post.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    `;
    card.appendChild(header);

    // Content Text
    const body = document.createElement('div');
    body.style.cssText = 'font-size: 13px; line-height: 1.45; color: #cbd5e1;';
    body.textContent = post.content;
    card.appendChild(body);

    // Zero-CLS Media Container with BlurHash Aspect-Ratio Bounding Box
    if (post.media && post.media.length > 0) {
      const media = post.media[0];
      const mediaBox = document.createElement('div');
      mediaBox.className = 'hoist-media-airlock-slot';
      mediaBox.style.cssText = `
        width: 100%;
        aspect-ratio: ${layout.mediaAspectRatio || '16 / 9'};
        background: ${layout.placeholderBg || '#0f172a'};
        border-radius: 4px;
        overflow: hidden;
        position: relative;
        contain: size layout paint;
      `;

      const img = document.createElement('img');
      img.src = media.previewUrl || media.url;
      img.alt = media.altText || 'Media attachment';
      img.loading = 'lazy';
      img.style.cssText = `
        width: 100%;
        height: 100%;
        object-fit: cover;
        position: absolute;
        top: 0;
        left: 0;
        opacity: 0;
        transition: opacity 0.15s ease-in;
      `;
      img.onload = () => { img.style.opacity = '1'; };
      mediaBox.appendChild(img);
      card.appendChild(mediaBox);
    }

    return card;
  }

  public destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.mountedColumnElements.clear();
    this.onColumnScrollHandlers.clear();
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}
