import { t, type TranslationKey } from './index';

const stateKeys: Record<string, TranslationKey> = {
  queued: 'generation.state.queued', preparing: 'generation.state.preparing', submitting: 'generation.state.submitting',
  waiting: 'generation.state.waiting', queuing: 'generation.state.queuing', generating: 'generation.state.generating',
  running: 'generation.state.generating', success: 'generation.state.success', fail: 'generation.state.fail',
  blocked: 'generation.state.blocked', cancelled: 'generation.state.cancelled', unknown: 'generation.state.unknown',
  unconfirmed: 'generation.state.unknown',
};

const effortKeys: Record<string, TranslationKey> = {
  none: 'generation.effort.none', minimal: 'generation.effort.minimal', low: 'generation.effort.low',
  medium: 'generation.effort.medium', high: 'generation.effort.high', xhigh: 'generation.effort.xhigh',
  max: 'generation.effort.max', ultra: 'generation.effort.ultra',
};

export function generationStateLabel(state: string) {
  const key = stateKeys[state];
  return key ? t(key) : state;
}

export function reasoningEffortLabel(effort: string) {
  const key = effortKeys[effort];
  return key ? t(key) : effort;
}

export function generationDuration(milliseconds?: number | null) {
  if (milliseconds == null) return '';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60
    ? t('generation.duration.seconds', { count: seconds })
    : t('generation.duration.minutes', { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, '0') });
}
