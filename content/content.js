/**
 * Play All for YouTube
 *
 * Adds a floating "Play all" button to channel pages and starts the channel's
 * uploads playlist — the same one YouTube's own removed button used (`UU…`,
 * derived from the channel id `UC…`). Because it plays a real playlist rather
 * than the ~30 videos the page lazily loaded, a 4,000-video channel works.
 */
(() => {
  'use strict';

  const SOURCE = 'yt-play-all';
  const BTN_ID = 'ytpa-play-all';
  const TOAST_ID = 'ytpa-toast';
  const INLINE_HOST_CLASS = 'ytpa-inline-host';

  const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
  const WATCH_RE = /\/watch\?(?:[^#]*&)?v=([\w-]{11})(?:[&#]|$)/;

  const CHANNEL_PATH_RE =
    /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(?:\/(?:videos|streams|featured|shorts|playlists))?\/?$/;

  const state = {
    enabled: true,
    channelId: null,
    channelName: '',
    videoId: null,
    busy: false,
    lastPath: '',
  };

  /* ------------------------------------------------------------------ *
   * Main-world bridge
   * ------------------------------------------------------------------ */

  function askPage(timeout = 600) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let settled = false;

      const onMessage = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== SOURCE || data.type !== 'data' || data.requestId !== requestId) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve(data.payload || {});
      };

      window.addEventListener('message', onMessage);
      window.postMessage({ source: SOURCE, type: 'request', requestId }, window.location.origin);

      setTimeout(() => {
        if (settled) return;
        window.removeEventListener('message', onMessage);
        resolve({});
      }, timeout);
    });
  }

  /* ------------------------------------------------------------------ *
   * DOM readers (work even if the bridge is unavailable)
   * ------------------------------------------------------------------ */

  function isChannelPage() {
    return CHANNEL_PATH_RE.test(window.location.pathname);
  }

  function domChannelId() {
    const fromPath = window.location.pathname.match(/\/channel\/(UC[\w-]{22})/);
    if (fromPath) return fromPath[1];

    const canonical = document.querySelector('link[rel="canonical"]');
    const fromCanonical = canonical && (canonical.href || '').match(/\/channel\/(UC[\w-]{22})/);
    if (fromCanonical) return fromCanonical[1];

    const meta = document.querySelector('meta[itemprop="identifier"]');
    if (meta && CHANNEL_ID_RE.test(meta.content || '')) return meta.content;

    const anchor = document.querySelector(
      '#page-header a[href^="/channel/UC"], ytd-c4-tabbed-header-renderer a[href^="/channel/UC"], a[href^="/channel/UC"]',
    );
    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      const match = href.match(/\/channel\/(UC[\w-]{22})/);
      if (match) return match[1];
    }

    return null;
  }

  function domVideoIds() {
    const seen = new Set();
    const ids = [];
    const roots = [
      document.querySelector('#primary'),
      document.querySelector('ytd-browse'),
      document.querySelector('yt-lockup-view-model'),
      document.querySelector('ytd-section-list-renderer'),
    ].filter(Boolean);

    for (const root of roots.length ? roots : [document]) {
      for (const anchor of root.querySelectorAll('a[href*="/watch"]')) {
        const match = WATCH_RE.exec(anchor.getAttribute('href') || '');
        if (!match) continue;
        if (seen.has(match[1])) continue;
        seen.add(match[1]);
        ids.push(match[1]);
        if (ids.length >= 50) break;
      }
      if (ids.length >= 50) break;
    }

    return ids;
  }

  function domChannelName() {
    const heading = document.querySelector('#page-header h1, ytd-channel-name #text a, ytd-channel-name #text');
    const text = heading && heading.textContent && heading.textContent.trim();
    if (text) return text;
    return (document.title || '').replace(/\s*-\s*YouTube\s*$/, '').trim();
  }

  /* ------------------------------------------------------------------ *
   * Data assembly
   * ------------------------------------------------------------------ */

  async function collect() {
    const page = await askPage();

    // The DOM is the authority on *which* channel the URL points at; the page
    // payload is the authority on the first video (which is not in the DOM yet).
    state.channelId = domChannelId() || (CHANNEL_ID_RE.test(page.channelId || '') ? page.channelId : null);
    state.channelName = domChannelName() || page.channelName || '';
    state.videoId = page.videoId || domVideoIds()[0] || null;

    return state;
  }

  function uploadsPlaylistId(channelId) {
    // Uploads playlist is the channel id with the UC prefix swapped for UU.
    return `UU${channelId.slice(2)}`;
  }

  async function newestUpload(channelId) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ytpa:newest', channelId });
      return (response && response.videoId) || null;
    } catch (_) {
      return null;
    }
  }

  function navigate(url, newTab) {
    if (newTab) window.open(url, '_blank', 'noopener');
    else window.location.assign(url);
  }

  async function playAll({ newTab = false } = {}) {
    if (state.busy) return;
    setBusy(true);

    try {
      const info = await collect();

      if (!info.channelId) {
        // No channel id (odd layout, brand account edge case): fall back to the
        // videos currently in the DOM. Capped at 50 by YouTube's URL format.
        const ids = domVideoIds();
        if (!ids.length) {
          toast('No videos found on this page.');
          return;
        }
        navigate(`https://www.youtube.com/watch_videos?video_ids=${ids.slice(0, 50).join(',')}`, newTab);
        return;
      }

      const listId = uploadsPlaylistId(info.channelId);
      const firstVideo = (await newestUpload(info.channelId)) || info.videoId || domVideoIds()[0] || null;

      const url = firstVideo
        ? `https://www.youtube.com/watch?v=${firstVideo}&list=${listId}&index=1`
        : `https://www.youtube.com/playlist?list=${listId}`;

      navigate(url, newTab);
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  function setBusy(busy) {
    state.busy = busy;
    const button = document.getElementById(BTN_ID);
    if (!button) return;
    button.dataset.busy = busy ? 'true' : 'false';
    const label = button.querySelector('.ytpa-btn__label');
    if (label) label.textContent = busy ? 'Starting…' : 'Play all';
  }

  function removeButton() {
    const button = document.getElementById(BTN_ID);
    if (button) button.remove();
    for (const wrap of document.querySelectorAll(`.${INLINE_HOST_CLASS}`)) {
      if (!wrap.children.length) wrap.remove();
    }
  }

  const CHIP_BAR = 'chip-bar-view-model';
  const CHIP_ROW_SELECTORS = [
    '.ytChipBarViewModelChipBarScrollContainer',
    '[class*="ChipBarScrollContainer"]',
    'yt-chip-cloud-renderer #chips',
    'ytd-feed-filter-chip-bar-renderer #chips',
    'iron-selector#chips',
  ];

  /** The header row that holds Subscribe / Join. New layout renders it as a
   *  flexible-actions view model; older channels still use #buttons. */
  function headerActionHost() {
    const header = document.querySelector('#page-header') || document;

    return (
      header.querySelector('yt-flexible-actions-view-model') ||
      header.querySelector('#buttons') ||
      document.querySelector('ytd-c4-tabbed-header-renderer #buttons') ||
      null
    );
  }

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** The sort chip row (Latest / Popular / Oldest). New layout renders it as a
   *  chip-bar-view-model; older channels use a chip cloud with #chips. */
  function chipRowHost() {
    for (const bar of document.querySelectorAll(CHIP_BAR)) {
      if (!isVisible(bar)) continue;
      for (const selector of CHIP_ROW_SELECTORS) {
        const row = bar.querySelector(selector);
        if (row) return row;
      }
      return bar;
    }

    for (const selector of CHIP_ROW_SELECTORS) {
      const row = document.querySelector(selector);
      if (isVisible(row)) return row;
    }

    return null;
  }

  /** Prefer the sort chip row (next to "Oldest"), then the header action row,
   *  then a floating pill — so the button is always reachable. */
  function place(button) {
    const chipHost = chipRowHost();

    if (chipHost) {
      if (button.parentElement !== chipHost) chipHost.appendChild(button);
      button.removeAttribute('style');
      button.classList.add('ytpa-btn--chip');
      button.classList.remove('ytpa-btn--inline', 'ytpa-btn--floating');
      return;
    }

    const host = headerActionHost();

    if (host) {
      let wrap = host.querySelector(`.${INLINE_HOST_CLASS}`);
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = INLINE_HOST_CLASS;
        host.appendChild(wrap);
      }

      if (button.parentElement !== wrap) wrap.appendChild(button);

      // Match the neighbouring button's height so the row stays on one line.
      const sibling = [...host.querySelectorAll('button')].find((candidate) => candidate.id !== BTN_ID);
      if (sibling) {
        const height = sibling.getBoundingClientRect().height;
        if (height >= 24 && height <= 64) button.style.height = `${Math.round(height)}px`;
      }

      button.classList.add('ytpa-btn--inline');
      button.classList.remove('ytpa-btn--chip', 'ytpa-btn--floating');
      return;
    }

    if (button.parentElement !== document.body) document.body.appendChild(button);
    button.removeAttribute('style');
    button.classList.add('ytpa-btn--floating');
    button.classList.remove('ytpa-btn--chip', 'ytpa-btn--inline');
  }

  function createButton() {
    const button = document.createElement('button');
    button.id = BTN_ID;
    button.type = 'button';
    button.className = 'ytpa-btn';
    button.title = 'Play every upload on this channel (Alt+P). Cmd/Ctrl-click opens it in a new tab.';

    button.innerHTML =
      '<span class="ytpa-btn__icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" focusable="false">' +
      '<path fill="currentColor" d="M8 5.14v13.72L19 12z"></path>' +
      '</svg></span>' +
      '<span class="ytpa-btn__label">Play all</span>';

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      playAll({ newTab: event.metaKey || event.ctrlKey || event.shiftKey });
    });

    return button;
  }

  function ensureButton() {
    if (!state.enabled || !isChannelPage()) {
      removeButton();
      return;
    }

    const existing = document.getElementById(BTN_ID);
    const button = existing || createButton();
    button.dataset.channel = state.channelName || '';
    place(button);
  }

  function toast(message) {
    const existing = document.getElementById(TOAST_ID);
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = TOAST_ID;
    el.className = 'ytpa-toast';
    el.textContent = message;
    document.body.appendChild(el);

    setTimeout(() => el.classList.add('ytpa-toast--out'), 2600);
    setTimeout(() => el.remove(), 3200);
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  let scheduled = null;

  function refresh({ force = false } = {}) {
    const path = window.location.pathname;
    if (path !== state.lastPath) {
      state.lastPath = path;
      state.channelId = null;
      state.videoId = null;
      state.channelName = '';
    }

    if (!isChannelPage()) {
      removeButton();
      return;
    }

    ensureButton();

    if (!state.channelId || force) {
      collect().then(() => ensureButton());
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      refresh();
    }, 250);
  }

  chrome.storage.sync.get({ enabled: true }, (values) => {
    state.enabled = values.enabled !== false;
    refresh({ force: true });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.enabled) return;
    state.enabled = changes.enabled.newValue !== false;
    refresh();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return undefined;

    if (message.type === 'ytpa:play-all') {
      playAll({ newTab: Boolean(message.newTab) });
      sendResponse({ ok: true });
      return undefined;
    }

    if (message.type === 'ytpa:status') {
      collect().then((info) => {
        sendResponse({
          ok: true,
          channelId: info.channelId,
          channelName: info.channelName,
          isChannelPage: isChannelPage(),
          enabled: state.enabled,
        });
      });
      return true;
    }

    return undefined;
  });

  document.addEventListener('yt-navigate-finish', () => schedule());
  window.addEventListener('yt-page-data-updated', () => schedule());
  window.addEventListener('popstate', () => schedule());

  // YouTube swaps huge parts of the DOM when you change tab; keep the button
  // alive without fighting the app (childList only, throttled).
  const observer = new MutationObserver(() => {
    if (!isChannelPage()) return;
    if (!document.getElementById(BTN_ID)) schedule();
  });

  function start() {
    refresh({ force: true });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
