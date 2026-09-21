<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as api from '../api/client';
import { activeSubscriptionPromotion, subscriptionOffers } from '../config/subscription-offers';
import { useStudioStore } from '../stores/studio';
import { applyStudioTheme } from '../theme';
import type { Account, GenerationRecord } from '../types';

const props = defineProps<{ ready: boolean }>();
const emit = defineEmits<{ selectNotification: [record: GenerationRecord] }>();
const studio = useStudioStore();
const root = ref<HTMLElement | null>(null);
const account = ref<Account | null>(null);
const notificationsOpen = ref(false);
const subscriptionsOpen = ref(false);
const seenIds = ref(new Set<string>());
const promotion = activeSubscriptionPromotion();
const theme = ref<'dark' | 'light'>(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const terminalStates = new Set(['success', 'fail', 'blocked', 'cancelled', 'unknown', 'unconfirmed']);

const notifications = computed(() => [...studio.history]
  .filter(record => terminalStates.has(record.state))
  .sort((left, right) => notificationTime(right) - notificationTime(left))
  .slice(0, 8));
const unreadCount = computed(() => notifications.value.filter(record => !seenIds.value.has(record.id)).length);
const balance = computed(() => account.value?.wallet?.balance);
const seenStorageKey = computed(() => `ai-media-notifications-seen:${account.value?.id || 'local'}`);

function formatCredits(value?: number) {
  return value === undefined ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);
}

function notificationTime(record: GenerationRecord) {
  const value = record.generationCompletedAt || record.updatedAt || record.createdAt;
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function notificationTitle(record: GenerationRecord) {
  if (record.state === 'success') return 'Генерация готова';
  if (record.state === 'cancelled') return 'Генерация отменена';
  if (record.state === 'unknown' || record.state === 'unconfirmed') return 'Нужно проверить результат';
  return 'Ошибка генерации';
}

function notificationDescription(record: GenerationRecord) {
  return record.modelName || record.modelId || record.providerName || 'Задача';
}

function notificationDate(record: GenerationRecord) {
  const timestamp = notificationTime(record);
  if (!timestamp) return '';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function restoreSeen() {
  try {
    const stored = JSON.parse(localStorage.getItem(seenStorageKey.value) || '[]');
    seenIds.value = new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
  } catch {
    seenIds.value = new Set();
  }
}

function markNotificationsRead() {
  const next = new Set(seenIds.value);
  notifications.value.forEach(record => next.add(record.id));
  seenIds.value = next;
  localStorage.setItem(seenStorageKey.value, JSON.stringify([...next].slice(-100)));
}

async function loadAccount() {
  if (!props.ready) return;
  try {
    const previousId = account.value?.id;
    account.value = await api.getAccount();
    if (account.value.id !== previousId) restoreSeen();
  } catch {
    account.value = null;
  }
}

function toggleNotifications() {
  subscriptionsOpen.value = false;
  notificationsOpen.value = !notificationsOpen.value;
  if (notificationsOpen.value) markNotificationsRead();
}

function openSubscriptions() {
  notificationsOpen.value = false;
  subscriptionsOpen.value = true;
}

function selectNotification(record: GenerationRecord) {
  notificationsOpen.value = false;
  emit('selectNotification', record);
}

function closeOverlays() {
  notificationsOpen.value = false;
  subscriptionsOpen.value = false;
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  applyStudioTheme(theme.value);
}

function handlePointerDown(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) notificationsOpen.value = false;
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeOverlays();
}

function handleThemeChange(event: Event) {
  const next = (event as CustomEvent<{ theme?: string }>).detail?.theme;
  if (next === 'dark' || next === 'light') theme.value = next;
}

watch(() => props.ready, ready => { if (ready) void loadAccount(); else account.value = null; }, { immediate: true });
watch(() => `${studio.accountActive.length}:${studio.history[0]?.id || ''}:${studio.history[0]?.state || ''}`, () => { if (props.ready) void loadAccount(); });
onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('ai-media-theme-change', handleThemeChange);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown);
  document.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('ai-media-theme-change', handleThemeChange);
});
</script>

