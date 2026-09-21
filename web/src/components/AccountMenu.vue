<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as api from '../api/client';
import type { Account } from '../types';

const props = defineProps<{ ready: boolean }>();
const emit = defineEmits<{ history: [] }>();
const root = ref<HTMLElement | null>(null);
const account = ref<Account | null>(null);
const menuOpen = ref(false);
const modal = ref<'profile' | 'settings' | 'topup' | null>(null);
const loading = ref(false);
const saving = ref(false);
const status = ref('');
const profileName = ref('');
const autoSave = ref(false);
const concurrency = ref(5);

const isAdmin = computed(() => account.value?.role === 'admin' && account.value.id !== 'local');
const initials = computed(() => account.value?.name.trim().slice(0, 1).toUpperCase() || '•');
const identity = computed(() => {
  if (!account.value) return '';
  return [...account.value.identities.map(item => item.email || `${item.provider}: ${item.subject}`), `ID: ${account.value.id}`].join(' · ');
});
const dialogTitle = computed(() => modal.value === 'profile' ? 'Профиль' : modal.value === 'settings' ? 'Настройки' : 'Пополнение кредитов');

function formatCredits(value?: number) {
  return value === undefined ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);
}

async function loadAccount() {
  if (!props.ready || loading.value) return;
  loading.value = true;
  try {
    account.value = await api.getAccount();
    status.value = '';
  } catch (cause) {
    status.value = cause instanceof Error ? cause.message : 'Не удалось загрузить профиль';
  } finally {
    loading.value = false;
  }
}

async function toggleMenu() {
  if (!props.ready) return;
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) await loadAccount();
}

async function openProfile() {
  await loadAccount();
  if (!account.value) return;
  profileName.value = account.value.name;
  status.value = '';
  menuOpen.value = false;
  modal.value = 'profile';
  await nextTick();
  document.querySelector<HTMLInputElement>('#profileName')?.focus();
}

async function openSettings() {
  status.value = '';
  menuOpen.value = false;
  loading.value = true;
  try {
    const [storage, queue] = await Promise.all([api.getStorageSettings(), api.getQueueStatus()]);
    autoSave.value = storage.autoSave;
    concurrency.value = queue.concurrency;
    modal.value = 'settings';
  } catch (cause) {
    status.value = cause instanceof Error ? cause.message : 'Не удалось загрузить настройки';
    modal.value = 'settings';
  } finally {
    loading.value = false;
  }
}

function openTopup() {
  menuOpen.value = false;
  if (isAdmin.value) {
    window.location.assign('/admin.html#credits');
    return;
  }
  status.value = '';
  modal.value = 'topup';
}

function openHistory() {
  menuOpen.value = false;
  emit('history');
}

