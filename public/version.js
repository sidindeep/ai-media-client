(() => {
  const label = document.getElementById('appVersion');
  if (!label) return;
  void fetch('/api/version', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('version unavailable');
    const release = await response.json();
    label.textContent = `${release.channel === 'debug' ? 'DEBUG · ' : ''}Версия ${release.version} · сборка ${release.build}`;
    label.title = release.builtAt ? `Собрано: ${new Date(release.builtAt).toLocaleString('ru-RU')}` : 'Запуск из исходников';
  }).catch(() => { label.textContent = 'DEBUG · версия сервера недоступна'; });
})();
