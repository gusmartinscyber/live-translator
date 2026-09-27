const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function rules() {
  const context = vm.createContext({ URL });
  vm.runInContext(source('site-rules.js'), context);
  return context.LiveTranslatorSites;
}

test('host rules match the site and www, but not sibling subdomains', () => {
  const sites = rules();
  assert.equal(sites.hostFromUrl('https://www.Example.com/post'), 'example.com');
  assert.equal(sites.hostFromUrl('chrome://extensions'), '');
  assert.equal(sites.isIgnored('www.example.com', ['example.com']), true);
  assert.equal(sites.isIgnored('blog.example.com', ['example.com']), false);
  assert.deepEqual(Array.from(sites.normalizeList(['WWW.Example.com', 'example.com'])), ['example.com']);
});

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.children = [];
    this.attrs = {};
    this.isConnected = true;
    this.innerText = '';
    this.textContent = '';
    const names = new Set();
    this.classList = {
      add: (name) => names.add(name),
      remove: (name) => names.delete(name),
      contains: (name) => names.has(name) || (this.className || '').split(/\s+/).includes(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !names.has(name) : force;
        if (enabled) names.add(name); else names.delete(name);
        return enabled;
      }
    };
  }

  getAttribute(name) { return this.attrs[name] || null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  matches(selector) { return this.tagName === 'TWEET' && selector === '[data-testid="tweetText"]'; }
  closest(selector) { return this.matches(selector) ? this : null; }
  querySelectorAll() { return []; }
  querySelector(selector) {
    if (selector === '.lt-original-toggle') {
      return this.children.flatMap((child) => child.children || []).find((child) => child.className === 'lt-original-toggle') || null;
    }
    return null;
  }
  getBoundingClientRect() { return { width: 300, height: 40, top: 0, bottom: 40 }; }
  append(...children) { this.children.push(...children); }
  addEventListener() {}
  insertAdjacentElement(position, sibling) {
    assert.equal(position, 'afterend');
    this.nextElementSibling = sibling;
    sibling.previousElementSibling = this;
  }
  remove() {
    if (this.previousElementSibling) this.previousElementSibling.nextElementSibling = null;
    this.isConnected = false;
  }
}

async function contentHarness() {
  const tweet = new FakeElement('tweet');
  tweet.innerText = 'A useful post in English with a link.';
  tweet.attrs.lang = 'en';
  const storage = { enabled: true, provider: 'google', ignoredHosts: [] };
  const pending = [];
  let storageListener;
  let messageListener;
  const document = {
    body: {}, documentElement: {}, hidden: false,
    querySelectorAll: (selector) => selector === '[data-testid="tweetText"]' ? [tweet] : [],
    querySelector: () => null,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: text })
  };
  const context = vm.createContext({
    URL, document, HTMLElement: FakeElement, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    location: { hostname: 'www.x.com', href: 'https://www.x.com/home' },
    innerHeight: 800, self: {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    IntersectionObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    console: { warn() {}, error(error) { throw error; } },
    chrome: {
      storage: {
        sync: { get: async (defaults) => ({ ...defaults, ...storage }) },
        onChanged: { addListener: (fn) => { storageListener = fn; } }
      },
      i18n: { detectLanguage: async () => ({ isReliable: true, languages: [{ language: 'en' }] }) },
      runtime: {
        sendMessage: () => new Promise((resolve) => pending.push(resolve)),
        onMessage: { addListener: (fn) => { messageListener = fn; } }
      }
    }
  });
  vm.runInContext(source('site-rules.js'), context);
  vm.runInContext(source('content.js'), context);
  for (let i = 0; i < 8; i += 1) await tick();
  return {
    tweet, pending,
    setIgnored(list) {
      storage.ignoredHosts = list;
      storageListener({ ignoredHosts: { newValue: list } }, 'sync');
    },
    status() {
      let result;
      messageListener({ type: 'LT_STATUS' }, {}, (value) => { result = value; });
      return result;
    }
  };
}

