'use strict';

const statusText = document.getElementById('statusText');
const playBtn = document.getElementById('playBtn');
const enabledBox = document.getElementById('enabled');

let activeTabId = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function show(text, { offerPlay = false } = {}) {
  statusText.innerHTML = text;
  playBtn.hidden = !offerPlay;
}

chrome.storage.sync.get({ enabled: true }, ({ enabled }) => {
  enabledBox.checked = enabled !== false;
});

enabledBox.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: enabledBox.checked });
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (!tab || !/^https:\/\/www\.youtube\.com\//.test(tab.url || '')) {
    show('Open a YouTube channel page to use this.');
    return;
  }

  activeTabId = tab.id;

  chrome.tabs.sendMessage(tab.id, { type: 'ytpa:status' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      show('Reload the YouTube tab to activate the button.');
      return;
    }

    if (!response.isChannelPage) {
      show('Not a channel page. Open a channel, then hit <strong>Play all</strong>.');
      return;
    }

    if (response.channelName) {
      show(`<strong>${escapeHtml(response.channelName)}</strong> — play every upload.`, { offerPlay: true });
    } else {
      show('Channel detected — play every upload.', { offerPlay: true });
    }
  });
});

playBtn.addEventListener('click', () => {
  if (activeTabId == null) return;
  playBtn.disabled = true;
  playBtn.textContent = 'Starting…';
  chrome.tabs.sendMessage(activeTabId, { type: 'ytpa:play-all' }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
});
