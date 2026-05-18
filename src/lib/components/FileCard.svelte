<script lang="ts">
  import { File, Folder, Play } from '@lucide/svelte';
  import type { MegaNode } from '../mega';
  import { MegaService } from '../mega';
  import { getThumbnail } from '../thumbnails';

  let { node, onSelect } = $props<{
    node: MegaNode;
    onSelect: (node: MegaNode) => void;
  }>();

  const isVideo = $derived(node.type === 'file' && MegaService.isVideo(node.name));

  let cardEl: HTMLButtonElement | undefined = $state();
  let thumbnail = $state<string | null>(null);
  let thumbnailLoading = $state(false);

  function formatSize(bytes?: number) {
    if (!bytes) return 'N/A';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  $effect(() => {
    if (!isVideo || !cardEl) return;
    let cancelled = false;
    const el = cardEl;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer.disconnect();
            if (cancelled) return;
            thumbnailLoading = true;
            getThumbnail(node.id, node.node)
              .then((url) => {
                if (cancelled) return;
                thumbnail = url;
              })
              .finally(() => {
                if (!cancelled) thumbnailLoading = false;
              });
          }
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  });
</script>

<button
  type="button"
  bind:this={cardEl}
  class="w-full text-left bg-gray-800 rounded-lg overflow-hidden hover:bg-gray-700 transition-colors cursor-pointer group border border-gray-700 flex flex-col"
  onclick={() => onSelect(node)}
>
  <div class="aspect-video bg-gray-900 relative overflow-hidden">
    {#if thumbnail}
      <img
        src={thumbnail}
        alt=""
        loading="lazy"
        class="w-full h-full object-cover transition-opacity duration-300"
      />
      <div
        class="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <div class="bg-red-600/90 rounded-full p-3">
          <Play class="text-white fill-current" size={24} />
        </div>
      </div>
    {:else if isVideo && thumbnailLoading}
      <div class="absolute inset-0 flex items-center justify-center">
        <div class="w-8 h-8 border-2 border-gray-600 border-t-red-500 rounded-full animate-spin"></div>
      </div>
    {:else}
      <div class="absolute inset-0 flex items-center justify-center">
        {#if node.type === 'folder'}
          <Folder class="text-blue-400" size={48} strokeWidth={1.5} />
        {:else if isVideo}
          <Play class="text-red-400" size={48} strokeWidth={1.5} />
        {:else}
          <File class="text-gray-500" size={48} strokeWidth={1.5} />
        {/if}
      </div>
    {/if}
  </div>

  <div class="p-3 flex-1 min-w-0">
    <h3 class="text-gray-100 text-sm font-medium truncate" title={node.name}>
      {node.name}
    </h3>
    <p class="text-gray-400 text-xs mt-1">
      {node.type === 'folder' ? 'Folder' : formatSize(node.size)}
    </p>
  </div>
</button>
