#!/usr/bin/env node
/**
 * Offline-ish tests for Play All for YouTube.
 *
 *   node test/run-tests.js [--refresh]
 *
 * Downloads a real channel page (cached in test/fixtures), then runs
 * main-world.js and content/content.js inside a VM sandbox wired to each other
 * the same way the browser wires them. Asserts that:
 *   - the channel id is read out of YouTube's real payload
 *   - the first video is read out of YouTube's real payload
 *   - clicking the button navigates to the channel's UU… uploads playlist
 *   - non-channel pages never get a button
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

const CHANNEL_URL = 'https://www.youtube.com/@MrSuicideSheep/videos';
const EXPECTED_CHANNEL_ID = 'UC5nc_ZtjKW1htCVZVRxlQAQ';
const EXPECTED_LIST_ID = 'UU5nc_ZtjKW1htCVZVRxlQAQ';

const refresh = process.argv.includes('--refresh');
let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message.split('\n')[0]}`);
  }
}

/* ---------------- fixture ---------------- */

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'user-agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'accept-language': 'en-GB,en;q=0.9',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve(body));
        },
      )
      .on('error', reject);
  });
}

async function channelFixture() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const file = path.join(FIXTURES, 'channel-videos.html');
  if (!refresh && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const html = await fetchText(CHANNEL_URL);
  fs.writeFileSync(file, html);
  return html;
}

/** YouTube ships ytInitialData either as JSON in a <script type="application/json">
 *  or as a `var ytInitialData = {...}` assignment. Handle both. */
function extractInitialData(html) {
  const looksRight = (value) =>
    value && value.contents && (value.contents.twoColumnBrowseResultsRenderer || value.contents.singleColumnBrowseResultsRenderer);

  const scripts = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)];
  for (const [, body] of scripts) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      continue;
    }
    if (looksRight(parsed)) return parsed;
  }

  const assignment = /(?:var\s+ytInitialData|window\[['"]ytInitialData['"]\])\s*=\s*/.exec(html);
  if (!assignment) throw new Error('no ytInitialData assignment found in fixture');

  const start = html.indexOf('{', assignment.index + assignment[0].length);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const parsed = JSON.parse(html.slice(start, i + 1));
        if (looksRight(parsed)) return parsed;
        throw new Error('ytInitialData JSON did not look like a browse response');
      }
    }
  }

  throw new Error('unterminated ytInitialData JSON');
}

/* ---------------- DOM / chrome stubs ---------------- */

function selectorMatches(el, selector) {
  return selector
    .split(',')
    .map((part) => part.trim().split(/\s+/).pop()) // last token of descendant selectors
    .some((token) => {
      const attribute = token.match(/\[class\*=["']?([^"'\]]+)["']?\]/);
      if (attribute) return String(el.className || '').includes(attribute[1]);

      const tag = (token.match(/^[a-zA-Z][\w-]*/) || [])[0];
      const id = (token.match(/#([\w-]+)/) || [])[1];
      const classes = [...token.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
      if (tag && el.tagName !== tag.toUpperCase()) return false;
      if (id && el.id !== id) return false;
      return classes.every((name) => el.classList.contains(name));
    });
}

function descendants(el, out = []) {
  for (const child of el.children) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

function makeElement(tag, registry = Object.create(null)) {
  const el = {
    tagName: String(tag).toUpperCase(),
    _id: '',
    className: '',
    title: '',
    type: '',
    innerHTML: '',
    textContent: '',
    dataset: {},
    style: {},
    children: [],
    listeners: {},
    parentElement: null,
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    appendChild(child) {
      if (child.parentElement && child.parentElement !== this) child.remove();
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        this.parentElement = null;
      }
      if (this.id && registry[this.id] === this) delete registry[this.id];
    },
    querySelector(selector) {
      return descendants(this).find((child) => selectorMatches(child, selector)) || null;
    },
    querySelectorAll(selector) {
      return descendants(this).filter((child) => selectorMatches(child, selector));
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute(name) {
      return this[name] ?? null;
    },
    removeAttribute(name) {
      delete this[name];
    },
    hasAttribute(name) {
      return this[name] != null;
    },
    getBoundingClientRect() {
      return { height: this.tagName === 'BUTTON' ? 40 : 24, width: 96, x: 0, y: 0, top: 0, left: 0 };
    },
    click() {
      (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} }));
    },
  };

  Object.defineProperty(el, 'id', {
    get() {
      return this._id || '';
    },
    set(value) {
      this._id = value;
      if (value) registry[value] = this;
    },
  });

  Object.defineProperty(el, 'classList', {
    value: {
      add: (...names) => {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => set.add(name));
        el.className = [...set].join(' ');
      },
      remove: (...names) => {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => set.delete(name));
        el.className = [...set].join(' ');
      },
      contains: (name) => el.className.split(/\s+/).includes(name),
    },
  });

  return el;
}

