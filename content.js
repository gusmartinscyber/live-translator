(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    targetLanguage: 'pt',
    displayMode: 'translated-only',
    translateNonEnglish: true,
    provider: 'auto',
    scope: 'all',
    ignoredHosts: []
  };

  const SOCIAL_HOSTS = [
    'x.com', 'twitter.com', 'reddit.com', 'www.reddit.com', 'old.reddit.com',
    'threads.net', 'www.threads.net', 'bsky.app', 'facebook.com', 'www.facebook.com',
    'instagram.com', 'www.instagram.com', 'linkedin.com', 'www.linkedin.com'
  ];

  const SUPPORTED_NATIVE = new Set([
    'ar','bg','bn','cs','da','de','el','en','es','fi','fr','he','hi','hr','hu','id','it','ja','kn','ko','lt','mr','nl','no','pl','pt','ro','ru','sk','sl','sv','ta','te','th','tr','uk','vi','zh','zh-Hant'
  ]);

  const state = {
    settings: { ...DEFAULTS },
    queue: [],
    queued: new WeakSet(),
    generation: 0,
    observed: new WeakSet(),
    activeWorkers: 0,
    maxWorkers: 2,
    intersectionObserver: null,
    mutationObserver: null,
    pendingRoots: new Set(),
    scanTimer: null,
    sweepTimer: null,
    url: location.href,
    nativeTranslators: new Map(),
    nativeTranslatorPromises: new Map(),
    cache: new Map(),
    cacheOrder: [],
    cacheLimit: 1200,
    stats: {
      discovered: 0,
      translated: 0,
      skipped: 0,
      transientErrors: 0,
      recovered: 0,
      working: 0
    },
    discovered: new WeakSet(),
    lastProvider: null
  };

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function hostKind() {
    const host = location.hostname.toLowerCase();
    if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) return 'x';
    if (host === 'reddit.com' || host === 'www.reddit.com' || host === 'old.reddit.com' || host.endsWith('.reddit.com')) return 'reddit';
    return 'web';
  }

  function selectorSet() {
    const kind = hostKind();
    if (kind === 'x') {
      return [
        '[data-testid="tweetText"]'
      ];
    }
    if (kind === 'reddit') {
      return [
        'shreddit-post [slot="text-body"]',
        'shreddit-comment [slot="comment"]',
        'shreddit-comment p',
        '[data-testid="post-content"] p',
        '[data-testid="comment"] p',
        '[data-testid="comment"] [dir="auto"]',
        '.usertext-body .md p',
        '.usertext-body .md li',
        '.usertext-body .md blockquote',
        'article p',
        '[role="main"] blockquote'
      ];
    }
    return [
      'article p', 'article blockquote', 'article h1', 'article h2', 'article h3',
      '[role="article"] p', '[role="article"] blockquote', '[role="article"] [dir="auto"]',
      'main p', 'main blockquote', 'main h1', 'main h2', 'main h3',
      '[role="main"] p', '[role="main"] blockquote', '[role="main"] [dir="auto"]'
    ];
  }

  function isPrimaryCandidate(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (hostKind() === 'x') return el.matches('[data-testid="tweetText"]');
    if (hostKind() === 'reddit') {
      return el.matches('shreddit-post [slot="text-body"], shreddit-comment [slot="comment"], [data-testid="post-content"] p, [data-testid="comment"] p, .usertext-body .md p, .usertext-body .md li, .usertext-body .md blockquote');
    }
    return false;
  }

  function normalizeLang(raw) {
    if (!raw) return null;
    const lower = String(raw).trim().toLowerCase();
    if (!lower || lower === 'und' || lower === 'auto') return null;
    if (lower.startsWith('zh-hant') || lower.startsWith('zh-tw') || lower.startsWith('zh-hk')) return 'zh-Hant';
    return lower.split('-')[0];
  }

  function sourceLanguageFor(el) {
    if (!el) return null;
    const direct = normalizeLang(el.getAttribute?.('lang'));
    if (direct) return direct;
    const nested = el.querySelector?.('[lang]');
    const nestedLang = normalizeLang(nested?.getAttribute?.('lang'));
    if (nestedLang) return nestedLang;
    const ancestor = el.closest?.('[lang]');
    return normalizeLang(ancestor?.getAttribute?.('lang'));
  }

  function getText(el) {
    return (el?.innerText || el?.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function cacheKey(source, target, text) {
    return `${source || 'auto'}\u0000${target}\u0000${text}`;
  }

  function cacheGet(key) {
    return state.cache.get(key);
  }

  function cacheSet(key, value) {
    if (state.cache.has(key)) state.cache.delete(key);
    state.cache.set(key, value);
    state.cacheOrder.push(key);
    while (state.cacheOrder.length > state.cacheLimit) {
      const oldest = state.cacheOrder.shift();
      state.cache.delete(oldest);
    }
  }

  function isSocialHost() {
    const host = location.hostname.toLowerCase();
    return SOCIAL_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  }

  function scopeAllowsPage() {
    return state.settings.scope !== 'social' || isSocialHost();
  }

  function siteIgnored() {
    return LiveTranslatorSites.isIgnored(location.hostname, state.settings.ignoredHosts);
  }

  function translationAllowed() {
    return state.settings.enabled && scopeAllowsPage() && !siteIgnored();
  }

  function isExtensionNode(el) {
    return !!el?.closest?.('.lt-translation-wrap, #lt-page-indicator');
  }

  function isIgnored(el) {
    if (!(el instanceof HTMLElement)) return true;
    if (isExtensionNode(el)) return true;
    if (el.matches('script,style,noscript,svg,canvas,code,pre,kbd,samp,input,textarea,select,option,button,[contenteditable="true"]')) return true;
    if (el.closest('script,style,noscript,code,pre,[contenteditable="true"]')) return true;
    return false;
  }

  function isVisibleEnough(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 20 && rect.height >= 4;
  }

  function meaningfulChildDominates(el, text) {
    for (const child of el.children) {
      if (!(child instanceof HTMLElement) || isExtensionNode(child)) continue;
      const childText = getText(child);
      if (childText.length >= Math.max(20, text.length * 0.82)) return true;
    }
    return false;
  }

  function isGoodCandidate(el) {
    if (isIgnored(el)) return false;
    const text = getText(el);
    if (text.length < 2 || text.length > 12000) return false;
    if (!isVisibleEnough(el)) return false;

    // Em feeds sociais os textos quase sempre são compostos por spans filhos.
    // O filtro de dominância da v2 descartava tweets válidos por causa disso.
    if (!isPrimaryCandidate(el) && meaningfulChildDominates(el, text)) return false;

    if (/^[\d\s.,:;!?@#$%^&*()_+\-=\/\\|<>~`]+$/.test(text)) return false;
    return true;
  }

  function translationContainerFor(el) {
    const sibling = el?.nextElementSibling;
    return sibling?.classList?.contains('lt-translation-wrap') ? sibling : null;
  }

  function removeTranslation(el, { preserveAttempts = false } = {}) {
    translationContainerFor(el)?.remove();
    el?.classList?.remove('lt-original-collapsed');
    if (!el?.dataset) return;
    delete el.dataset.ltState;
    delete el.dataset.ltText;
    delete el.dataset.ltSource;
    delete el.dataset.ltNextRetry;
    if (!preserveAttempts) delete el.dataset.ltAttempts;
  }

  function applyDisplayMode(el, wrap) {
    if (!wrap) return;
    const translatedOnly = state.settings.displayMode === 'translated-only';
    const open = wrap.classList.contains('lt-original-open');
    el.classList.toggle('lt-original-collapsed', translatedOnly && !open);
    wrap.classList.toggle('lt-dual-mode', !translatedOnly);
    const button = q('.lt-original-toggle', wrap);
    if (button) button.hidden = !translatedOnly;
  }

  function normalizeInlineText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function originalLinksFor(el) {
    const links = [];
    const seen = new Set();

    for (const anchor of el.querySelectorAll('a[href]')) {
      const href = anchor.href || anchor.getAttribute('href') || '';
      const label = normalizeInlineText(anchor.innerText || anchor.textContent || anchor.getAttribute('aria-label') || href);
      if (!href || !label) continue;

      const key = `${label}\u0000${href}`;
      if (seen.has(key)) continue;
      seen.add(key);

      links.push({
        label,
        href,
        title: anchor.getAttribute('title') || '',
        target: anchor.getAttribute('target') || '',
        rel: anchor.getAttribute('rel') || '',
        ariaLabel: anchor.getAttribute('aria-label') || ''
      });
    }

    return links;
  }

  function createPreservedAnchor(link) {
    const anchor = document.createElement('a');
    anchor.className = 'lt-preserved-link';
    anchor.href = link.href;
    anchor.textContent = link.label;

    if (link.title) anchor.title = link.title;
    if (link.ariaLabel) anchor.setAttribute('aria-label', link.ariaLabel);
    if (link.target) anchor.target = link.target;
    if (link.rel) anchor.rel = link.rel;
    else if (link.target === '_blank') anchor.rel = 'noopener noreferrer';

    // Não interromper o clique. O href original continua sendo a fonte de verdade.
    // stopPropagation seria incorreto aqui porque X/Reddit podem delegar navegação.
    return anchor;
  }

  function renderTranslatedWithLinks(container, translated, sourceEl) {
    const text = String(translated || '');
    const links = originalLinksFor(sourceEl);
    if (!links.length) {
      container.textContent = text;
      return;
    }

    // O tradutor costuma preservar URLs, @menções e #hashtags. Recolocamos os
    // anchors originais exatamente onde o rótulo sobreviveu à tradução.
    const remaining = links.map((link, index) => ({ ...link, index, used: false }));
    let cursor = 0;

    while (cursor < text.length) {
      let best = null;

      for (const link of remaining) {
        if (link.used || !link.label) continue;
        const at = text.indexOf(link.label, cursor);
        if (at < 0) continue;
        if (!best || at < best.at || (at === best.at && link.label.length > best.link.label.length)) {
          best = { at, link };
        }
      }

      if (!best) {
        container.append(document.createTextNode(text.slice(cursor)));
        break;
      }

      if (best.at > cursor) container.append(document.createTextNode(text.slice(cursor, best.at)));
      container.append(createPreservedAnchor(best.link));
      best.link.used = true;
      cursor = best.at + best.link.label.length;
    }

    // Se a tradução modificou/removeu o texto visível do link, nunca o perdemos.
    // Ex.: alguns motores alteram pontuação ao redor de URLs ou hashtags.
    const unmatched = remaining.filter((link) => !link.used);
    if (unmatched.length) {
      const fallback = document.createElement('span');
      fallback.className = 'lt-preserved-links-fallback';
      fallback.append(document.createTextNode(' '));
      unmatched.forEach((link, index) => {
        if (index) fallback.append(document.createTextNode(' · '));
        fallback.append(createPreservedAnchor(link));
      });
      container.append(fallback);
    }
  }

  function createTranslationUI(el, translated, provider) {
    translationContainerFor(el)?.remove();

    const wrap = document.createElement('div');
    wrap.className = 'lt-translation-wrap';
    wrap.dataset.ltProvider = provider || '';

    const translatedText = document.createElement('div');
    translatedText.className = 'lt-translated-text';
    translatedText.lang = state.settings.targetLanguage;
    renderTranslatedWithLinks(translatedText, translated, el);

    const controls = document.createElement('div');
    controls.className = 'lt-translation-controls';

    const badge = document.createElement('span');
    badge.className = 'lt-badge';
    badge.textContent = provider === 'chrome' ? 'PT · LOCAL' : 'PT · G';
    badge.title = provider === 'chrome' ? 'Traduzido localmente pelo Chrome' : 'Traduzido com Google';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'lt-original-toggle';
    toggle.textContent = 'Original';
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = wrap.classList.toggle('lt-original-open');
      el.classList.toggle('lt-original-collapsed', !open);
      toggle.textContent = open ? 'Ocultar original' : 'Original';
    });

    controls.append(badge, toggle);
    wrap.append(translatedText, controls);
    el.insertAdjacentElement('afterend', wrap);
    applyDisplayMode(el, wrap);
    return wrap;
  }

  async function detectLanguage(text, hinted) {
    const normalizedHint = normalizeLang(hinted);
    if (normalizedHint) return normalizedHint;
    if (!text || text.length < 4) return null;

    try {
      const result = await chrome.i18n.detectLanguage(text.slice(0, 5000));
      const candidates = Array.isArray(result?.languages) ? result.languages : [];
      const best = candidates[0];
      if (!best?.language || best.language === 'und') return null;
      if (result.isReliable || Number(best.percentage || 0) >= 55) return normalizeLang(best.language);
    } catch {}
    return null;
  }

  function shouldTranslate(text, sourceLanguage) {
    if (!translationAllowed()) return false;
    if (!text || text.length < 2) return false;
    if (sourceLanguage === state.settings.targetLanguage || (sourceLanguage === 'pt' && state.settings.targetLanguage === 'pt')) return false;
    if (!state.settings.translateNonEnglish && sourceLanguage && sourceLanguage !== 'en') return false;
    return true;
  }

  async function googleTranslate(text, sourceLanguage) {
    const response = await chrome.runtime.sendMessage({
      type: 'LT_GOOGLE_TRANSLATE',
      text,
      sourceLanguage: sourceLanguage || 'auto',
      targetLanguage: state.settings.targetLanguage
    });
    if (!response?.ok || !response.translated) throw new Error(response?.error || 'Google indisponível');
    return response;
  }

  async function getNativeTranslator(sourceLanguage) {
    const targetLanguage = state.settings.targetLanguage;
    if (!sourceLanguage || !SUPPORTED_NATIVE.has(sourceLanguage) || !SUPPORTED_NATIVE.has(targetLanguage)) return null;
    if (!('Translator' in self)) return null;

    const key = `${sourceLanguage}->${targetLanguage}`;
    if (state.nativeTranslators.has(key)) return state.nativeTranslators.get(key);
    if (state.nativeTranslatorPromises.has(key)) return state.nativeTranslatorPromises.get(key);

    const promise = (async () => {
      const availability = await Translator.availability({ sourceLanguage, targetLanguage });
      // Não iniciamos download silenciosamente: se o pacote não está pronto,
      // o modo automático usa Google e continua sem bloquear o feed.
      if (availability !== 'available') return null;
      const translator = await Translator.create({ sourceLanguage, targetLanguage });
      state.nativeTranslators.set(key, translator);
      return translator;
    })().catch(() => null).finally(() => state.nativeTranslatorPromises.delete(key));

    state.nativeTranslatorPromises.set(key, promise);
    return promise;
  }

  async function nativeTranslate(text, sourceLanguage) {
    const translator = await getNativeTranslator(sourceLanguage);
    if (!translator) return null;
    const translated = String(await translator.translate(text)).trim();
    if (!translated) return null;
    return { ok: true, translated, detectedSource: sourceLanguage, provider: 'chrome' };
  }

  async function translateText(text, sourceLanguage) {
    const provider = state.settings.provider;

    if (provider === 'google') return googleTranslate(text, sourceLanguage);

    if (provider === 'chrome') {
      const local = await nativeTranslate(text, sourceLanguage);
      if (!local) throw new Error('Tradutor local não está pronto para este idioma');
      return local;
    }

    // Automático: usa o tradutor local se ele JÁ estiver pronto; caso contrário,
    // cai imediatamente para Google. Isso reduz rate limit sem introduzir cliques.
    if (sourceLanguage) {
      const local = await nativeTranslate(text, sourceLanguage);
      if (local) return local;
    }

    return googleTranslate(text, sourceLanguage);
  }

  function enqueue(el, priority = false) {
    if (!translationAllowed() || !isGoodCandidate(el)) return;

    const now = Date.now();
    const nextRetry = Number(el.dataset.ltNextRetry || 0);
    if (nextRetry && now < nextRetry) return;

    if (state.queued.has(el) || el.dataset.ltState === 'translated' || el.dataset.ltState === 'working') return;
    state.queued.add(el);
    priority ? state.queue.unshift(el) : state.queue.push(el);
    pumpQueue();
  }

  function registerElement(el) {
    if (!(el instanceof HTMLElement) || !isGoodCandidate(el)) return;

    if (!state.discovered.has(el)) {
      state.discovered.add(el);
      state.stats.discovered += 1;
    }

    const currentText = getText(el);
    if (el.dataset.ltText && el.dataset.ltText !== currentText) {
      removeTranslation(el);
    }

    if (!state.observed.has(el)) {
      state.observed.add(el);
      state.intersectionObserver?.observe(el);
    }

    const rect = el.getBoundingClientRect();
    if (rect.top < innerHeight + 1400 && rect.bottom > -900) enqueue(el, true);
  }

  function closestCandidate(node) {
    const element = node instanceof HTMLElement ? node : node?.parentElement;
    if (!element) return null;
    for (const selector of selectorSet()) {
      try {
        const found = element.closest(selector);
        if (found) return found;
      } catch {}
    }
    return null;
  }

  function scan(root = document) {
    if (!translationAllowed()) return;
    const selectors = selectorSet();

    const ancestor = closestCandidate(root);
    if (ancestor) registerElement(ancestor);

    if (root instanceof HTMLElement) {
      for (const selector of selectors) {
        try {
          if (root.matches(selector)) registerElement(root);
        } catch {}
      }
    }

    for (const selector of selectors) {
      let elements = [];
      try { elements = qa(selector, root); } catch { continue; }
      elements.forEach(registerElement);
    }
  }

  function scheduleScan(root = document) {
    state.pendingRoots.add(root);
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      const roots = [...state.pendingRoots];
      state.pendingRoots.clear();
      for (const pendingRoot of roots.slice(-120)) scan(pendingRoot);
      if (roots.length > 120) scan(document);
    }, 40);
  }

  function retryDelay(attempt) {
    if (attempt <= 1) return 900;
    if (attempt === 2) return 1800;
    if (attempt === 3) return 3500;
    if (attempt === 4) return 7000;
    return 15000;
  }

  async function translateElement(el) {
    if (!translationAllowed() || !el?.isConnected || !isGoodCandidate(el)) return;

    const generation = state.generation;

    const text = getText(el);
    let sourceLanguage = sourceLanguageFor(el);
    sourceLanguage = await detectLanguage(text, sourceLanguage);
    if (generation !== state.generation || !translationAllowed()) return;

    if (!shouldTranslate(text, sourceLanguage)) {
      el.dataset.ltState = 'skipped';
      el.dataset.ltText = text;
      state.stats.skipped += 1;
      return;
    }

    if (el.dataset.ltText && el.dataset.ltText !== text) removeTranslation(el);
    if (el.dataset.ltState === 'translated' && el.dataset.ltText === text) return;

    el.dataset.ltText = text;
    el.dataset.ltSource = sourceLanguage || 'auto';
    el.dataset.ltState = 'working';
    state.stats.working += 1;

    const key = cacheKey(sourceLanguage, state.settings.targetLanguage, text);
    const cached = cacheGet(key);
    if (cached) {
      if (generation === state.generation && translationAllowed() && el.isConnected && getText(el) === text) {
        createTranslationUI(el, cached.translated, cached.provider);
        el.dataset.ltState = 'translated';
        state.stats.translated += 1;
      }
      state.stats.working = Math.max(0, state.stats.working - 1);
      return;
    }

    try {
      const result = await translateText(text, sourceLanguage);
      if (generation !== state.generation || !translationAllowed() || !el.isConnected || getText(el) !== text) return;

      const detected = normalizeLang(result.detectedSource) || sourceLanguage;
      if (detected === state.settings.targetLanguage || (detected === 'pt' && state.settings.targetLanguage === 'pt')) {
        el.dataset.ltState = 'skipped';
        state.stats.skipped += 1;
        return;
      }

      const translated = String(result.translated || '').trim();
      if (!translated) throw new Error('Tradução vazia');

      const saved = { translated, detectedSource: detected, provider: result.provider || 'google' };
      cacheSet(key, saved);
      createTranslationUI(el, translated, saved.provider);
      el.dataset.ltState = 'translated';
      state.lastProvider = saved.provider;
      state.stats.translated += 1;

      const attempts = Number(el.dataset.ltAttempts || 0);
      if (attempts > 0) state.stats.recovered += 1;
      delete el.dataset.ltAttempts;
      delete el.dataset.ltNextRetry;
    } catch (error) {
      if (generation !== state.generation || !translationAllowed()) return;
      const attempts = Number(el.dataset.ltAttempts || 0) + 1;
      el.dataset.ltAttempts = String(attempts);
      el.dataset.ltState = 'error';
      el.dataset.ltNextRetry = String(Date.now() + retryDelay(attempts));
      state.stats.transientErrors += 1;
      console.warn('[Live Translator] Falha temporária; será tentado novamente:', error);
    } finally {
      state.stats.working = Math.max(0, state.stats.working - 1);
    }
  }

  function pumpQueue() {
    if (!translationAllowed()) return;

    while (state.activeWorkers < state.maxWorkers && state.queue.length) {
      const el = state.queue.shift();
      if (!el?.isConnected) {
        state.queued.delete(el);
        continue;
      }

      state.activeWorkers += 1;
      const queuedSet = state.queued;
      translateElement(el)
        .catch((error) => console.warn('[Live Translator] worker:', error))
        .finally(() => {
          queuedSet.delete(el);
          state.activeWorkers = Math.max(0, state.activeWorkers - 1);
          pumpQueue();
        });
    }
  }

  function setupIntersectionObserver() {
    state.intersectionObserver?.disconnect();
    state.intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) enqueue(entry.target, true);
      }
    }, { root: null, rootMargin: '1600px 0px 1800px 0px', threshold: 0.001 });
  }

  function setupMutationObserver() {
    state.mutationObserver?.disconnect();
    state.mutationObserver = new MutationObserver((mutations) => {
      if (!translationAllowed()) return;
      for (const mutation of mutations) {
        if (isExtensionNode(mutation.target instanceof HTMLElement ? mutation.target : mutation.target?.parentElement)) continue;

        const ancestor = closestCandidate(mutation.target);
        if (ancestor) {
          if (ancestor.dataset.ltText && ancestor.dataset.ltText !== getText(ancestor)) removeTranslation(ancestor);
          registerElement(ancestor);
          enqueue(ancestor, true);
        }

        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && !isExtensionNode(node)) scheduleScan(node);
            else if (node.nodeType === Node.TEXT_NODE && node.parentElement) scheduleScan(node.parentElement);
          }
        } else if (mutation.type === 'characterData') {
          const candidate = closestCandidate(mutation.target);
          if (candidate) {
            removeTranslation(candidate);
            registerElement(candidate);
            enqueue(candidate, true);
          }
        }
      }
    });

    state.mutationObserver.observe(document.body || document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true
    });
  }

  function allCurrentCandidates() {
    const set = new Set();
    for (const selector of selectorSet()) {
      try { qa(selector).forEach((el) => set.add(el)); } catch {}
    }
    return [...set];
  }

  function rescanAll({ reset = false } = {}) {
    if (!translationAllowed()) return;
    for (const el of allCurrentCandidates()) {
      if (reset) removeTranslation(el);
      registerElement(el);
      enqueue(el, true);
    }
    pumpQueue();
  }

  function recoverySweep() {
    if (!translationAllowed() || document.hidden) return;

    // Feed virtualizado + DOM incremental pode escapar de um MutationObserver isolado.
    // Esta varredura barata garante convergência: tudo que estiver próximo da tela
    // acaba descoberto, e falhas temporárias voltam automaticamente para a fila.
    for (const el of allCurrentCandidates()) {
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top > innerHeight + 2200 || rect.bottom < -1400) continue;

      const currentText = getText(el);
      if (el.dataset.ltText && el.dataset.ltText !== currentText) removeTranslation(el);
      registerElement(el);

      if (el.dataset.ltState === 'error') {
        const nextRetry = Number(el.dataset.ltNextRetry || 0);
        if (!nextRetry || Date.now() >= nextRetry) {
          delete el.dataset.ltState;
          enqueue(el, true);
        }
      } else if (!el.dataset.ltState) {
        enqueue(el, true);
      }
    }
  }

  function startRecoverySweep() {
    clearInterval(state.sweepTimer);
    state.sweepTimer = setInterval(recoverySweep, 850);
  }

  function disableAll() {
    state.generation += 1;
    state.queue.length = 0;
    state.queued = new WeakSet();
    for (const el of allCurrentCandidates()) removeTranslation(el);
  }

  async function loadSettings() {
    const saved = await chrome.storage.sync.get(DEFAULTS);
    state.settings = { ...DEFAULTS, ...saved };
    state.settings.ignoredHosts = LiveTranslatorSites.normalizeList(state.settings.ignoredHosts);
  }

  function listenForSettings() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const wasAllowed = translationAllowed();
      let reset = false;
      for (const [key, change] of Object.entries(changes)) {
        state.settings[key] = change.newValue;
        if (['targetLanguage', 'displayMode', 'translateNonEnglish', 'provider', 'scope'].includes(key)) reset = true;
      }

      state.settings.ignoredHosts = LiveTranslatorSites.normalizeList(state.settings.ignoredHosts);

      if (!translationAllowed()) {
        disableAll();
        return;
      }
      rescanAll({ reset: reset || !wasAllowed });
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'LT_STATUS') {
        const candidates = allCurrentCandidates();
        const nearViewport = candidates.filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.top < innerHeight + 2200 && rect.bottom > -1400;
        });
        const untranslated = nearViewport.filter((el) => !['translated', 'skipped', 'working'].includes(el.dataset.ltState || '')).length;
        const retrying = nearViewport.filter((el) => el.dataset.ltState === 'error').length;

        sendResponse({
          ok: true,
          enabled: state.settings.enabled,
          scopeAllowsPage: scopeAllowsPage(),
          siteIgnored: siteIgnored(),
          queue: state.queue.length,
          working: state.activeWorkers,
          discovered: state.stats.discovered,
          translated: state.stats.translated,
          skipped: state.stats.skipped,
          untranslated,
          retrying,
          transientErrors: state.stats.transientErrors,
          recovered: state.stats.recovered,
          provider: state.settings.provider,
          lastProvider: state.lastProvider,
          host: location.hostname
        });
      } else if (message?.type === 'LT_RESCAN') {
        if (translationAllowed()) rescanAll({ reset: message.reset === true });
        sendResponse({ ok: translationAllowed() });
      }
      return false;
    });
  }

  function watchSpaNavigation() {
    setInterval(() => {
      if (state.url === location.href) return;
      state.url = location.href;
      setTimeout(() => rescanAll(), 150);
    }, 500);
  }

  async function init() {
    await loadSettings();
    setupIntersectionObserver();
    setupMutationObserver();
    listenForSettings();
    watchSpaNavigation();
    startRecoverySweep();
    scan(document);
    setTimeout(() => scan(document), 250);
    setTimeout(() => scan(document), 900);
  }

  init().catch((error) => console.error('[Live Translator] Erro fatal:', error));
})();
