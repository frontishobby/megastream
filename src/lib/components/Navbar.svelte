<script lang="ts">
  import { Search, Play } from '@lucide/svelte';
  
  let { onUrlSubmit } = $props<{ onUrlSubmit: (url: string) => void }>();
  let url = $state('');

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (url.trim()) {
      onUrlSubmit(url.trim());
    }
  }
</script>

<nav class="bg-gray-900 text-white p-4 sticky top-0 z-10 shadow-lg">
  <div class="container mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
    <div class="flex items-center gap-2 cursor-pointer" onclick={() => window.location.reload()}>
      <Play class="text-red-500 fill-current" size={32} />
      <h1 class="text-2xl font-bold tracking-tight">MegaStream</h1>
    </div>

    <form onsubmit={handleSubmit} class="relative w-full md:w-1/2 lg:w-2/3">
      <input
        type="text"
        bind:value={url}
        placeholder="Enter Mega.nz link (File or Folder)..."
        class="w-full bg-gray-800 border border-gray-700 rounded-full py-2 px-4 pl-10 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
      />
      <Search class="absolute left-3 top-2.5 text-gray-400" size={18} />
      <button 
        type="submit"
        class="absolute right-2 top-1 bg-red-600 hover:bg-red-700 text-white px-4 py-1 rounded-full text-sm font-medium transition-colors"
      >
        Load
      </button>
    </form>
    
    <div class="hidden md:block">
      <span class="text-gray-400 text-sm">Svelte 5 powered</span>
    </div>
  </div>
</nav>
