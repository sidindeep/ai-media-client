(() => {
  const label = document.getElementById('appVersion');
  if (!label) return;
  void fetch('/api/version', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('version unavailable');
    const release = await response.json();
    const builtAt = release.builtAt ? new Date(release.builtAt) : null;
    const builtLabel = builtAt && !Number.isNaN(builtAt.getTime())
      ? new Intl.DateTimeFormat(document.documentElement.lang, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
        .format(builtAt).replace(',', '')
      : null;
    label.textContent = `${release.channel === 'debug' ? 'DEBUG · ' : ''}Версия ${release.version}${builtLabel ? ` · ${builtLabel}` : ''} · коммит ${release.commit?.slice(0, 12) || 'недоступен'}`;
    label.title = release.builtAt ? `Собрано: ${new Date(release.builtAt).toLocaleString(document.documentElement.lang)}` : 'Запуск из исходников';
  }).catch(() => { label.textContent = 'DEBUG · версия сервера недоступна'; });
})();