async function saveProfile() {
  if (!account.value) return;
  saving.value = true;
  status.value = '';
  try {
    const saved = await api.updateAccountProfile(profileName.value);
    account.value = { ...account.value, name: saved.name };
    profileName.value = saved.name;
    status.value = 'Имя сохранено';
  } catch (cause) {
    status.value = cause instanceof Error ? cause.message : 'Не удалось сохранить имя';
  } finally {
    saving.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  status.value = '';
  try {
    await Promise.all([api.setAutoSave(autoSave.value), api.setConcurrency(concurrency.value)]);
    status.value = 'Настройки сохранены';
  } catch (cause) {
    status.value = cause instanceof Error ? cause.message : 'Не удалось сохранить настройки';
  } finally {
    saving.value = false;
  }
}

async function signOut() {
  status.value = '';
  try {
    await api.logout();
    window.location.assign('/login');
  } catch (cause) {
    status.value = cause instanceof Error ? cause.message : 'Не удалось выйти';
  }
}

function closeModal() {
  modal.value = null;
  status.value = '';
}

function handlePointerDown(event: PointerEvent) {
  if (root.value && !root.value.contains(event.target as Node)) menuOpen.value = false;
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (modal.value) closeModal();
  else menuOpen.value = false;
}

watch(() => props.ready, ready => { if (ready) void loadAccount(); else account.value = null; }, { immediate: true });
onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDown);
  document.addEventListener('keydown', handleKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown);
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div ref="root" class="account-menu">
    <button class="account-trigger" type="button" aria-haspopup="menu" :aria-expanded="menuOpen" :disabled="!ready" @click="toggleMenu">
      <span class="account-avatar" aria-hidden="true">{{ initials }}</span>
      <span class="account-trigger-copy"><strong>{{ account?.name || (ready ? 'Профиль' : 'Подключение…') }}</strong><small>{{ account ? `${formatCredits(account.wallet?.balance)} кредитов` : 'Аккаунт' }}</small></span>
      <span class="account-chevron" aria-hidden="true">⌄</span>
    </button>
    <div v-if="menuOpen" class="account-popover" role="menu">
      <div class="account-summary">
        <span class="account-avatar large" aria-hidden="true">{{ initials }}</span>
        <span><strong>{{ account?.name }}</strong><small>{{ account?.role === 'admin' ? 'Администратор' : 'Пользователь' }}</small></span>
      </div>
      <div class="account-balance"><span>Доступно</span><strong>{{ formatCredits(account?.wallet?.balance) }} кр.</strong></div>
      <button class="account-topup" type="button" role="menuitem" @click="openTopup">＋ Пополнить</button>
      <div class="account-menu-section">
        <button type="button" role="menuitem" @click="openProfile"><span>Профиль</span><small>Имя и входы</small></button>
        <button type="button" role="menuitem" @click="openHistory"><span>История</span><small>Готовые генерации</small></button>
        <button type="button" role="menuitem" @click="openSettings"><span>Настройки</span><small>Хранилище и очередь</small></button>
        <a v-if="isAdmin" class="account-admin-link" href="/admin.html" role="menuitem"><span>Админка</span><small>Аккаунты, кредиты и Codex</small></a>
      </div>
      <button v-if="account?.id !== 'local'" class="account-logout" type="button" role="menuitem" @click="signOut">Выйти</button>
      <p v-if="status" class="account-status" role="status">{{ status }}</p>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="modal" class="account-modal-backdrop" @mousedown.self="closeModal">
      <section class="account-modal" role="dialog" aria-modal="true" :aria-labelledby="'account-dialog-title'">
        <header><div><span class="eyebrow">АККАУНТ</span><h2 id="account-dialog-title">{{ dialogTitle }}</h2></div><button type="button" aria-label="Закрыть" @click="closeModal">×</button></header>
        <form v-if="modal === 'profile'" class="account-form" @submit.prevent="saveProfile">
          <label for="profileName">Отображаемое имя</label>
          <input id="profileName" v-model="profileName" maxlength="200" required>
          <p class="account-identity">{{ identity }}</p>
          <button class="primary-button" type="submit" :disabled="saving">{{ saving ? 'Сохраняем…' : 'Сохранить имя' }}</button>
        </form>
        <form v-else-if="modal === 'settings'" class="account-form" @submit.prevent="saveSettings">
          <label class="account-check"><input v-model="autoSave" type="checkbox"> Сохранять готовые файлы на сервере</label>
          <label for="accountConcurrency">Одновременно генераций</label>
          <select id="accountConcurrency" v-model.number="concurrency"><option v-for="value in 5" :key="value" :value="value">{{ value }}</option></select>
          <button class="primary-button" type="submit" :disabled="saving || loading">{{ saving ? 'Сохраняем…' : 'Сохранить настройки' }}</button>
        </form>
        <div v-else class="account-form"><p>Покупка кредитов пока не подключена. Для пополнения обратитесь к администратору.</p></div>
        <p v-if="status" class="account-modal-status" role="status">{{ status }}</p>
      </section>
    </div>
  </Teleport>
</template>
