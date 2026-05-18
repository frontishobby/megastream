<script lang="ts">
  import { ChevronRight, Home } from '@lucide/svelte';

  let { path, onNavigate } = $props<{
    path: { name: string }[];
    onNavigate: (index: number) => void;
  }>();
</script>

<nav class="flex items-center gap-1 text-sm overflow-x-auto whitespace-nowrap">
  <button
    type="button"
    onclick={() => onNavigate(0)}
    class="flex items-center gap-1 text-gray-300 hover:text-white px-2 py-1 rounded transition-colors flex-shrink-0"
  >
    <Home size={14} />
    <span>Root</span>
  </button>
  {#each path.slice(1) as entry, i}
    <ChevronRight class="text-gray-600 flex-shrink-0" size={14} />
    <button
      type="button"
      onclick={() => onNavigate(i + 1)}
      class="text-gray-300 hover:text-white px-2 py-1 rounded transition-colors truncate max-w-[200px]"
    >
      {entry.name}
    </button>
  {/each}
</nav>
