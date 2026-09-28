(async () => {
  const status = document.getElementById('maxStatus');
  const link = document.getElementById('maxOpen');
  try {
    const response = await fetch('/auth/max/link', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    link.href = data.url;
    link.hidden = false;
    status.textContent = 'После подтверждения в MAX вернитесь в эту вкладку.';
    const poll = async () => {
      try {
        const result = await fetch('/auth/max/status', { cache: 'no-store' });
        const state = await result.json();
        if (!result.ok) throw new Error(state.error);
        if (state.ready) { location.assign('/app'); return; }
        setTimeout(poll, 2000);
      } catch (error) { status.textContent = error.message || 'Вход MAX не завершён.'; }
    };
    void poll();
  } catch (error) { status.textContent = error.message || 'Вход MAX недоступен.'; }
})();