test('ignoring removes translations, discards a pending result, and restoring resumes', async () => {
  const app = await contentHarness();
  assert.equal(app.pending.length, 1);
  assert.equal(app.status().siteIgnored, false);

  app.setIgnored(['x.com']);
  assert.equal(app.status().siteIgnored, true);
  app.pending.shift()({ ok: true, translated: 'Tradução antiga', provider: 'google', detectedSource: 'en' });
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(app.tweet.nextElementSibling ?? null, null);
  assert.equal(app.tweet.classList.contains('lt-original-collapsed'), false);

  app.setIgnored([]);
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(app.status().siteIgnored, false);
  assert.equal(app.pending.length, 1);
  app.pending.shift()({ ok: true, translated: 'Postagem útil', provider: 'google', detectedSource: 'en' });
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(app.tweet.nextElementSibling?.className, 'lt-translation-wrap');
  assert.equal(app.tweet.classList.contains('lt-original-collapsed'), true);

  app.setIgnored(['x.com']);
  assert.equal(app.tweet.nextElementSibling ?? null, null);
  assert.equal(app.tweet.classList.contains('lt-original-collapsed'), false);
});

test('the background rejects Google translation for an ignored sender host', async () => {
  const storage = { ignoredHosts: ['example.com'] };
  let listener;
  let requests = 0;
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    chrome: {
      storage: { sync: { get: async () => storage } },
      runtime: { onMessage: { addListener: (fn) => { listener = fn; } } }
    },
    fetch: async () => {
      requests += 1;
      return { ok: true, json: async () => [[['Olá', 'Hello']], null, 'en'] };
    }
  });
  context.importScripts = (filename) => vm.runInContext(source(filename), context);
  vm.runInContext(source('background.js'), context);
  const translate = (url) => new Promise((resolve) => {
    listener({ type: 'LT_GOOGLE_TRANSLATE', text: 'Hello', sourceLanguage: 'en' }, { url }, resolve);
  });

  const blocked = await translate('https://www.example.com/feed');
  assert.equal(blocked.ok, false);
  assert.equal(requests, 0);

  storage.ignoredHosts = [];
  const allowed = await translate('https://www.example.com/feed');
  assert.equal(allowed.ok, true);
  assert.equal(allowed.translated, 'Olá');
  assert.equal(requests, 1);
});

test('the popup saves an ignored host and offers a one-click reversal', async () => {
  class Control {
    constructor() { this.children = []; this.listeners = {}; this.textContent = ''; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    click() { return this.listeners.click?.(); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
  }

  const controls = new Map();
  for (const id of ['enabled', 'displayMode', 'translateNonEnglish', 'provider', 'scope', 'rescan', 'status', 'currentHost', 'toggleSite', 'ignoredSites']) {
    controls.set(id, new Control());
  }
  const storage = { ignoredHosts: [] };
  let storageListener;
  const context = vm.createContext({
    URL, setInterval: () => 1, setTimeout: () => 1,
    document: {
      getElementById: (id) => controls.get(id),
      createElement: () => new Control()
    },
    chrome: {
      tabs: {
        query: async () => [{ id: 7, url: 'https://www.example.com/feed' }],
        sendMessage: async () => ({ enabled: true, scopeAllowsPage: true, siteIgnored: storage.ignoredHosts.includes('example.com') })
      },
      storage: {
        sync: {
          get: async (defaults) => ({ ...defaults, ...storage }),
          set: async (changes) => {
            Object.assign(storage, changes);
            storageListener?.({ ignoredHosts: { newValue: storage.ignoredHosts } }, 'sync');
          }
        },
        onChanged: { addListener: (fn) => { storageListener = fn; } }
      }
    }
  });
  vm.runInContext(source('site-rules.js'), context);
  vm.runInContext(source('popup.js'), context);
  for (let i = 0; i < 4; i += 1) await tick();

  assert.equal(controls.get('currentHost').textContent, 'example.com');
  assert.equal(controls.get('toggleSite').textContent, 'Ignorar este site');
  await controls.get('toggleSite').click();
  assert.deepEqual(Array.from(storage.ignoredHosts), ['example.com']);
  assert.equal(controls.get('toggleSite').textContent, 'Voltar a traduzir este site');
  assert.match(controls.get('status').textContent, /Site ignorado/);

  await controls.get('toggleSite').click();
  assert.deepEqual(Array.from(storage.ignoredHosts), []);
  assert.equal(controls.get('toggleSite').textContent, 'Ignorar este site');
});
