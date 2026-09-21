(() => {
  const boot = document.querySelector('[data-site-boot]');
  const bootStatus = document.querySelector('[data-site-boot-status]');
  const startedAt = performance.now();
  const minimumDuration = 2200;
  let finished = false;

  function syncHeroVideo(motion = window.AiMediaMotion?.current?.()) {
    const video = document.querySelector('[data-hero-video]');
    if (!video) return;
    if (motion === 'off') {
      video.pause();
      return;
    }
    const playback = video.play();
    playback?.catch?.(() => { /* The poster remains visible when autoplay is unavailable. */ });
  }

  window.addEventListener('ai-media-motion-change', event => syncHeroVideo(event.detail?.motion));
  document.addEventListener('DOMContentLoaded', () => syncHeroVideo(), { once: true });

  document.documentElement.classList.add('site-booting');

  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function revealLanding() {
    if (finished) return;
    finished = true;
    await wait(Math.max(0, minimumDuration - (performance.now() - startedAt)));
    boot?.classList.add('is-finished');
    document.documentElement.classList.remove('site-booting');
    setTimeout(() => boot?.remove(), 450);
  }

  async function resolveStartup() {
    if (bootStatus) bootStatus.textContent = 'Добро пожаловать';
    await revealLanding();
  }
  void resolveStartup();

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
