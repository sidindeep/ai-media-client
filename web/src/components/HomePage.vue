<script setup lang="ts">
import { useI18n } from '../i18n';

defineEmits<{ workspace: [] }>();
const { t } = useI18n();
</script>

<template>
  <section class="app-home" aria-labelledby="app-home-title">
    <div class="app-home-glow" aria-hidden="true"></div>
    <p class="eyebrow"><span></span> {{ t('home.eyebrow') }}</p>
    <h2 id="app-home-title" v-html="t('home.title')"></h2>
    <p class="app-home-lead">{{ t('home.lead') }}</p>
    <button type="button" class="app-home-action" @click="$emit('workspace')">{{ t('home.continue') }} <span aria-hidden="true">→</span></button>
    <div class="app-home-features" :aria-label="t('home.capabilities')">
      <article><span>01</span><strong>{{ t('home.creation') }}</strong><p>{{ t('home.creationText') }}</p></article>
      <article><span>02</span><strong>{{ t('home.organization') }}</strong><p>{{ t('home.organizationText') }}</p></article>
      <article><span>03</span><strong>{{ t('home.sync') }}</strong><p>{{ t('home.syncText') }}</p></article>
    </div>
  </section>
</template>
