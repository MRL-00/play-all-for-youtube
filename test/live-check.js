#!/usr/bin/env node
/**
 * Live check: loads the unpacked extension into headless Chrome, opens a real
 * channel page, and asserts the button is injected and wired up.
 *
 *   node test/live-check.js
 *
 * Optional — needs Google Chrome installed. Everything else works offline.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TARGET_URL = 'https://www.youtube.com/@MrSuicideSheep/videos';
const PORT = 9333;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let id = 0;

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    events.push(message);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { send, events, close: () => ws.close() };
}

async function httpJson(url, method = 'GET') {
  const response = await fetch(url, { method });
  return response.json();
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.log(`skipped: Chrome not found at ${CHROME}`);
    return;
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ytpa-profile-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      `--user-data-dir=${profile}`,
      `--load-extension=${ROOT}`,
      `--remote-debugging-port=${PORT}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let chromeStderr = '';
  chrome.stderr.on('data', (chunk) => {
    chromeStderr += chunk.toString();
  });

  try {
    // wait for the debugger
    let version = null;
    for (let i = 0; i < 60 && !version; i += 1) {
      await sleep(250);
      try {
        version = await httpJson(`http://127.0.0.1:${PORT}/json/version`);
      } catch (_) {
        /* not up yet */
      }
    }
    if (!version) throw new Error('Chrome debugger never came up');

    const target = await httpJson(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET_URL)}`, 'PUT');
    const session = await cdp(target.webSocketDebuggerUrl);

    await session.send('Runtime.enable');
    await session.send('Log.enable');
    await session.send('Page.enable');

    // wait for the channel page + content script to settle
    let state = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      const evaluation = await session.send('Runtime.evaluate', {
        expression: `(() => {
          const button = document.querySelector('#ytpa-play-all');
          return JSON.stringify({
            url: location.pathname,
            ready: document.readyState,
            hasButton: Boolean(button),
            label: button ? button.textContent.trim() : null,
            title: button ? button.title : null,
            cssApplied: button ? getComputedStyle(button).position : null,
            inChipRow: Boolean(document.querySelector('chip-bar-view-model #ytpa-play-all, [class*="ChipBarScrollContainer"] #ytpa-play-all')),
            inHeaderRow: Boolean(document.querySelector('#page-header yt-flexible-actions-view-model #ytpa-play-all')),
            variant: button ? (button.className || '').split(' ').filter((c) => c.startsWith('ytpa-btn--')).join(',') : null,
            height: button ? Math.round(button.getBoundingClientRect().height) : null,
            heading: document.querySelector('#page-header h1, ytd-channel-name #text')?.textContent?.trim() || null,
          });
        })()`,
        returnByValue: true,
        awaitPromise: false,
      });
      state = JSON.parse(evaluation.result.value);
      if (state.hasButton) break;
    }

    const errors = session.events
      .filter((event) => event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
      .map((event) => event.params.entry.text)
      .filter((text) => !/ads|doubleclick|consent|ERR_NAME_NOT_RESOLVED/i.test(text));

    console.log('page  :', state.url);
    console.log('ready :', state.ready);
    console.log('heading:', state.heading);
    console.log('button:', state.hasButton ? `"${state.label}"` : 'MISSING');
    console.log('place :', state.inChipRow ? 'in the sort chip row (after Oldest)' : state.inHeaderRow ? 'in the header action row' : `fallback (${state.cssApplied})`);
    console.log('height:', state.height);

    // --- click it for real ---------------------------------------------
    await session.send('Runtime.evaluate', {
      expression: `document.querySelector('#ytpa-play-all').click()`,
    });

    let after = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      const evaluation = await session.send('Runtime.evaluate', {
        expression: `(() => {
          const panel = document.querySelector('#playlist, ytd-playlist-panel-renderer, .ytp-playlist-menu-title');
          return JSON.stringify({
            href: location.href,
            title: document.title,
            playlistHeading: panel ? panel.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : null,
            indexOne: Boolean(document.querySelector('ytd-playlist-panel-video-renderer[selected]')),
          });
        })()`,
        returnByValue: true,
      });
      after = JSON.parse(evaluation.result.value);
      if (after.href.includes('list=UU')) break;
    }

    console.log('\nafter click');
    console.log('url   :', after.href);

    // the watch page keeps loading after the navigation commits; give the
    // playlist panel time to render so we can confirm it's the right one
    for (let i = 0; i < 30 && !after.playlistHeading; i += 1) {
      await sleep(500);
      const evaluation = await session.send('Runtime.evaluate', {
        expression: `(() => {
          const panel = document.querySelector('#playlist, ytd-playlist-panel-renderer');
          return JSON.stringify({
            href: location.href,
            title: document.title,
            playlistHeading: panel ? panel.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : null,
          });
        })()`,
        returnByValue: true,
      });
      const next = JSON.parse(evaluation.result.value);
      after.playlistHeading = next.playlistHeading;
      after.title = next.title || after.title;
    }

    console.log('title :', after.title);
    console.log('panel :', after.playlistHeading);

    session.close();

    const wentToPlaylist = /[?&]list=UU[\w-]{22}/.test(after.href);
    const panelOk = Boolean(after.playlistHeading && /uploads from/i.test(after.playlistHeading));

    if (!state.hasButton) {
      console.log('\nresult: FAIL (button not injected)');
      process.exitCode = 1;
    } else if (!state.inChipRow) {
      console.log('\nresult: FAIL (button did not mount in the sort chip row)');
      process.exitCode = 1;
    } else if (!wentToPlaylist) {
      console.log('\nresult: FAIL (click did not open the uploads playlist)');
      process.exitCode = 1;
    } else if (errors.length) {
      console.log('errors:', errors.slice(0, 5));
      console.log('\nresult: FAIL (page errors)');
      process.exitCode = 1;
    } else {
      console.log(`\nresult: PASS${panelOk ? ' (playlist panel is live)' : ' (playlist URL reached)'}`);
    }
  } finally {
    chrome.kill('SIGKILL');
    await sleep(400);
    for (let i = 0; i < 5; i += 1) {
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
        break;
      } catch (_) {
        await sleep(300);
      }
    }
    if (process.exitCode === 1 && chromeStderr.includes('Extension error')) {
      console.log(chromeStderr.split('\n').filter((line) => /extension/i.test(line)).slice(0, 5).join('\n'));
    }
  }
})().catch((error) => {
  console.error('live check failed:', error.message);
  process.exitCode = 1;
});
