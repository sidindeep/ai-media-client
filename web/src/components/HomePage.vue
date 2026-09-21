<script setup lang="ts">
defineEmits<{ workspace: [] }>();
</script>

<template>
  <section class="app-home" aria-labelledby="app-home-title">
    <div class="app-home-glow" aria-hidden="true"></div>
    <p class="eyebrow"><span></span> VISUAL AI WORKSPACE</p>
    <h2 id="app-home-title">Идея. Кадр.<br><em>Движение.</em></h2>
    <p class="app-home-lead">Изображения, видео, аудио и тексты в едином рабочем пространстве — без повторной загрузки данных при переходах.</p>
    <button type="button" class="app-home-action" @click="$emit('workspace')">Продолжить в студии <span aria-hidden="true">→</span></button>
    <div class="app-home-features" aria-label="Возможности">
      <article><span>01</span><strong>Создание</strong><p>Современные AI-модели и все параметры генерации в одном интерфейсе.</p></article>
      <article><span>02</span><strong>Организация</strong><p>Чаты, проекты и история остаются готовыми, пока вы перемещаетесь по сервису.</p></article>
      <article><span>03</span><strong>Синхронизация</strong><p>Новые результаты появляются точечно, без перезагрузки всего рабочего пространства.</p></article>
    </div>
  </section>
</template>
