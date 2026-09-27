<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import * as api from '../api/client';
import type { CommerceOffer, CommerceOrder } from '../api/client';
import { useI18n } from '../i18n';
import type { Account } from '../types';

const props = defineProps<{ view: 'profile' | 'plans'; returnedOrderId?: string }>();
const emit = defineEmits<{ profile: []; plans: []; spending: []; history: [] }>();
const { formatNumber, t } = useI18n();
const account = ref<Account | null>(null);
const offers = ref<CommerceOffer[]>([]);
const orders = ref<CommerceOrder[]>([]);
const selectedOffer = ref<CommerceOffer | null>(null);
const profileName = ref('');
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const status = ref('');
const initials = computed(() => account.value?.name.trim().slice(0, 1).toUpperCase() || '•');
const balance = computed(() => account.value?.wallet?.balance);
const primaryIdentity = computed(() => account.value?.identities.find(identity => identity.email)?.email
  || account.value?.identities[0]?.provider || '');

function credits(value: number | undefined) {
  return value === undefined ? '—' : formatNumber(value, { maximumFractionDigits: 3 });
}

function money(offer: CommerceOffer) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: offer.currency }).format(offer.amountMinor / 100);
}

function orderStatus(order: CommerceOrder) {
  if (order.status === 'fulfilled') return t('subscription.completed');
  if (order.status === 'payment_failed') return t('subscription.failed');
  if (!order.paymentId) return t('subscription.orderCreated');
  return order.checkoutMode === 'stub' ? t('subscription.stubPending') : t('subscription.pending');
}

async function load() {
  loading.value = true;
  error.value = '';
  const [accountResult, offersResult, ordersResult] = await Promise.allSettled([
      api.getAccount(), api.getCommerceOffers(), api.listCommerceOrders(),
    ]);
  if (accountResult.status === 'fulfilled') {
    account.value = accountResult.value;
    profileName.value = accountResult.value.name;
  } else {
    error.value = accountResult.reason instanceof Error ? accountResult.reason.message : t('account.loadProfileError');
  }
  offers.value = offersResult.status === 'fulfilled' ? offersResult.value : [];
  orders.value = ordersResult.status === 'fulfilled' ? ordersResult.value : [];
  if (props.view === 'plans' && offersResult.status === 'rejected') error.value = t('subscription.unavailable');
  try {
    if (props.returnedOrderId && /^[a-f0-9-]{36}$/.test(props.returnedOrderId)) {
      const returned = await api.getCommerceOrder(props.returnedOrderId);
      orders.value = [returned, ...orders.value.filter(order => order.id !== returned.id)];
      status.value = orderStatus(returned);
      if (returned.status === 'fulfilled' || returned.status === 'payment_failed') {
        sessionStorage.removeItem(`ai-media-checkout:${returned.offer.id}:${returned.offer.version}`);
      }
      if (returned.status === 'fulfilled') {
        account.value = await api.getAccount();
        window.dispatchEvent(new Event('ai-media-account-updated'));
      }
    }
  } catch (cause) {
    status.value = cause instanceof Error ? cause.message : t('subscription.unavailable');
  } finally {
    loading.value = false;
  }
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
    window.dispatchEvent(new Event('ai-media-account-updated'));
  } catch (cause) {
    status.value = cause instanceof Error ? cause.message : t('account.saveNameError');
  } finally {
    saving.value = false;
  }
}

watch(() => props.view, () => { selectedOffer.value = null; status.value = ''; void load(); });
onMounted(() => { void load(); });
</script>

