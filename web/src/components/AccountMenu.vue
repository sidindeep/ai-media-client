<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as api from '../api/client';
import { useI18n } from '../i18n';
import type { Account } from '../types';

const props = defineProps<{ ready: boolean }>();
const { formatNumber, t } = useI18n();
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
const dialogTitle = computed(() => modal.value === 'profile' ? t('account.profile') : modal.value === 'settings' ? t('account.settings') : t('account.topUpTitle'));

function formatCredits(value?: number) {
  return value === undefined ? '—' : formatNumber(value, { maximumFractionDigits: 3 });
}

async function loadAccount() {
  if (!props.ready || loading.value) return;
  loading.value = true;
  try {
    account.value = await api.getAccount();
    status.value = '';
  } catch (cause) {
    status.value = cause instanceof Error ? cause.message : t('account.loadProfileError');
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
    status.value = cause instanceof Error ? cause.message : t('account.loadSettingsError');
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
  window.dispatchEvent(new CustomEvent('ai-media-open-commerce'));
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
    status.value = t('account.nameSaved');
  } catch (cause) {
    status.value = cause instanceof Error ? cause.message : t('account.saveNameError');
  } finally {
    saving.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  status.value = '';
  try {
    await Promise.all([api.setAutoSave(autoSave.value), api.setConcurrency(concurrency.value)]);
    status.value = t('account.settingsSaved');
  } catch (cause) {
    status.value = cause instanceof Error ? cause.message : t('account.saveSettingsError');
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
    status.value = cause instanceof Error ? cause.message : t('account.signOutError');
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
      <span class="account-trigger-copy"><strong>{{ account?.name || (ready ? t('account.profile') : t('account.connecting')) }}</strong><small>{{ account ? t('common.credits', { count: formatCredits(account.wallet?.balance) }) : t('common.account') }}</small></span>
      <span class="account-chevron" aria-hidden="true">⌄</span>
    </button>
    <div v-if="menuOpen" class="account-popover" role="menu">
      <div class="account-summary">
        <span class="account-avatar large" aria-hidden="true">{{ initials }}</span>
        <span><strong>{{ account?.name }}</strong><small>{{ account?.role === 'admin' ? t('common.admin') : t('common.user') }}</small></span>
      </div>
      <div class="account-balance"><span>{{ t('account.available') }}</span><strong>{{ formatCredits(account?.wallet?.balance) }} {{ t('common.creditsShort') }}</strong></div>
      <button class="account-topup" type="button" role="menuitem" @click="openTopup">＋ {{ t('account.topUp') }}</button>
      <div class="account-menu-section">
        <button type="button" role="menuitem" @click="openProfile"><span>{{ t('account.profile') }}</span><small>{{ t('account.profileHint') }}</small></button>
        <button type="button" role="menuitem" @click="openHistory"><span>{{ t('navigation.history') }}</span><small>{{ t('account.historyHint') }}</small></button>
        <button type="button" role="menuitem" @click="openSettings"><span>{{ t('account.settings') }}</span><small>{{ t('account.settingsHint') }}</small></button>
        <a v-if="isAdmin" class="account-admin-link" href="/admin.html" role="menuitem"><span>{{ t('account.adminPanel') }}</span><small>{{ t('account.adminPanelHint') }}</small></a>
      </div>
      <button v-if="account?.id !== 'local'" class="account-logout" type="button" role="menuitem" @click="signOut">{{ t('account.signOut') }}</button>
      <p v-if="status" class="account-status" role="status">{{ status }}</p>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="modal" class="account-modal-backdrop" @mousedown.self="closeModal">
      <section class="account-modal" role="dialog" aria-modal="true" :aria-labelledby="'account-dialog-title'">
        <header><div><span class="eyebrow">{{ t('account.dialogEyebrow') }}</span><h2 id="account-dialog-title">{{ dialogTitle }}</h2></div><button type="button" :aria-label="t('common.close')" @click="closeModal">×</button></header>
        <form v-if="modal === 'profile'" class="account-form" @submit.prevent="saveProfile">
          <label for="profileName">{{ t('account.displayName') }}</label>
          <input id="profileName" v-model="profileName" maxlength="200" required>
          <p class="account-identity">{{ identity }}</p>
          <button class="primary-button" type="submit" :disabled="saving">{{ saving ? t('common.saving') : t('account.saveName') }}</button>
        </form>
        <form v-else-if="modal === 'settings'" class="account-form" @submit.prevent="saveSettings">
          <label class="account-check"><input v-model="autoSave" type="checkbox"> {{ t('account.autoSave') }}</label>
          <label for="accountConcurrency">{{ t('account.concurrency') }}</label>
          <select id="accountConcurrency" v-model.number="concurrency"><option v-for="value in 5" :key="value" :value="value">{{ value }}</option></select>
          <button class="primary-button" type="submit" :disabled="saving || loading">{{ saving ? t('common.saving') : t('account.saveSettings') }}</button>
        </form>
        <div v-else class="account-form"><p>{{ t('account.topUpUnavailable') }}</p></div>
        <p v-if="status" class="account-modal-status" role="status">{{ status }}</p>
      </section>
    </div>
  </Teleport>
</template>
