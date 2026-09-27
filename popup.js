(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    displayMode: 'translated-only',
    translateNonEnglish: true,
    provider: 'auto',
    scope: 'all',
    ignoredHosts: []
  };

  const enabled = document.getElementById('enabled');
  const displayMode = document.getElementById('displayMode');
  const translateNonEnglish = document.getElementById('translateNonEnglish');
  const provider = document.getElementById('provider');
  const scope = document.getElementById('scope');
  const rescan = document.getElementById('rescan');
  const status = document.getElementById('status');
  const currentHost = document.getElementById('currentHost');
  const toggleSite = document.getElementById('toggleSite');
  const ignoredSites = document.getElementById('ignoredSites');
  let ignoredHosts = [];
  let host = '';

  function renderSites() {
    const ignored = LiveTranslatorSites.isIgnored(host, ignoredHosts);
    currentHost.textContent = host || 'Indisponível nesta página';
    toggleSite.disabled = !host;
    toggleSite.textContent = ignored ? 'Voltar a traduzir este site' : 'Ignorar este site';
    ignoredSites.replaceChildren();
    if (!ignoredHosts.length) return;

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Sites ignorados (${ignoredHosts.length})`;
    const list = document.createElement('ul');
    for (const domain of ignoredHosts) {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = domain;
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = 'Reativar';
      restore.setAttribute('aria-label', `Voltar a traduzir ${domain}`);
      restore.addEventListener('click', () => changeSite(domain, false));
      row.append(label, restore);
      list.append(row);
    }
    details.append(summary, list);
    ignoredSites.append(details);
  }

  async function changeSite(domain, ignore) {
    toggleSite.disabled = true;
    try {
      const saved = await chrome.storage.sync.get({ ignoredHosts: [] });
      const next = new Set(LiveTranslatorSites.normalizeList(saved.ignoredHosts));
      if (ignore) next.add(domain);
      else next.delete(domain);
      const updated = [...next].sort();
      await chrome.storage.sync.set({ ignoredHosts: updated });
      ignoredHosts = updated;
      renderSites();
      await refreshStatus();
    } catch {
      status.textContent = 'Não foi possível salvar a preferência. Tente novamente.';
    } finally {
      toggleSite.disabled = !host;
    }
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) return null;
    return tab;
  }

  async function save(key, value) {
    await chrome.storage.sync.set({ [key]: value });
  }

  async function refreshStatus() {
    const tab = await activeTab();
    const nextHost = LiveTranslatorSites.hostFromUrl(tab?.url || '');
    if (nextHost !== host) {
      host = nextHost;
      renderSites();
    }
    if (!tab) {
      status.textContent = 'Abra uma página http/https para usar a extensão.';
      rescan.disabled = true;
      return;
    }
    rescan.disabled = LiveTranslatorSites.isIgnored(host, ignoredHosts);

    try {
      const info = await chrome.tabs.sendMessage(tab.id, { type: 'LT_STATUS' });
      if (info?.siteIgnored || LiveTranslatorSites.isIgnored(host, ignoredHosts)) {
        status.textContent = 'Site ignorado. A tradução está desativada aqui.';
        rescan.disabled = true;
      } else if (!info?.enabled) {
        status.textContent = 'Pausado.';
      } else if (!info.scopeAllowsPage) {
        status.textContent = 'Este site está fora do escopo selecionado.';
      } else {
        const busy = (info.queue || 0) + (info.working || 0);
        const providerLabel = info.lastProvider === 'google'
          ? 'Google'
          : info.lastProvider === 'chrome'
            ? 'Chrome local'
            : 'aguardando conteúdo';

        if (busy) {
          status.textContent = `Automático ativo · processando ${busy} · traduzidos ${info.translated || 0}.`;
        } else if (info.retrying) {
          status.textContent = `Automático ativo · ${info.translated || 0} traduzidos · recuperando ${info.retrying} falha(s) automaticamente.`;
        } else {
          status.textContent = `Automático ativo · ${info.translated || 0} traduzidos · motor: ${providerLabel}.`;
        }
      }
    } catch {
      status.textContent = LiveTranslatorSites.isIgnored(host, ignoredHosts)
        ? 'Site ignorado. A tradução está desativada aqui.'
        : 'Recarregue esta aba uma vez após atualizar a extensão.';
    }
  }

  async function init() {
    const settings = await chrome.storage.sync.get(DEFAULTS);
    ignoredHosts = LiveTranslatorSites.normalizeList(settings.ignoredHosts);
    renderSites();
    enabled.checked = settings.enabled;
    displayMode.value = settings.displayMode;
    translateNonEnglish.checked = settings.translateNonEnglish;
    provider.value = settings.provider;
    scope.value = settings.scope;

    enabled.addEventListener('change', async () => { await save('enabled', enabled.checked); refreshStatus(); });
    displayMode.addEventListener('change', async () => { await save('displayMode', displayMode.value); refreshStatus(); });
    translateNonEnglish.addEventListener('change', async () => { await save('translateNonEnglish', translateNonEnglish.checked); refreshStatus(); });
    provider.addEventListener('change', async () => { await save('provider', provider.value); refreshStatus(); });
    scope.addEventListener('change', async () => { await save('scope', scope.value); refreshStatus(); });
    toggleSite.addEventListener('click', () => changeSite(host, !LiveTranslatorSites.isIgnored(host, ignoredHosts)));

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.ignoredHosts) return;
      ignoredHosts = LiveTranslatorSites.normalizeList(changes.ignoredHosts.newValue);
      renderSites();
      refreshStatus();
    });

    rescan.addEventListener('click', async () => {
      const tab = await activeTab();
      if (!tab) return;
      rescan.disabled = true;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'LT_RESCAN', reset: true });
        status.textContent = 'Reprocessando a página…';
      } catch {
        status.textContent = 'Recarregue a aba e tente novamente.';
      } finally {
        setTimeout(() => { rescan.disabled = false; refreshStatus(); }, 500);
      }
    });

    refreshStatus();
    setInterval(refreshStatus, 1000);
  }

  init();
})();
