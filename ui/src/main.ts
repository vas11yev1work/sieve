import { createApp, defineAsyncComponent } from 'vue';
import App from './App.vue';
import './styles.css';

// The inbox server serves the same UI at /inbox; run servers serve it at /.
const root = location.pathname.startsWith('/inbox') ? defineAsyncComponent(() => import('./inbox/InboxApp.vue')) : App;
createApp(root).mount('#app');
