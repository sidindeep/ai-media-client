<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import { getCodexQuote } from '../api/client';

const studio = useStudioStore();
const sending = ref(false);
const submitError = ref('');
const quote = ref<{ credits: number } | null>(null);
const quoteError = ref('');
const effortOptions = computed(() => studio.currentCodexModel?.efforts || ['low', 'medium', 'high']);
const modelLabel = computed(() => studio.currentCodexModel?.name || 'Модель загружается');

async function refreshQuote() {
  if (!studio.codexModel || !studio.codexEffort) return;
  quoteError.value = '';
  try {
    const result = await getCodexQuote(studio.codexModel, studio.codexEffort, studio.codexSpeed);
    quote.value = result.quote;
    quoteError.value = result.error || '';
  } catch (error) {
    quote.value = null;
    quoteError.value = error instanceof Error ? error.message : 'Цена недоступна';
  }
}

watch(() => [studio.codexModel, studio.codexEffort, studio.codexSpeed], refreshQuote, { immediate: true });

async function submit() {
  sending.value = true;
  submitError.value = '';
  try { await studio.submit(); } catch (error) { submitError.value = error instanceof Error ? error.message : 'Не удалось запустить генерацию'; } finally { sending.value = false; }
}
</script>

<template>
  <section class="composer-card">
    <div class="composer-tabs"><button type="button" :class="{ active: studio.provider === 'codex' }" @click="studio.provider = 'codex'">✦ Изображения</button><button type="button" disabled title="Будет перенесено следующим вертикальным срезом">▣ Медиа</button></div>
    <div class="composer-body">
      <textarea v-model="studio.prompt" maxlength="20000" placeholder="Введите идею для генерации" aria-label="Промпт генерации" @keydown.ctrl.enter="submit"></textarea>
      <p v-if="studio.provider === 'media'" class="notice">Каталог media подключён к тому же API. Поля модели будут перенесены следующим вертикальным срезом.</p>
      <div class="composer-controls">
        <template v-if="studio.provider === 'codex'">
          <label class="select-pill"><span>Модель</span><select v-model="studio.codexModel"><option v-for="model in studio.codexCatalog?.models || []" :key="model.id" :value="model.id">{{ model.name }}</option></select></label>
          <label class="select-pill"><span>Рассуждение</span><select v-model="studio.codexEffort"><option v-for="effort in effortOptions" :key="effort" :value="effort">{{ effort }}</option></select></label>
          <label class="select-pill"><span>Формат</span><select v-model="studio.codexAspectRatio"><option value="auto">Авто</option><option value="1:1">1:1</option><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="3:2">3:2</option><option value="2:3">2:3</option></select></label>
          <label class="select-pill"><span>Скорость</span><select v-model="studio.codexSpeed"><option value="standard">Обычная</option><option value="fast">⚡ Fast</option></select></label>
        </template>
        <span v-if="quote" class="quote">≈ {{ quote.credits.toLocaleString('ru-RU') }} кредитов</span>
        <span v-else-if="quoteError" class="quote error">{{ quoteError }}</span>
        <button class="generate-button" type="button" :disabled="sending || !studio.prompt.trim()" @click="submit">{{ sending ? 'Запуск…' : 'Генерировать' }} <span aria-hidden="true">↗</span></button>
      </div>
      <p v-if="submitError" class="form-error" role="alert">{{ submitError }}</p>
      <p class="composer-hint">Ctrl + Enter — запустить генерацию · {{ modelLabel }}</p>
    </div>
  </section>
</template>
