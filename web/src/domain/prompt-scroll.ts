type PromptScrollTarget = Pick<HTMLTextAreaElement,
  'scrollTop' | 'scrollHeight' | 'clientHeight' | 'selectionStart' | 'selectionEnd' | 'scrollTo'>;
type PromptWheel = Pick<WheelEvent,
  'deltaY' | 'deltaX' | 'deltaMode' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'cancelable' | 'preventDefault'>;

/** Set a whole-line destination during the wheel event. Never correct a scroll later. */
export function createPromptLineScroll(lineHeight: () => number,
  reducedMotion: () => boolean = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let pointerDown = false;
  let current: PromptScrollTarget | null = null;
  let destination = 0;
  let direction = 0;
  function cancel() {
    if (current && current.scrollTop !== destination) current.scrollTo({ top: current.scrollTop, behavior: 'instant' });
    current = null;
    direction = 0;
  }

  return {
    cancel,
    pointerStart() { pointerDown = true; cancel(); },
    pointerEnd() { pointerDown = false; },
    wheel(element: PromptScrollTarget, event: PromptWheel) {
      if (pointerDown || element.selectionStart !== element.selectionEnd || !event.cancelable
        || event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        cancel();
        return;
      }
      const height = lineHeight();
      if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(event.deltaY) || !event.deltaY) return;
      // Preserve fine pixel scrolling and touchpad inertia without any subsequent snapping.
      if (event.deltaMode === 0 && (Math.abs(event.deltaY) < height || !Number.isInteger(event.deltaY))) {
        cancel();
        return;
      }
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      const nextDirection = Math.sign(event.deltaY);
      const base = current === element && direction === nextDirection ? destination : element.scrollTop;
      const pixels = event.deltaMode === 1 ? event.deltaY * height
        : event.deltaMode === 2 ? event.deltaY * element.clientHeight : event.deltaY;
      const lines = nextDirection * Math.max(1, Math.round(Math.abs(pixels) / height));
      const next = Math.min(maximum, Math.max(0, (Math.round(base / height) + lines) * height));
      if (next === element.scrollTop && (base === element.scrollTop || current !== element)) {
        cancel();
        return; // At an edge, allow the page to scroll normally.
      }
      event.preventDefault();
      current = element;
      direction = nextDirection;
      destination = next;
      element.scrollTo({ top: next, behavior: reducedMotion() ? 'instant' : 'smooth' });
    },
  };
}
