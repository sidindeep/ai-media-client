<script setup lang="ts">
import { useI18n, type Locale } from '../i18n';

const { locale, setLocale, t } = useI18n();
</script>

<template>
  <label class="locale-switcher">
    <span class="visually-hidden">{{ t('language.label') }}</span>
    <select :value="locale" :aria-label="t('language.label')" @change="setLocale(($event.target as HTMLSelectElement).value as Locale)">
      <option value="ru">RU</option>
      <option value="en">EN</option>
    </select>
  </label>
</template>
