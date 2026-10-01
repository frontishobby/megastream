<script lang="ts">
  import { onMount } from 'svelte';
  import { RefreshCw, Captions } from '@lucide/svelte';
  import { fetchLabelerHealth, labelerUrl, type LabelerHealth } from '../labeler';
  import {
    SUBTITLE_LANGS,
    loadSubtitleSettings,
    saveSubtitleSettings,
    type SubtitleSettings,
  } from '../subtitles.svelte';

  // undefined = probe in flight (first check), null = offline.
  let health = $state<LabelerHealth | null | undefined>(undefined);
  let checking = $state(false);
  let open = $state(false);
  let rootEl: HTMLDivElement | undefined = $state();
  let settings = $state<SubtitleSettings>(loadSubtitleSettings());

  const online = $derived(health === undefined ? null : health !== null);

  async function check() {
    if (checking) return;
    checking = true;
    try {
      health = await fetchLabelerHealth();
    } finally {
      checking = false;
    }
  }

  // onMount, not $effect: check() reads/writes the state above, and inside
  // an $effect those reads become dependencies — every probe would re-run
  // the effect and spam /health in a loop.
  onMount(() => {
    check();
    const timer = setInterval(check, 30000);
    return () => clearInterval(timer);
  });

  function toggle() {
    open = !open;
    if (open) {
      settings = loadSubtitleSettings();
      check();
    }
  }

  function persist() {
    saveSubtitleSettings(settings);
  }

  function onWindowClick(e: MouseEvent) {
    if (open && rootEl && !rootEl.contains(e.target as Node)) open = false;
  }

  function onWindowKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape') open = false;
  }

  const label = $derived(
    online === null ? 'Checking…' : online ? 'Scene AI online' : 'Scene AI offline'
  );
  const sameLanguage = $derived(settings.target !== 'none' && settings.source === settings.target);
  const langs = Object.entries(SUBTITLE_LANGS);
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

<div bind:this={rootEl} class="relative hidden md:block">
  <button
    type="button"
    onclick={toggle}
    title={`Scene AI at ${labelerUrl()} — settings`}
    aria-expanded={open}
    class="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 bg-gray-800/60 hover:bg-gray-800 px-2.5 py-1.5 rounded-full transition-colors"
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

  {#if open}
    <div
      class="absolute right-0 top-full mt-2 w-72 z-20 bg-gray-900 border border-gray-800 rounded-xl shadow-2xl p-4 text-sm"
      role="dialog"
      aria-label="Scene AI settings"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="text-gray-200 font-medium">{label}</p>
          <p class="text-gray-500 text-xs truncate">{labelerUrl()}</p>
        </div>
        <button
          type="button"
          onclick={check}
          disabled={checking}
          class="text-gray-500 hover:text-gray-200 p-1.5 rounded-full hover:bg-gray-800 disabled:opacity-50"
          title="Re-check"
          aria-label="Re-check"
        >
          <RefreshCw size={14} class={checking ? 'animate-spin' : ''} />
        </button>
      </div>

      {#if health && !health.subtitles}
        <p class="mt-3 text-amber-300/90 text-xs">
          This server predates subtitles — restart run.bat to update it.
        </p>
      {/if}

      <div class="mt-4 pt-3 border-t border-gray-800 space-y-3">
        <div class="flex items-center gap-2 text-gray-300 font-medium">
          <Captions size={15} class="text-sky-400" />
          <span>Subtitles</span>
        </div>
        <label class="flex items-center justify-between gap-3">
          <span class="text-gray-400 text-xs">Spoken language</span>
          <select
            bind:value={settings.source}
            onchange={persist}
            class="bg-gray-800 text-gray-100 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-500"
          >
            <option value="auto">Auto-detect</option>
            {#each langs as [code, name] (code)}
              <option value={code}>{name}</option>
            {/each}
          </select>
        </label>
        <label class="flex items-center justify-between gap-3">
          <span class="text-gray-400 text-xs">Also translate to</span>
          <select
            bind:value={settings.target}
            onchange={persist}
            class="bg-gray-800 text-gray-100 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-500"
          >
            <option value="none">None</option>
            {#each langs as [code, name] (code)}
              <option value={code}>{name}</option>
            {/each}
          </select>
        </label>
        <p class="text-gray-500 text-[11px] leading-relaxed">
          {#if sameLanguage}
            Same as the spoken language — no translation will run.
          {:else}
            A translated track is added only when the spoken language differs.
          {/if}
        </p>
        {#if health?.subtitles}
          <p class="text-gray-600 text-[11px] break-all">
            {health.subtitles.whisper} · {health.subtitles.translate ?? 'translation off'}
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>