function makeWorld({
  pathname = '/@MrSuicideSheep/videos',
  initialData = null,
  anchors = [],
  pageHeader = false,
  chipBar = false,
} = {}) {
  const registry = Object.create(null);
  const body = makeElement('body', registry);
  const posted = [];
  const listeners = { message: [] };
  const navigation = [];

  // A channel header shaped like the real one: #page-header > yt-flexible-actions-view-model > div > button
  let actionsHost = null;
  let header = null;
  if (pageHeader) {
    header = makeElement('div', registry);
    header.id = 'page-header';
    actionsHost = makeElement('yt-flexible-actions-view-model', registry);
    const action = makeElement('div', registry);
    action.appendChild(makeElement('button', registry));
    actionsHost.appendChild(action);
    header.appendChild(actionsHost);
    body.appendChild(header);
  }

  // <chip-bar-view-model><div class="…ChipBarScrollContainer"> Latest / Popular / Oldest
  let chipRow = null;
  if (chipBar) {
    const bar = makeElement('chip-bar-view-model', registry);
    chipRow = makeElement('div', registry);
    chipRow.className = 'ytChipBarViewModelChipBarScrollContainer';
    for (const name of ['Latest', 'Popular', 'Oldest']) {
      const wrapper = makeElement('div', registry);
      wrapper.className = 'ytChipBarViewModelChipWrapper';
      wrapper.dataset.label = name;
      wrapper.appendChild(makeElement('button', registry));
      chipRow.appendChild(wrapper);
    }
    bar.appendChild(chipRow);
    body.appendChild(bar);
  }

  const document = {
    readyState: 'complete',
    title: 'MrSuicideSheep - YouTube',
    body,
    documentElement: { dataset: {} },
    head: makeElement('head', registry),
    getElementById: (id) => registry[id] || null,
    createElement: (tag) => makeElement(tag, registry),
    querySelector: (selector) => (selector.includes('/watch') ? anchors[0] || null : body.querySelector(selector)),
    querySelectorAll: (selector) => (selector.includes('/watch') ? anchors : body.querySelectorAll(selector)),
    addEventListener() {},
    removeEventListener() {},
  };

  const win = {
    location: {
      pathname,
      origin: 'https://www.youtube.com',
      assign(url) {
        navigation.push(url);
      },
    },
    document,
    ytInitialData: initialData,
    ytInitialPlayerResponse: undefined,
    open(url) {
      navigation.push(url);
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((candidate) => candidate !== fn);
    },
    setTimeout,
    clearTimeout,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    chrome: {
      storage: {
        sync: { get: (defaults, cb) => cb(defaults) },
        onChanged: { addListener() {} },
      },
      runtime: {
        lastError: null,
        sendMessage: (message, cb) => {
          const response = message && message.type === 'ytpa:newest' ? { videoId: 'fLWozf8QY_A' } : { ok: true };
          if (cb) cb(response);
          return Promise.resolve(response);
        },
        onMessage: { addListener() {} },
      },
    },
  };
  win.window = win;
  win.globalThis = win;
  win.console = console;
  win.__posted = posted;
  win.__listeners = listeners;
  win.__errors = [];

  // One context for both scripts. In the browser they live in separate worlds,
  // but the world boundary is not what's under test — the message protocol is.
  // Dispatch happens *inside* the context so `event.source === window` holds.
  const context = vm.createContext(win);

  win.postMessage = vm.runInContext(
    `(message) => {
       window.__posted.push(message);
       const list = (window.__listeners.message || []).slice();
       for (const fn of list) {
         try { fn({ source: window, data: message }); } catch (error) { window.__errors.push(String(error)); }
       }
     }`,
    context,
  );

  for (const file of ['main-world.js', path.join('content', 'content.js')]) {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file }).runInContext(context);
  }

  return { win, document, registry, navigation, posted, errors: win.__errors, actionsHost, header, chipRow };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/* ---------------- tests ---------------- */

