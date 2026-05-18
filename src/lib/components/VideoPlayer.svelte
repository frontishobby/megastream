<script lang="ts">
  import { X, Maximize, Minimize, Volume2, Play, Pause } from '@lucide/svelte';
  import type { MegaNode } from '../mega';
  
  let { node, onClose } = $props<{ 
    node: MegaNode; 
    onClose: () => void 
  }>();

  let videoElement: HTMLVideoElement;
  let loading = $state(true);
  let error = $state<string | null>(null);
  let streamUrl = $state<string | null>(null);

  $effect(() => {
    async function startStreaming() {
      try {
        loading = true;
        error = null;
        
        // megajs download() returns a stream. 
        // In the browser, we can use it to create a Blob or use a Service Worker.
        // For this demo, we'll try to get a Blob for the first part or the whole file
        // if it's reasonably sized, or just show a message if it's too large.
        
        const stream = node.node.download();
        const reader = stream.getReader();
        const chunks = [];
        
        // This is a naive implementation that loads the whole thing into memory.
        // For real streaming, a Service Worker is needed.
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          
          // Limit to 50MB for this demo to avoid crashing the browser
          const currentSize = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
          if (currentSize > 50 * 1024 * 1024) {
            console.warn('File too large for memory-based streaming, stopping at 50MB');
            break;
          }
        }
        
        const blob = new Blob(chunks, { type: 'video/mp4' }); // Simplified type
        streamUrl = URL.createObjectURL(blob);
        loading = false;
      } catch (err: any) {
        console.error('Streaming error:', err);
        error = err.message || 'Failed to stream video';
        loading = false;
      }
    }

    startStreaming();

    return () => {
      if (streamUrl) URL.revokeObjectURL(streamUrl);
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
        <p class="text-gray-400 animate-pulse">Buffering video from Mega...</p>
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
        bind:this={videoElement}
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
    <p>Tip: Large files are partially buffered for this demo.</p>
  </div>
</div>