<template>
  <section class="commerce-shell" :aria-label="view === 'plans' ? t('commerce.plans') : t('account.profile')">
    <aside class="commerce-rail">
      <nav :aria-label="t('commerce.accountSections')">
        <button type="button" :class="{ active: view === 'profile' }" :aria-current="view === 'profile' ? 'page' : undefined" @click="emit('profile')"><span aria-hidden="true">●</span>{{ t('account.profile') }}</button>
        <button type="button" :class="{ active: view === 'plans' }" :aria-current="view === 'plans' ? 'page' : undefined" @click="emit('plans')"><span aria-hidden="true">◈</span>{{ t('commerce.plans') }}</button>
        <button type="button" @click="emit('plans')"><span aria-hidden="true">ϟ</span>{{ t('commerce.buyCredits') }}</button>
        <button type="button" @click="emit('spending')"><span aria-hidden="true">◷</span>{{ t('commerce.creditHistory') }}</button>
        <button type="button" @click="emit('history')"><span aria-hidden="true">▣</span>{{ t('navigation.history') }}</button>
      </nav>
      <div class="commerce-rail-balance"><span>{{ t('account.available') }}</span><strong>{{ credits(balance) }} {{ t('common.creditsShort') }}</strong></div>
    </aside>

    <div class="commerce-content">
      <header class="commerce-heading"><div><span class="eyebrow">AI MEDIA CLIENT</span><h2>{{ view === 'plans' ? t('commerce.plans') : t('account.profile') }}</h2></div><span v-if="view === 'plans'" class="commerce-heading-note">{{ t('commerce.oneTime') }}</span></header>
      <p v-if="error" class="commerce-feedback" role="alert">{{ error }} <button type="button" @click="load">{{ t('common.retry') }}</button></p>
      <p v-if="loading && !account" class="commerce-feedback" role="status">{{ t('common.loading') }}</p>

      <template v-if="view === 'plans'">
        <div v-if="offers.length" class="commerce-cards">
          <article v-for="offer in offers" :key="`${offer.id}:${offer.version}`" class="commerce-card" :class="{ selected: selectedOffer?.id === offer.id }">
            <div class="commerce-card-top"><span class="commerce-card-mark">✦</span></div>
            <h3>{{ offer.name }}</h3>
            <div class="commerce-credit-count"><strong>{{ credits(offer.creditUnits / 1000) }}</strong><span>{{ t('common.creditsShort') }}</span></div>
            <p>{{ offer.description }}</p>
            <ul><li>{{ t('subscription.feature.balance') }}</li><li>{{ t('subscription.feature.models') }}</li></ul>
            <div class="commerce-card-bottom"><strong>{{ money(offer) }}</strong><small>{{ t('commerce.oneTime') }}</small></div>
            <button type="button" :disabled="loading" @click="selectedOffer = offer">{{ t('subscription.selectPackage') }}</button>
          </article>
        </div>
        <p v-else-if="!loading && !error" class="commerce-feedback">{{ t('subscription.unavailable') }}</p>
        <section v-if="selectedOffer" class="commerce-checkout" aria-labelledby="commerce-checkout-title">
          <div><span class="eyebrow">{{ t('subscription.paymentEyebrow') }}</span><h3 id="commerce-checkout-title">{{ selectedOffer.name }} · {{ money(selectedOffer) }}</h3><p>{{ t('subscription.creditCount', { count: credits(selectedOffer.creditUnits / 1000) }) }}</p></div>
          <p>{{ t('subscription.paymentUnavailable') }}</p>
          <button type="button" @click="selectedOffer = null">{{ t('subscription.backToPackages') }}</button>
        </section>
        <p v-if="status" class="commerce-feedback" role="status">{{ status }}</p>
        <p v-else-if="orders[0]" class="commerce-feedback">{{ t('subscription.lastOrder', { name: orders[0].offer.name }) }} · {{ orderStatus(orders[0]) }}</p>
      </template>

      <template v-else-if="account">
        <section class="commerce-identity-card"><span class="commerce-avatar" aria-hidden="true">{{ initials }}</span><div><h3>{{ account.name }}</h3><p>{{ primaryIdentity }}</p></div></section>
        <section class="commerce-overview"><div><span>{{ t('commerce.currentAccess') }}</span><strong>{{ account.starterPack?.active ? t('commerce.starterAccess') : t('commerce.noSubscription') }}</strong><p v-if="account.starterPack?.active">{{ t('subscription.starterHint') }}</p><button type="button" @click="emit('plans')">{{ t('commerce.viewPackages') }}</button></div><div><span>{{ t('commerce.creditBalance') }}</span><strong>{{ credits(balance) }} <small>{{ t('common.creditsShort') }}</small></strong><p>{{ t('commerce.balanceHint') }}</p><button type="button" class="commerce-secondary-action" @click="emit('spending')">{{ t('commerce.creditHistory') }}</button></div></section>
        <div class="commerce-profile-grid"><section class="commerce-panel"><h3>{{ t('commerce.profileDetails') }}</h3><form @submit.prevent="saveProfile"><label for="commerce-profile-name">{{ t('account.displayName') }}</label><div class="commerce-name-field"><input id="commerce-profile-name" v-model="profileName" maxlength="200" required><button type="submit" :disabled="saving">{{ saving ? t('common.saving') : t('account.saveName') }}</button></div></form><p v-if="status" role="status">{{ status }}</p><small>ID: {{ account.id }}</small></section><section class="commerce-panel"><h3>{{ t('commerce.signIns') }}</h3><ul><li v-for="identity in account.identities" :key="`${identity.provider}:${identity.subject}`"><strong>{{ identity.provider }}</strong><span>{{ identity.email || identity.subject }}</span></li></ul></section></div>
        <section v-if="orders.length" class="commerce-panel commerce-orders"><h3>{{ t('commerce.orders') }}</h3><div v-for="order in orders.slice(0, 3)" :key="order.id"><strong>{{ order.offer.name }}</strong><span>{{ orderStatus(order) }}</span></div></section>
      </template>
    </div>
  </section>
