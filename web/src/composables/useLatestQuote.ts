import { onBeforeUnmount, ref, shallowRef } from 'vue';

export function useLatestQuote<T>(options: {
  ready: () => boolean;
  request: (revision: number, isCurrent: (revision: number) => boolean) => Promise<{ quote: T | null; error?: string }>;
  unavailableMessage: () => string;
}) {
  const quote = shallowRef<T | null>(null);
  const quoteError = ref('');
  const quoteLoading = ref(false);
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const isCurrent = (value: number) => value === revision;

  function stopTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  async function refresh(value: number) {
    try {
      const result = await options.request(value, isCurrent);
      if (isCurrent(value)) {
        quote.value = result.quote;
        quoteError.value = result.error || '';
      }
    } catch (error) {
      if (isCurrent(value)) {
        quote.value = null;
        quoteError.value = error instanceof Error ? error.message : options.unavailableMessage();
      }
    } finally {
      if (isCurrent(value)) quoteLoading.value = false;
    }
  }

  function schedule(delay = 0) {
    stopTimer();
    const value = ++revision;
    quote.value = null;
    quoteError.value = '';
    quoteLoading.value = options.ready();
    if (!quoteLoading.value) return;
    timer = setTimeout(() => {
      timer = null;
      if (isCurrent(value)) void refresh(value);
    }, delay);
  }

  function acceptIfCurrent(value: number, result: T) {
    if (!isCurrent(value)) return false;
    stopTimer();
    revision++;
    quote.value = result;
    quoteError.value = '';
    quoteLoading.value = false;
    return true;
  }

  onBeforeUnmount(() => { stopTimer(); revision++; });
  return { quote, quoteError, quoteLoading, schedule, acceptIfCurrent, currentRevision: () => revision };
}
