import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { ensureServiceWorker, isServiceWorkerSupported } from './lib/stream'

if (isServiceWorkerSupported()) {
  ensureServiceWorker().catch((err) => {
    console.warn('Service Worker registration failed:', err)
  })
}

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