<template>
  <div ref="root" class="header-account-actions">
    <button class="subscription-button" type="button" aria-haspopup="dialog" @click="openSubscriptions">
      <span v-if="promotion" class="subscription-promo">{{ promotion.badge }}</span>
      <span class="subscription-label">Тарифы</span>
    </button>

    <span class="header-credit-balance" title="Доступный баланс внутренних кредитов" aria-label="Доступный баланс внутренних кредитов">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 19.5 8v8L12 20.5 4.5 16V8L12 3.5Z"/><path d="m8.5 10 3.5 2 3.5-2M12 12v4"/></svg>
      <strong>{{ formatCredits(balance) }}</strong><span>кр.</span>
    </span>

    <div class="notification-control">
      <button class="notification-button" type="button" aria-label="Уведомления" aria-haspopup="menu" :aria-expanded="notificationsOpen" @click="toggleNotifications">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></svg>
        <span v-if="unreadCount" class="notification-count">{{ unreadCount > 9 ? '9+' : unreadCount }}</span>
      </button>
      <div v-if="notificationsOpen" class="notification-popover" role="menu">
        <header><div><small>ЦЕНТР СОБЫТИЙ</small><strong>Уведомления</strong></div><button type="button" @click="markNotificationsRead">Прочитано</button></header>
        <div v-if="notifications.length" class="notification-list">
          <button v-for="record in notifications" :key="record.id" type="button" role="menuitem" :class="{ unread: !seenIds.has(record.id), error: record.state !== 'success' }" @click="selectNotification(record)">
            <span class="notification-dot"></span>
            <span><strong>{{ notificationTitle(record) }}</strong><small>{{ notificationDescription(record) }}</small></span>
            <time>{{ notificationDate(record) }}</time>
          </button>
        </div>
        <p v-else class="notification-empty">Новых событий пока нет.</p>
      </div>
    </div>

    <button class="theme-button" type="button" :aria-label="theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'" :title="theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'" :aria-pressed="theme === 'light'" @click="toggleTheme">
      <svg v-if="theme === 'dark'" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.2A8.7 8.7 0 0 1 8.8 3.5 8.8 8.8 0 1 0 20.5 15.2Z"/></svg>
    </button>
  </div>

  <Teleport to="body">
    <div v-if="subscriptionsOpen" class="subscription-backdrop" @mousedown.self="subscriptionsOpen = false">
      <section class="subscription-dialog" role="dialog" aria-modal="true" aria-labelledby="subscription-title">
        <header><div><span>ПОДПИСКА</span><h2 id="subscription-title">Тарифы AI Media</h2></div><button type="button" aria-label="Закрыть" @click="subscriptionsOpen = false">×</button></header>
        <div v-if="promotion" class="subscription-offer"><strong>{{ promotion.badge }} · {{ promotion.title }}</strong><p>{{ promotion.description }}</p></div>
        <div class="subscription-plans">
          <article v-for="offer in subscriptionOffers" :key="offer.id">
            <div><h3>{{ offer.name }}</h3><span v-if="offer.priceLabel">{{ offer.priceLabel }}</span></div>
            <p>{{ offer.description }}</p>
            <ul><li v-for="feature in offer.features" :key="feature">{{ feature }}</li></ul>
            <button type="button" :disabled="!offer.available">{{ offer.available ? 'Выбрать подписку' : 'Покупка скоро' }}</button>
          </article>
        </div>
        <p class="subscription-note">Платёжный модуль ещё не подключён. До его запуска кнопка не проводит оплату и не создаёт подписку.</p>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.header-account-actions { display: flex; align-items: center; gap: 9px; }
