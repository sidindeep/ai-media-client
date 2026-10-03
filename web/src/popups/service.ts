import { readonly, shallowRef } from 'vue';

type CommonOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};
type TextOptions = CommonOptions & {
  label: string;
  initialValue?: string;
  maxLength?: number;
  onConfirm?: (value: string) => void | Promise<void>;
};
type SelectOptions = TextOptions & { options: readonly { value: string; label: string }[] };
type ConfirmOptions = CommonOptions & { onConfirm?: () => void | Promise<void> };
export type PopupRequest = CommonOptions & {
  id: number;
  kind: 'prompt' | 'select' | 'confirm' | 'alert';
  label?: string;
  initialValue?: string;
  maxLength?: number;
  options?: readonly { value: string; label: string }[];
};
type Result = string | boolean | null | undefined;
type Pending = {
  request: PopupRequest;
  resolve: (value: Result) => void;
  onConfirm?: (value: string) => void | Promise<void>;
};

// Each app owns one controller and one host. Only transient UI state lives here.
export function createPopupService() {
  const active = shallowRef<PopupRequest | null>(null);
  const busy = shallowRef(false);
  const error = shallowRef<string | null>(null);
  const queue: Pending[] = [];
  let current: Pending | undefined;
  let sequence = 0;

  function advance() {
    current = queue.shift();
    error.value = null;
    busy.value = false;
    active.value = current?.request || null;
  }
  function enqueue<T extends Result>(request: Omit<PopupRequest, 'id'>, onConfirm?: Pending['onConfirm']): Promise<T> {
    return new Promise(resolve => {
      queue.push({ request: { ...request, id: ++sequence }, resolve: value => resolve(value as T), onConfirm });
      if (!current) advance();
    });
  }
  function finish(value: Result) {
    const completed = current;
    advance();
    completed?.resolve(value);
  }
  function cancellation(request: PopupRequest): Result {
    return request.kind === 'confirm' ? false : request.kind === 'alert' ? undefined : null;
  }
  function cancel() {
    if (current && !busy.value) finish(cancellation(current.request));
  }
  async function submit(input = '') {
    if (!current || busy.value) return;
    const pending = current;
    const request = pending.request;
    const value = request.kind === 'prompt' ? input.trim() : input;
    if (request.kind === 'prompt' && (!value || (request.maxLength !== undefined && value.length > request.maxLength))) return;
    if (request.kind === 'select' && !request.options?.some(option => option.value === value)) return;
    busy.value = true;
    error.value = null;
    try {
      await pending.onConfirm?.(value);
      if (current !== pending) return;
      finish(request.kind === 'confirm' ? true : request.kind === 'alert' ? undefined : value);
    } catch (cause) {
      if (current !== pending) return;
      error.value = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
      busy.value = false;
    }
  }
  function dismissAll() {
    const pending = [...(current ? [current] : []), ...queue];
    queue.length = 0;
    current = undefined;
    active.value = null;
    busy.value = false;
    error.value = null;
    for (const item of pending) item.resolve(cancellation(item.request));
  }
  return {
    active: readonly(active), busy: readonly(busy), error: readonly(error),
    prompt({ onConfirm, ...options }: TextOptions) { return enqueue<string | null>({ ...options, kind: 'prompt' }, onConfirm); },
    select({ onConfirm, ...options }: SelectOptions) { return enqueue<string | null>({ ...options, options: options.options.map(option => ({ ...option })), kind: 'select' }, onConfirm); },
    confirm({ onConfirm, ...options }: ConfirmOptions) { return enqueue<boolean>({ ...options, kind: 'confirm' }, onConfirm); },
    alert(options: CommonOptions) { return enqueue<undefined>({ ...options, kind: 'alert' }); },
    submit, cancel, dismissAll,
  };
}

export const popups = createPopupService();
