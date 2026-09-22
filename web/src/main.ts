import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles.css';
import { initializeStudioTheme } from './theme';
import { initializeI18n } from './i18n';

initializeI18n();
initializeStudioTheme();
createApp(App).use(createPinia()).mount('#app');