(async () => {
  const html = await channelFixture();
  const initialData = extractInitialData(html);

  console.log('main-world data extraction');
  const world = makeWorld({ initialData });

  const request = { source: 'yt-play-all', type: 'request', requestId: 'test-1' };
  world.win.postMessage(request);
  const response = world.posted.find((m) => m.type === 'data' && m.requestId === 'test-1');

  test('answers the request', () => {
    assert.ok(response, 'no reply posted');
  });
  test('reads the channel id from real payload', () => {
    assert.equal(response.payload.channelId, EXPECTED_CHANNEL_ID);
  });
  test('reads a video id from real payload', () => {
    assert.match(response.payload.videoId || '', /^[\w-]{11}$/);
  });
  test('reads the channel name', () => {
    assert.equal(response.payload.channelName, 'MrSuicideSheep');
  });

  console.log('\nbutton + navigation');
  const button = world.document.getElementById('ytpa-play-all');
  test('button is injected on a channel page', () => {
    assert.ok(button, 'no #ytpa-play-all in body');
  });
  test('button is labelled "Play all"', () => {
    assert.match(button.innerHTML, /Play all/);
  });

  // Wait out the 250ms debounce + bridge round trip, then click.
  await new Promise((resolve) => setTimeout(resolve, 900));
  test('button survived the refresh cycle', () => {
    assert.ok(world.document.getElementById('ytpa-play-all'));
  });

  button.click();
  await waitFor(() => world.navigation.length > 0, 2000);

  test('click navigates to the uploads playlist', () => {
    assert.equal(world.navigation[0], `https://www.youtube.com/watch?v=fLWozf8QY_A&list=${EXPECTED_LIST_ID}&index=1`);
  });

  console.log('\nplacement');
  const chipWorld = makeWorld({ initialData, pageHeader: true, chipBar: true });
  const chipButton = chipWorld.document.getElementById('ytpa-play-all');

  test('button prefers the sort chip row', () => {
    assert.ok(chipButton, 'no button');
    assert.equal(chipButton.parentElement, chipWorld.chipRow);
  });
  test('button lands after the last chip', () => {
    const kids = chipWorld.chipRow.children;
    assert.equal(kids[kids.length - 1], chipButton);
  });
  test('button uses the chip variant, not inline or floating', () => {
    assert.ok(chipButton.classList.contains('ytpa-btn--chip'));
    assert.ok(!chipButton.classList.contains('ytpa-btn--inline'));
    assert.ok(!chipButton.classList.contains('ytpa-btn--floating'));
  });

  const inlineWorld = makeWorld({ initialData, pageHeader: true });
  const inlineButton = inlineWorld.document.getElementById('ytpa-play-all');

  test('button is created before any async work', () => {
    assert.ok(inlineButton, 'no button');
  });
  test('falls back to the header action row without a chip bar', () => {
    let node = inlineButton.parentElement;
    while (node && node !== inlineWorld.actionsHost) node = node.parentElement;
    assert.equal(node, inlineWorld.actionsHost);
  });
  test('header variant is not the chip or floating one', () => {
    assert.ok(inlineButton.classList.contains('ytpa-btn--inline'));
    assert.ok(!inlineButton.classList.contains('ytpa-btn--chip'));
    assert.ok(!inlineButton.classList.contains('ytpa-btn--floating'));
  });
  test('button height follows the neighbouring button', () => {
    assert.equal(inlineButton.style.height, '40px');
  });

  const floatingWorld = makeWorld({ initialData });
  const floatingButton = floatingWorld.document.getElementById('ytpa-play-all');
  test('falls back to the floating pill without any row', () => {
    assert.ok(floatingButton);
    assert.equal(floatingButton.parentElement, floatingWorld.document.body);
    assert.ok(floatingButton.classList.contains('ytpa-btn--floating'));
  });

  console.log('\nnon-channel pages');
  const watchWorld = makeWorld({ pathname: '/watch', initialData });
  test('no button on a watch page', () => {
    assert.equal(watchWorld.document.getElementById('ytpa-play-all'), null);
  });
  const homeWorld = makeWorld({ pathname: '/' });
  test('no button on the YouTube home page', () => {
    assert.equal(homeWorld.document.getElementById('ytpa-play-all'), null);
  });

  console.log(`\n${failures === 0 ? 'all tests passed' : `${failures} test(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
