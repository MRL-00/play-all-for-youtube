/**
 * Play All for YouTube — service worker.
 *
 * Two jobs:
 *  1. Alt+P forwards "play all" to the active tab.
 *  2. Resolve the channel's newest upload id, so the playlist URL can start
 *     playback immediately instead of landing on a playlist page.
 */

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const VIDEO_ID_RE = /<yt:videoId>([\w-]{11})<\/yt:videoId>/g;

const cache = new Map(); // channelId -> { videoId, at }
const TTL = 10 * 60 * 1000;

async function newestUpload(channelId) {
  const cached = cache.get(channelId);
  if (cached && Date.now() - cached.at < TTL) return cached.videoId;

  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`RSS ${response.status}`);

  const xml = await response.text();
  const matches = [...xml.matchAll(VIDEO_ID_RE)].map((match) => match[1]);
  const videoId = matches[0] || null;

  cache.set(channelId, { videoId, at: Date.now() });
  return videoId;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'ytpa:newest') return undefined;

  const channelId = message.channelId;
  if (!CHANNEL_ID_RE.test(channelId || '')) {
    sendResponse({ videoId: null });
    return undefined;
  }

  newestUpload(channelId)
    .then((videoId) => sendResponse({ videoId }))
    .catch(() => sendResponse({ videoId: null }));

  return true; // async response
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'play-all') return;

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'ytpa:play-all' }, () => {
      void chrome.runtime.lastError; // no content script on this page
    });
  });
});
