<script setup lang="ts">
import { computed } from 'vue';
import { useStudioStore } from '../stores/studio';

const studio = useStudioStore();
const labels: Record<string, string> = { success: 'Готово', fail: 'Ошибка', unknown: 'Статус уточняется', running: 'Генерация', generating: 'Генерация', queued: 'В очереди' };
const resultText = computed(() => studio.selected?.output || studio.selected?.error || 'Результат появится здесь после завершения задачи');
</script>

<template>
  <section class="result-card">
    <div class="panel-heading"><div><span class="eyebrow">РЕЗУЛЬТАТ</span><h2>{{ studio.selected ? labels[studio.selected.state] || studio.selected.state : 'Последняя генерация' }}</h2></div><span class="result-meta">{{ studio.selected?.modelName || studio.selected?.modelId || 'Текущая задача' }}</span></div>
    <div v-if="studio.selected?.localFiles?.length" class="result-media"><img v-for="file in studio.selected.localFiles" :key="file.previewUrl || file.url" :src="file.previewUrl || file.url" alt="Результат генерации" /></div>
    <pre v-if="studio.selected?.output" class="result-output">{{ studio.selected.output }}</pre>
    <p v-else class="result-placeholder">{{ resultText }}</p>
    <div v-if="studio.selected" class="result-footer"><span>{{ studio.selected.input?.prompt || 'Без промпта' }}</span><span>{{ studio.selected.createdAt ? new Date(studio.selected.createdAt).toLocaleString('ru-RU') : '' }}</span></div>
  </section>
</template>
