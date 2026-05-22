<script lang="ts">
  import { ArrowLeft, StickyNote, Pencil, Check, X, Loader2 } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { MegaNode } from '../mega';
  import { MegaService } from '../mega';
  import { createStreamUrl } from '../stream';

  let { node, onBack } = $props<{
    node: MegaNode;
    onBack: () => void;
  }>();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let streamUrl = $state<string | null>(null);

  let videoEl: HTMLVideoElement | undefined = $state();
  let resolution = $state<string | null>(null);
  let duration = $state<number | null>(null);

  let memo = $state<string | undefined>(untrack(() => node.memo));
  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let textareaEl: HTMLTextAreaElement | undefined = $state();

  $effect(() => {
    memo = node.memo;
  });

  $effect(() => {
    let cleanupFn: (() => void) | null = null;
    let cancelled = false;

    async function start() {
      try {
        loading = true;
        error = null;
        streamUrl = null;
        resolution = null;
        duration = null;
        const { url, cleanup } = await createStreamUrl(node.node);
        if (cancelled) {
          cleanup();
          return;
        }
        cleanupFn = cleanup;
        streamUrl = url;
        loading = false;
      } catch (err: any) {
        console.error('Streaming setup error:', err);
        error = err?.message || 'Failed to start stream';
        loading = false;
      }
    }

    start();

    return () => {
      cancelled = true;
      cleanupFn?.();
    };
  });

  function onLoadedMetadata() {
    if (!videoEl) return;
    resolution = `${videoEl.videoWidth} × ${videoEl.videoHeight}`;
    duration = Number.isFinite(videoEl.duration) ? videoEl.duration : null;
  }

  function formatSize(bytes?: number): string {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  function formatDate(ts?: number): string {
    if (!ts) return '—';
    // megajs File.timestamp is seconds since epoch
    const date = new Date(ts * 1000);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString();
  }

  function formatDuration(sec: number | null): string {
    if (sec == null) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function startEdit() {
    draft = memo ?? '';
    editing = true;
    saveError = null;
    queueMicrotask(() => textareaEl?.focus());
  }

  function cancelEdit() {
    editing = false;
    draft = '';
    saveError = null;
  }

  async function saveMemo() {
    if (saving) return;
    saving = true;
    saveError = null;
    try {
      const next = await MegaService.setMemo(node.node, draft);
      memo = next;
      node.memo = next;
      editing = false;
      draft = '';
    } catch (err) {
      saveError = err instanceof Error ? err.message : 'Failed to save';
    } finally {
      saving = false;
    }
  }

  function memoKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveMemo();
    }
  }
</script>

<div class="flex-1 w-full max-w-[1920px] mx-auto py-6">
  <button
    type="button"
    onclick={onBack}
    class="inline-flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-4 px-3 py-1.5 rounded-full hover:bg-gray-800 transition-colors"
  >
    <ArrowLeft size={16} />
    <span>Back</span>
  </button>

  <div class="w-full bg-black overflow-hidden aspect-video flex items-center justify-center">
    {#if loading}
      <div class="flex flex-col items-center gap-4">
        <div class="w-12 h-12 border-4 border-red-500 border-t-transparent rounded-full animate-spin"></div>
        <p class="text-gray-400 animate-pulse">Preparing stream...</p>
      </div>
    {:else if error}
      <div class="bg-gray-800 p-8 rounded-lg text-center max-w-md border border-red-900/50">
        <p class="text-red-400 mb-4 font-medium">{error}</p>
        <button
          type="button"
          onclick={onBack}
          class="bg-red-600 text-white px-6 py-2 rounded-full hover:bg-red-700 transition-colors"
        >
          Back
        </button>
      </div>
    {:else if streamUrl}
      <video
        bind:this={videoEl}
        src={streamUrl}
        controls
        autoplay
        onloadedmetadata={onLoadedMetadata}
        class="w-full h-full"
      >
        <track kind="captions" />
      </video>
    {/if}
  </div>

  <div class="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
    <div class="lg:col-span-2 space-y-4">
      <h1 class="text-2xl font-semibold text-gray-100 break-words">{node.name}</h1>

      <section class="bg-gray-900/60 border border-gray-800 rounded-lg p-4">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2 text-gray-300 text-sm font-medium">
            <StickyNote size={16} class="text-amber-400" />
            <span>Memo</span>
          </div>
          {#if !editing}
            <button
              type="button"
              onclick={startEdit}
              class="text-gray-400 hover:text-gray-100 text-xs inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-800"
            >
              <Pencil size={12} />
              <span>{memo ? 'Edit' : 'Add'}</span>
            </button>
          {/if}
        </div>

        {#if editing}
          <textarea
            bind:this={textareaEl}
            bind:value={draft}
            onkeydown={memoKey}
            rows="4"
            maxlength="2000"
            placeholder="Add a note…"
            class="w-full bg-gray-950 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:border-red-500"
          ></textarea>
          {#if saveError}
            <p class="text-red-400 text-xs mt-1">{saveError}</p>
          {/if}
          <div class="flex items-center justify-end gap-1 mt-2">
            <button
              type="button"
              onclick={cancelEdit}
              disabled={saving}
              class="text-gray-400 hover:text-gray-200 px-2 py-1 rounded disabled:opacity-50 inline-flex items-center gap-1 text-xs"
            >
              <X size={14} />
              <span>Cancel</span>
            </button>
            <button
              type="button"
              onclick={saveMemo}
              disabled={saving}
              class="text-green-400 hover:text-green-300 px-2 py-1 rounded disabled:opacity-50 inline-flex items-center gap-1 text-xs"
            >
              {#if saving}
                <Loader2 size={14} class="animate-spin" />
              {:else}
                <Check size={14} />
              {/if}
              <span>Save</span>
            </button>
          </div>
        {:else if memo}
          <p class="text-amber-200/90 text-sm whitespace-pre-wrap break-words">{memo}</p>
        {:else}
          <p class="text-gray-500 text-sm italic">No memo yet.</p>
        {/if}
      </section>
    </div>

    <aside class="bg-gray-900/60 border border-gray-800 rounded-lg p-4">
      <h2 class="text-gray-300 text-sm font-medium mb-3">Details</h2>
      <dl class="text-sm space-y-2">
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500">Uploaded</dt>
          <dd class="text-gray-200 text-right">{formatDate(node.node.timestamp)}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500">Resolution</dt>
          <dd class="text-gray-200 text-right">{resolution ?? '—'}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500">Duration</dt>
          <dd class="text-gray-200 text-right">{formatDuration(duration)}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500">Size</dt>
          <dd class="text-gray-200 text-right">{formatSize(node.size)}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-gray-500">Node ID</dt>
          <dd class="text-gray-200 text-right font-mono text-xs break-all">{node.id}</dd>
        </div>
      </dl>
    </aside>
  </div>
</div>
