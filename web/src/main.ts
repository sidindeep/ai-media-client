import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles.css';
import { initializeStudioTheme } from './theme';

initializeStudioTheme();
createApp(App).use(createPinia()).mount('#app');
