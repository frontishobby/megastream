<script lang="ts">
  import { File, Folder, Play, Download } from '@lucide/svelte';
  import type { MegaNode } from '../mega';
  import { MegaService } from '../mega';

  let { node, onSelect } = $props<{ 
    node: MegaNode; 
    onSelect: (node: MegaNode) => void 
  }>();

  const isVideo = $derived(node.type === 'file' && MegaService.isVideo(node.name));

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
</script>

<div 
  class="bg-gray-800 rounded-lg p-4 hover:bg-gray-700 transition-colors cursor-pointer group border border-gray-700"
  onclick={() => onSelect(node)}
>
  <div class="flex items-start gap-3">
    <div class="p-2 bg-gray-900 rounded-md">
      {#if node.type === 'folder'}
        <Folder class="text-blue-400" size={24} />
      {:else if isVideo}
        <Play class="text-red-400" size={24} />
      {:else}
        <File class="text-gray-400" size={24} />
      {/if}
    </div>
    
    <div class="flex-1 min-w-0">
      <h3 class="text-gray-100 font-medium truncate" title={node.name}>
        {node.name}
      </h3>
      <p class="text-gray-400 text-xs mt-1">
        {node.type === 'folder' ? 'Folder' : formatSize(node.size)}
      </p>
    </div>

    {#if isVideo}
      <div class="opacity-0 group-hover:opacity-100 transition-opacity">
        <Play class="text-red-500 fill-current" size={20} />
      </div>
    {/if}
  </div>
</div>
