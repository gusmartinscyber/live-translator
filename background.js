importScripts('site-rules.js');

(() => {
  'use strict';

  const cache = new Map();
  const CACHE_LIMIT = 1600;
  const MAX_CHUNK = 900;
  const MAX_CONCURRENT = 2;
  const MIN_START_GAP_MS = 120;
  const ENDPOINTS = [
    'https://translate.googleapis.com/translate_a/single',
    'https://translate.google.com/translate_a/single'
  ];

  const jobs = [];
  let active = 0;
  let lastStart = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ensureSiteAllowed(host) {
    const { ignoredHosts = [] } = await chrome.storage.sync.get({ ignoredHosts: [] });
    if (LiveTranslatorSites.isIgnored(host, ignoredHosts)) {
      throw new Error('Site ignorado');
    }
  }

  function cacheSet(key, value) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function splitText(text) {
    if (text.length <= MAX_CHUNK) return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > MAX_CHUNK) {
      let cut = rest.lastIndexOf('\n\n', MAX_CHUNK);
      if (cut < MAX_CHUNK * 0.45) cut = rest.lastIndexOf('\n', MAX_CHUNK);
      if (cut < MAX_CHUNK * 0.45) cut = rest.lastIndexOf('. ', MAX_CHUNK);
      if (cut < MAX_CHUNK * 0.45) cut = rest.lastIndexOf(' ', MAX_CHUNK);
      if (cut < MAX_CHUNK * 0.45) cut = MAX_CHUNK;
      else if (rest.slice(cut, cut + 2) === '. ') cut += 1;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trimStart();
    }
    if (rest) chunks.push(rest);
    return chunks.filter(Boolean);
  }

  async function fetchWithTimeout(url, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
        headers: { 'Accept': 'application/json,text/plain,*/*' }
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function translateChunk(text, targetLanguage, sourceLanguage = 'auto', host = '') {
    let lastError = null;

    for (const endpoint of ENDPOINTS) {
      const url = new URL(endpoint);
      url.searchParams.set('client', 'gtx');
      url.searchParams.set('sl', sourceLanguage || 'auto');
      url.searchParams.set('tl', targetLanguage || 'pt');
      url.searchParams.set('dt', 't');
      url.searchParams.set('q', text);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await ensureSiteAllowed(host);
          const response = await fetchWithTimeout(url.toString());
          if (!response.ok) {
            if (response.status === 429 || response.status === 408 || response.status >= 500) {
              await sleep(650 * (2 ** attempt));
              continue;
            }
            throw new Error(`Google HTTP ${response.status}`);
          }

          const data = await response.json();
          const translated = Array.isArray(data?.[0])
            ? data[0].map((part) => Array.isArray(part) ? (part[0] || '') : '').join('')
            : '';

          if (!translated.trim()) throw new Error('Resposta de tradução vazia');
          return {
            translated: translated.trim(),
            detectedSource: typeof data?.[2] === 'string' ? data[2] : sourceLanguage
          };
        } catch (error) {
          if (error?.message === 'Site ignorado') throw error;
          lastError = error;
          if (attempt < 3) await sleep(350 * (2 ** attempt));
        }
      }
    }

    throw lastError || new Error('Falha no Google Translate');
  }

  async function googleTranslate(text, targetLanguage, sourceLanguage = 'auto', host = '') {
    await ensureSiteAllowed(host);
    const key = `${sourceLanguage}\u0000${targetLanguage}\u0000${text}`;
    if (cache.has(key)) return cache.get(key);

    const chunks = splitText(text);
    const translatedChunks = [];
    let detectedSource = sourceLanguage;

    for (const chunk of chunks) {
      const result = await translateChunk(chunk, targetLanguage, sourceLanguage, host);
      translatedChunks.push(result.translated);
      if (!detectedSource || detectedSource === 'auto') detectedSource = result.detectedSource || detectedSource;
    }

    const result = {
      ok: true,
      translated: translatedChunks.join('\n\n'),
      detectedSource: detectedSource || 'auto',
      provider: 'google'
    };
    cacheSet(key, result);
    return result;
  }

  function pump() {
    while (active < MAX_CONCURRENT && jobs.length) {
      const job = jobs.shift();
      active += 1;

      (async () => {
        const gap = Math.max(0, MIN_START_GAP_MS - (Date.now() - lastStart));
        if (gap) await sleep(gap);
        lastStart = Date.now();
        return googleTranslate(job.text, job.targetLanguage, job.sourceLanguage, job.host);
      })()
        .then(job.resolve, job.reject)
        .finally(() => {
          active = Math.max(0, active - 1);
          pump();
        });
    }
  }

  function enqueueGoogle(text, targetLanguage, sourceLanguage, host) {
    return new Promise((resolve, reject) => {
      jobs.push({ text, targetLanguage, sourceLanguage, host, resolve, reject });
      pump();
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'LT_GOOGLE_TRANSLATE') return false;

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) {
      sendResponse({ ok: false, error: 'Texto vazio' });
      return false;
    }

    const host = LiveTranslatorSites.hostFromUrl(sender.url || sender.tab?.url || '');
    if (!host) {
      sendResponse({ ok: false, error: 'Origem da página indisponível' });
      return false;
    }
    enqueueGoogle(text, message.targetLanguage || 'pt', message.sourceLanguage || 'auto', host)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || 'Falha de tradução',
        provider: 'google'
      }));
    return true;
  });
})();
