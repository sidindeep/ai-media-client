(() => {
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[href*="#"]');
    if (!link) return;

    const destination = new URL(link.href, window.location.href);
    if (destination.origin !== window.location.origin
      || destination.pathname !== window.location.pathname
      || destination.search !== window.location.search
      || !destination.hash) return;

    const id = decodeURIComponent(destination.hash.slice(1));
    const target = document.getElementById(id);
    if (!target) return;

    event.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (window.location.hash !== destination.hash) history.pushState(null, '', destination.hash);
  });
})();
