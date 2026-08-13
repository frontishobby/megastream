<script lang="ts">
  import { probeLabeler, labelerUrl } from '../labeler';

  // null = probe in flight (first check), boolean = last known state.
  let online = $state<boolean | null>(null);
  let checking = $state(false);

  async function check() {
    if (checking) return;
    checking = true;
    try {
      online = await probeLabeler();
    } finally {
      checking = false;
    }
  }

  $effect(() => {
    check();
    const timer = setInterval(check, 30000);
    return () => clearInterval(timer);
  });

  const label = $derived(
    online === null ? 'Checking…' : online ? 'Scene AI online' : 'Scene AI offline'
  );
</script>

<button
  type="button"
  onclick={check}
  title={`Scene labeler at ${labelerUrl()} — click to re-check`}
  class="hidden md:flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 bg-gray-800/60 hover:bg-gray-800 px-2.5 py-1.5 rounded-full transition-colors"
>
  <span
    class="w-2 h-2 rounded-full {online
      ? 'bg-emerald-400'
      : online === null || checking
        ? 'bg-gray-500 animate-pulse'
        : 'bg-gray-600'}"
  ></span>
  <span>{label}</span>
</button>
