(() => {
  'use strict';

  function normalizeHost(value) {
    if (typeof value !== 'string') return '';
    const host = value.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    return /^[a-z0-9.-]+$/.test(host) && host && !host.includes('..') ? host : '';
  }

  function hostFromUrl(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? normalizeHost(url.hostname) : '';
    } catch {
      return '';
    }
  }

  function normalizeList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(normalizeHost).filter(Boolean))].sort();
  }

  function isIgnored(host, list) {
    return normalizeList(list).includes(normalizeHost(host));
  }

  globalThis.LiveTranslatorSites = Object.freeze({ normalizeHost, hostFromUrl, normalizeList, isIgnored });
})();
