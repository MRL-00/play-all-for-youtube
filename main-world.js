/**
 * Main-world bridge.
 *
 * YouTube keeps its page payload inside the page's JS context, which a normal
 * content script (isolated world) cannot read. This script runs in the page's
 * own world, answers "what channel / what video am I looking at?" requests, and
 * nothing else. It never touches the DOM or the network.
 */
(() => {
  'use strict';

  const SOURCE = 'yt-play-all';
  const CHANNEL_ID = /^UC[\w-]{22}$/;
  const VIDEO_ID = /^[\w-]{11}$/;

  /** Pull the current page payload, preferring live Polymer data over the stale
   *  ytInitialData snapshot (which is not replaced on SPA navigation). */
  function pageData() {
    const candidates = [];

    const collect = (value) => {
      if (value && typeof value === 'object') candidates.push(value);
    };

    try {
      const app = document.querySelector('ytd-app');
      collect(app && app.data && app.data.response);
    } catch (_) {
      /* ignore */
    }
    try {
      const browse = document.querySelector('ytd-browse');
      collect(browse && browse.data);
    } catch (_) {
      /* ignore */
    }
    try {
      collect(window.ytInitialData);
    } catch (_) {
      /* ignore */
    }
    try {
      collect(window.ytInitialPlayerResponse);
    } catch (_) {
      /* ignore */
    }

    return candidates;
  }

  function fromKey(data, keys) {
    let value = data;
    for (const key of keys) {
      if (!value || typeof value !== 'object') return undefined;
      value = value[key];
    }
    return value;
  }

  function channelIdFrom(data) {
    const paths = [
      ['metadata', 'channelMetadataRenderer', 'externalId'],
      ['header', 'c4TabbedHeaderRenderer', 'channelId'],
      ['header', 'pageHeaderRenderer', 'pageHeaderViewModel', 'metadata', 'contentMetadataViewModel', 'channelId'],
      ['videoDetails', 'channelId'],
      ['response', 'metadata', 'channelMetadataRenderer', 'externalId'],
    ];

    for (const path of paths) {
      const value = fromKey(data, path);
      if (CHANNEL_ID.test(value || '')) return value;
    }

    const tabs = fromKey(data, ['contents', 'twoColumnBrowseResultsRenderer', 'tabs']);
    if (Array.isArray(tabs)) {
      for (const tab of tabs) {
        const id = tab && tab.tabRenderer && tab.tabRenderer.endpoint
          && tab.tabRenderer.endpoint.browseEndpoint
          && tab.tabRenderer.endpoint.browseEndpoint.browseId;
        if (CHANNEL_ID.test(id || '')) return id;
      }
    }

    return null;
  }

  function channelNameFrom(data) {
    const names = [
      ['metadata', 'channelMetadataRenderer', 'title'],
      ['header', 'c4TabbedHeaderRenderer', 'title'],
      ['videoDetails', 'author'],
      ['response', 'metadata', 'channelMetadataRenderer', 'title'],
    ];

    for (const path of names) {
      const value = fromKey(data, path);
      if (typeof value === 'string' && value.trim()) return value.trim();
    }

    return null;
  }

  /** First real video on the page, in DOM/display order. Skips shorts lockups,
   *  playlist lockups and shelf promos so the playlist starts on an upload. */
  function firstVideoIdFrom(data, depth = 0) {
    if (!data || typeof data !== 'object' || depth > 40) return null;

    if (Array.isArray(data)) {
      for (const item of data) {
        const found = firstVideoIdFrom(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const lockup = data.lockupViewModel;
    if (lockup && typeof lockup === 'object') {
      const type = lockup.contentType;
      if ((!type || type === 'LOCKUP_CONTENT_TYPE_VIDEO') && VIDEO_ID.test(lockup.contentId || '')) {
        return lockup.contentId;
      }
      return null;
    }

    const video = data.videoRenderer;
    if (video && VIDEO_ID.test(video.videoId || '')) return video.videoId;

    const gridVideo = data.gridVideoRenderer;
    if (gridVideo && VIDEO_ID.test(gridVideo.videoId || '')) return gridVideo.videoId;

    for (const key of Object.keys(data)) {
      const found = firstVideoIdFrom(data[key], depth + 1);
      if (found) return found;
    }

    return null;
  }

  function collect() {
    const sources = pageData();
    let channelId = null;
    let channelName = null;
    let videoId = null;

    for (const source of sources) {
      if (!channelId) channelId = channelIdFrom(source);
      if (!channelName) channelName = channelNameFrom(source);
      if (!videoId) videoId = firstVideoIdFrom(source);
      if (channelId && videoId) break;
    }

    return { channelId, channelName, videoId };
  }

  function reply(requestId) {
    let payload = {};
    try {
      payload = collect();
    } catch (error) {
      payload = { error: String(error) };
    }
    window.postMessage({ source: SOURCE, type: 'data', requestId, payload }, window.location.origin);
  }

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== SOURCE || data.type !== 'request') return;
      reply(data.requestId);
    },
    false,
  );
})();