</template>

<style scoped>
.commerce-shell { display: grid; grid-template-columns: minmax(205px, 245px) minmax(0, 1fr); gap: clamp(22px, 3vw, 46px); min-height: 100%; color: #f4f0f8; }
.commerce-rail { display: flex; align-self: start; flex-direction: column; gap: 24px; border: 1px solid #343244; border-radius: 20px; padding: 18px; background: #171721; }
.commerce-rail nav { display: grid; gap: 5px; }.commerce-rail nav button { display: flex; align-items: center; gap: 13px; border: 0; border-radius: 10px; padding: 12px; color: #bbb5c8; background: transparent; text-align: left; font-size: 13px; }.commerce-rail nav button span { width: 20px; color: #a390db; text-align: center; font-size: 18px; }.commerce-rail nav button:hover, .commerce-rail nav button.active { color: #fff; background: #2d2436; }.commerce-rail nav button.active span { color: #f16b3c; }
.commerce-rail-balance { display: grid; gap: 5px; border-top: 1px solid #343244; padding: 17px 12px 4px; }.commerce-rail-balance span { color: #a39ba9; font-size: 11px; }.commerce-rail-balance strong { font-size: 20px; }
.commerce-content { min-width: 0; padding-bottom: 30px; }.commerce-heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 24px; }.commerce-heading .eyebrow, .commerce-checkout .eyebrow { color: #f07549; font-size: 9px; letter-spacing: .16em; }.commerce-heading h2 { margin: 4px 0 0; font-size: clamp(26px, 3vw, 38px); }.commerce-heading-note { color: #aaa2b5; font-size: 12px; }
.commerce-promo { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; border: 1px solid #884329; border-radius: 12px; padding: 12px 17px; background: #2b1a1b; font-size: 12px; }.commerce-promo strong { color: #ff8658; }.commerce-promo span { color: #c2abb0; }
.commerce-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }.commerce-card { display: flex; min-height: 385px; flex-direction: column; border: 1px solid #565060; border-radius: 18px; padding: 24px; background: #1b1a25; }.commerce-card.selected { border-color: #f16b3c; }.commerce-card-top { display: flex; height: 28px; align-items: center; justify-content: space-between; }.commerce-card-mark { color: #f47544; font-size: 25px; }.commerce-popular { border-radius: 999px; padding: 5px 10px; color: #2b1b17; background: #ffc9a7; font-size: 10px; font-weight: 750; }.commerce-card h3 { margin: 8px 0 10px; font-size: clamp(24px, 2.4vw, 34px); }.commerce-credit-count { display: flex; align-items: baseline; gap: 7px; border: 1px solid #66555a; border-radius: 8px; padding: 9px 12px; color: #ff995e; background: #33231f; }.commerce-credit-count strong { font-size: 17px; }.commerce-credit-count span { font-size: 11px; }.commerce-card p { margin: 16px 0 8px; color: #d1cbd4; font-size: 12px; line-height: 1.5; }.commerce-card ul { display: grid; gap: 6px; margin: 0 0 20px; padding: 0; color: #a9a2af; font-size: 11px; list-style: none; }.commerce-card li::before { margin-right: 6px; color: #f47544; content: '+'; }.commerce-card-bottom { display: flex; align-items: baseline; gap: 9px; margin-top: auto; padding-bottom: 16px; }.commerce-card-bottom strong { font-size: 29px; }.commerce-card-bottom small { color: #a9a2af; font-size: 11px; }.commerce-card > button, .commerce-overview button, .commerce-name-field button { border: 0; border-radius: 8px; padding: 11px 15px; color: white; background: #e94e20; font-size: 12px; font-weight: 700; }.commerce-card > button:hover, .commerce-overview button:hover, .commerce-name-field button:hover { background: #fa6535; }
.commerce-checkout, .commerce-panel { border: 1px solid #393544; border-radius: 15px; padding: 22px; background: #1d1b25; }.commerce-checkout { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-top: 22px; }.commerce-checkout > div { flex: 1 1 210px; }.commerce-checkout h3 { margin: 4px 0; }.commerce-checkout p { margin: 0; color: #a9a2af; font-size: 12px; }.commerce-checkout > p { flex: 1 1 100%; }.commerce-checkout button { border: 1px solid #62536a; border-radius: 8px; padding: 8px 12px; color: #ddd1eb; background: transparent; }.commerce-feedback { margin: 16px 0; color: #c4b8c5; font-size: 12px; line-height: 1.5; }.commerce-feedback button { border: 0; color: #ff8b62; background: transparent; }
.commerce-identity-card { display: flex; align-items: center; gap: 20px; border-radius: 15px; padding: 24px; background: linear-gradient(115deg, #3b2927, #28202a); }.commerce-avatar { display: grid; width: 78px; height: 78px; flex: 0 0 78px; place-items: center; border-radius: 12px; color: white; background: #007d8f; font-size: 42px; }.commerce-identity-card h3 { margin: 0; font-size: 30px; }.commerce-identity-card p { margin: 8px 0 0; color: #d4c1bf; font-size: 13px; overflow-wrap: anywhere; }
.commerce-overview { display: grid; grid-template-columns: 1fr 1fr; gap: 0; margin-top: 18px; border: 1px solid #453a41; border-radius: 15px; padding: 25px; background: #211d25; }.commerce-overview > div { display: flex; min-height: 145px; flex-direction: column; align-items: flex-start; }.commerce-overview > div + div { border-left: 1px solid #a94c2e; padding-left: 28px; }.commerce-overview span { color: #aaa0ad; font-size: 12px; }.commerce-overview strong { margin-top: 7px; font-size: 29px; }.commerce-overview strong small { font-size: 13px; }.commerce-overview p { margin: 5px 0 12px; color: #a99fa9; font-size: 11px; }.commerce-overview button { margin-top: auto; }.commerce-overview .commerce-secondary-action { border: 1px solid #765a67; background: transparent; }
.commerce-profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 18px; }.commerce-panel h3 { margin: 0 0 18px; font-size: 19px; }.commerce-panel form { display: grid; gap: 8px; }.commerce-panel label, .commerce-panel small { color: #a9a2af; font-size: 11px; }.commerce-name-field { display: flex; gap: 8px; }.commerce-name-field input { width: 100%; min-width: 0; border: 1px solid #554c5b; border-radius: 8px; padding: 10px; color: #fff; background: #12121a; }.commerce-panel p { color: #d6b5c1; font-size: 12px; }.commerce-panel > small { display: block; margin-top: 20px; overflow-wrap: anywhere; }.commerce-panel ul { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }.commerce-panel li { display: grid; gap: 4px; overflow-wrap: anywhere; font-size: 12px; }.commerce-panel li span { color: #a9a2af; }.commerce-orders { margin-top: 18px; }.commerce-orders > div { display: flex; justify-content: space-between; gap: 15px; border-top: 1px solid #3b3644; padding: 11px 0; font-size: 12px; }.commerce-orders span { color: #b7aebd; }
/* The account area follows the warm, full-page treatment of the supplied references. */
.commerce-shell { color: #271f20; }
.commerce-rail, .commerce-card, .commerce-panel, .commerce-checkout { border-color: #c5b3a7; color: #271f20; background: #e8ddcd; }
.commerce-rail nav button { color: #332a2b; }.commerce-rail nav button:hover, .commerce-rail nav button.active { color: #e94e20; background: #f4e9dc; }
.commerce-rail-balance { border-color: #c5b3a7; }.commerce-rail-balance span, .commerce-card ul, .commerce-card-bottom small, .commerce-checkout p, .commerce-panel label, .commerce-panel small, .commerce-panel li span, .commerce-orders span, .commerce-heading-note { color: #66585a; }
.commerce-card p, .commerce-identity-card p, .commerce-overview p, .commerce-feedback { color: #584a4a; }
.commerce-credit-count { border-color: #ad8b78; color: #5b2a1b; background: #f8b36c; }
.commerce-identity-card { color: #251d1e; background: #e5d2b8; }
.commerce-overview { border-color: #c5b3a7; color: #271f20; background: #e8ddcd; }.commerce-overview span { color: #765d5d; }
.commerce-name-field input { border-color: #b9a79f; color: #271f20; background: #fffaf4; }
.commerce-checkout button { border-color: #ae8f83; color: #70351f; }.commerce-card.selected { border-color: #e94e20; }.commerce-overview .commerce-secondary-action { color: #70351f; }
@media (max-width: 1000px) { .commerce-shell { grid-template-columns: 1fr; }.commerce-rail nav { grid-template-columns: repeat(5, minmax(0, 1fr)); }.commerce-rail nav button { justify-content: center; flex-wrap: wrap; gap: 4px; text-align: center; }.commerce-rail-balance { display: none; } }
@media (max-width: 720px) { .commerce-rail nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }.commerce-cards, .commerce-profile-grid { grid-template-columns: 1fr; }.commerce-overview { grid-template-columns: 1fr; gap: 20px; }.commerce-overview > div + div { border-top: 1px solid #a94c2e; border-left: 0; padding: 20px 0 0; }.commerce-heading { align-items: flex-start; flex-direction: column; }.commerce-promo { align-items: flex-start; flex-direction: column; }.commerce-name-field { flex-direction: column; } }
</style>
