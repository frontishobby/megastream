<script lang="ts">
  import { X } from '@lucide/svelte';
  import type { MegaNode } from '../mega';
  import { createStreamUrl } from '../stream';

  let { node, onClose } = $props<{
    node: MegaNode;
    onClose: () => void;
  }>();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let streamUrl = $state<string | null>(null);

  $effect(() => {
    let cleanupFn: (() => void) | null = null;
    let cancelled = false;

    async function start() {
      try {
        loading = true;
        error = null;
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
</script>

<div class="fixed inset-0 bg-black/90 z-50 flex flex-col">
  <div class="flex items-center justify-between p-4 bg-gray-900">
    <h2 class="text-white font-medium truncate flex-1 mr-4">{node.name}</h2>
    <button
      onclick={onClose}
      class="text-gray-400 hover:text-white p-2 rounded-full hover:bg-gray-800 transition-colors"
    >
      <X size={24} />
    </button>
  </div>

  <div class="flex-1 flex items-center justify-center relative group">
    {#if loading}
      <div class="flex flex-col items-center gap-4">
        <div class="w-12 h-12 border-4 border-red-500 border-t-transparent rounded-full animate-spin"></div>
        <p class="text-gray-400 animate-pulse">Preparing stream...</p>
      </div>
    {:else if error}
      <div class="bg-gray-800 p-8 rounded-lg text-center max-w-md border border-red-900/50">
        <p class="text-red-400 mb-4 font-medium">{error}</p>
        <button
          onclick={onClose}
          class="bg-red-600 text-white px-6 py-2 rounded-full hover:bg-red-700 transition-colors"
        >
          Close Player
        </button>
      </div>
    {:else if streamUrl}
      <video
        src={streamUrl}
        controls
        autoplay
        class="max-w-full max-h-full shadow-2xl"
      >
        <track kind="captions" />
      </video>
    {/if}
  </div>

  <div class="p-4 bg-gray-900 text-gray-400 text-sm flex justify-center">
    <p>Streaming via Service Worker · Seekable</p>
  </div>
</div>