.subscription-button { display: flex; height: 36px; align-items: center; gap: 7px; border: 1px solid #65301d; border-radius: 999px; padding: 0 13px; color: #ded5d0; background: linear-gradient(135deg, #2c1711, #1b1313); font-size: 11px; font-weight: 750; }
.subscription-button:hover, .subscription-button:focus-visible { border-color: #a84825; outline: 0; color: #fff; box-shadow: 0 0 0 3px rgba(194, 73, 31, .12); }
.subscription-promo { color: #ff6f3d; font-weight: 850; }
.header-credit-balance { display: flex; height: 36px; align-items: center; gap: 5px; border: 1px solid #2e2e3d; border-radius: 999px; padding: 0 11px; color: #777383; background: rgba(15, 15, 22, .72); font-size: 10px; }
.header-credit-balance svg { width: 15px; fill: none; stroke: #9c84ff; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }
.header-credit-balance strong { color: #ede9f5; font-size: 11px; font-variant-numeric: tabular-nums; }
.notification-control { position: relative; }
.notification-button { position: relative; display: grid; width: 36px; height: 36px; place-items: center; border: 1px solid #2e2e3d; border-radius: 50%; color: #9b97aa; background: rgba(15, 15, 22, .72); }
.theme-button { display: grid; width: 36px; height: 36px; place-items: center; border: 1px solid #2e2e3d; border-radius: 50%; color: #9b97aa; background: rgba(15, 15, 22, .72); }
.notification-button:hover, .notification-button:focus-visible, .notification-button[aria-expanded="true"], .theme-button:hover, .theme-button:focus-visible { border-color: #625586; outline: 0; color: #fff; background: #211d31; }
.notification-button svg { width: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
.theme-button svg { width: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
.notification-count { position: absolute; top: -4px; right: -4px; display: grid; min-width: 16px; height: 16px; place-items: center; border: 2px solid #111118; border-radius: 999px; padding: 0 3px; color: #fff; background: #f05d2f; font-size: 8px; font-weight: 850; }
.notification-popover { position: absolute; z-index: 120; top: calc(100% + 10px); right: 0; width: min(340px, calc(100vw - 22px)); overflow: hidden; border: 1px solid #353447; border-radius: 14px; color: #e9e5ef; background: #14141d; box-shadow: 0 24px 70px rgba(0, 0, 0, .48); }
.notification-popover > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 14px; border-bottom: 1px solid #292936; }
.notification-popover header small, .notification-popover header strong { display: block; }.notification-popover header small { color: #6f6a7e; font-size: 8px; letter-spacing: .12em; }.notification-popover header strong { margin-top: 3px; font-size: 13px; }
.notification-popover header button { border: 0; color: #9d91c1; background: transparent; font-size: 9px; }
.notification-list { max-height: 330px; overflow-y: auto; }
.notification-list > button { display: grid; width: 100%; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 9px; border: 0; border-bottom: 1px solid #24242f; padding: 11px 13px; color: #cbc6d5; background: transparent; text-align: left; }
.notification-list > button:hover, .notification-list > button:focus-visible { outline: 0; background: #1e1c2a; }.notification-list > button.unread { background: #191625; }
.notification-dot { width: 7px; height: 7px; border-radius: 50%; background: #5dbb86; }.notification-list > button.error .notification-dot { background: #db7180; }
.notification-list strong, .notification-list small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.notification-list strong { font-size: 10px; }.notification-list small { margin-top: 3px; color: #777285; font-size: 9px; }.notification-list time { color: #625e6f; font-size: 8px; white-space: nowrap; }
.notification-empty { padding: 24px 14px; color: #777285; font-size: 10px; text-align: center; }
.subscription-backdrop { position: fixed; z-index: 190; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(4, 4, 8, .78); backdrop-filter: blur(8px); }
.subscription-dialog { width: min(620px, 100%); max-height: min(760px, calc(100vh - 40px)); overflow-y: auto; border: 1px solid #39364b; border-radius: 20px; padding: 22px; color: #edeaf2; background: linear-gradient(145deg, #191823, #101117); box-shadow: 0 34px 100px rgba(0, 0, 0, .62); }
.subscription-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }.subscription-dialog header span { color: #8e7cc6; font-size: 8px; letter-spacing: .18em; }.subscription-dialog h2 { margin-top: 5px; font-size: 22px; }.subscription-dialog header button { border: 0; color: #8f8a99; background: transparent; font-size: 24px; }
.subscription-offer { margin-top: 18px; border: 1px solid #71351f; border-radius: 12px; padding: 12px 14px; background: linear-gradient(135deg, rgba(74, 30, 17, .75), rgba(31, 20, 21, .75)); }.subscription-offer strong { color: #ff8b62; font-size: 12px; }.subscription-offer p { margin-top: 5px; color: #b7a49d; font-size: 10px; line-height: 1.5; }
.subscription-plans { display: grid; gap: 10px; margin-top: 12px; }.subscription-plans article { border: 1px solid #30303e; border-radius: 13px; padding: 15px; background: #12131a; }.subscription-plans article > div { display: flex; justify-content: space-between; gap: 12px; }.subscription-plans h3 { margin: 0; font-size: 15px; }.subscription-plans article > p { margin-top: 6px; color: #8d8899; font-size: 10px; line-height: 1.5; }.subscription-plans ul { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 12px 0; padding: 0; color: #b7b1c4; font-size: 9px; list-style: none; }.subscription-plans li::before { margin-right: 5px; color: #8a73e8; content: '✓'; }.subscription-plans button { width: 100%; border: 1px solid #3b394a; border-radius: 9px; padding: 9px; color: #777382; background: #1b1b24; }.subscription-plans button:disabled { cursor: not-allowed; }
.subscription-note { margin-top: 12px; color: #6f6b79; font-size: 9px; line-height: 1.5; }
:global(html[data-theme='light']) .subscription-button { border-color: #e4a285; color: #65311e; background: linear-gradient(135deg, #fff0e9, #fff8f4); }
:global(html[data-theme='light']) .header-credit-balance, :global(html[data-theme='light']) .notification-button, :global(html[data-theme='light']) .theme-button { border-color: #d9d5e1; color: #6f697b; background: rgba(255, 255, 255, .9); }
:global(html[data-theme='light']) .header-credit-balance strong { color: #2b2732; }
:global(html[data-theme='light']) .notification-button:hover, :global(html[data-theme='light']) .notification-button[aria-expanded="true"], :global(html[data-theme='light']) .theme-button:hover { border-color: #8a79c7; color: #55448c; background: #f1edff; }
:global(html[data-theme='light']) .notification-count { border-color: #fff; }
:global(html[data-theme='light']) .notification-popover { border-color: #d8d4df; color: #292532; background: #fff; box-shadow: 0 24px 70px rgba(53, 45, 67, .2); }
:global(html[data-theme='light']) .notification-popover > header, :global(html[data-theme='light']) .notification-list > button { border-color: #ebe8ef; }
:global(html[data-theme='light']) .notification-list > button { color: #393442; }
:global(html[data-theme='light']) .notification-list > button:hover { background: #f6f3fb; }
:global(html[data-theme='light']) .notification-list > button.unread { background: #f6f2ff; }
:global(html[data-theme='light']) .subscription-backdrop { background: rgba(47, 42, 55, .38); }
:global(html[data-theme='light']) .subscription-dialog { border-color: #d7d1df; color: #292432; background: linear-gradient(145deg, #fff, #f7f5fa); box-shadow: 0 34px 100px rgba(52, 44, 65, .24); }
:global(html[data-theme='light']) .subscription-plans article { border-color: #ded9e5; background: #fff; }
:global(html[data-theme='light']) .subscription-plans button { border-color: #d6d0dc; color: #8b8492; background: #f1eef3; }
@media (max-width: 720px) { .subscription-button { width: 36px; padding: 0; justify-content: center; }.subscription-label { display: none; }.subscription-promo { font-size: 8px; }.header-credit-balance { padding-inline: 9px; }.header-credit-balance span { display: none; }.notification-popover { position: fixed; top: 62px; right: 10px; }.subscription-dialog { padding: 17px; } }
</style>
