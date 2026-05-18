<script lang="ts">
  import Navbar from './lib/components/Navbar.svelte';
  import FileCard from './lib/components/FileCard.svelte';
  import VideoPlayer from './lib/components/VideoPlayer.svelte';
  import { MegaService, type MegaNode } from './lib/mega';
  import { Loader2, AlertCircle, Info } from '@lucide/svelte';
  import './app.css';

  let nodes = $state<MegaNode[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let selectedVideo = $state<MegaNode | null>(null);
  let history = $state<string[]>([]);

  async function handleUrlSubmit(url: string) {
    loading = true;
    error = null;
    try {
      const fetchedNodes = await MegaService.getNodesFromUrl(url);
      nodes = fetchedNodes;
      if (!history.includes(url)) {
        history = [url, ...history.slice(0, 4)];
      }
    } catch (err: any) {
      error = err.message || 'Failed to load Mega URL. Please check the link.';
      nodes = [];
    } finally {
      loading = false;
    }
  }

  function handleNodeSelect(node: MegaNode) {
    if (node.type === 'folder') {
      // If it's a folder node from within a loaded folder
      if (node.node && node.node.children) {
        nodes = node.node.children.map((child: any) => ({
          name: child.name || 'Unknown',
          size: child.size,
          type: child.directory ? 'folder' : 'file',
          id: child.handle || '',
          node: child
        }));
      }
    } else if (MegaService.isVideo(node.name)) {
      selectedVideo = node;
    }
  }
</script>

<div class="min-h-screen bg-gray-950 text-gray-100 flex flex-col font-sans">
  <Navbar onUrlSubmit={handleUrlSubmit} />

  <main class="flex-1 container mx-auto p-4 md:p-8">
    {#if error}
      <div class="bg-red-900/20 border border-red-900/50 text-red-400 p-4 rounded-lg flex items-center gap-3 mb-8">
        <AlertCircle size={20} />
        <p>{error}</p>
      </div>
    {/if}

    {#if loading}
      <div class="flex flex-col items-center justify-center py-20 gap-4">
        <Loader2 class="text-red-500 animate-spin" size={48} />
        <p class="text-gray-400 font-medium">Fetching metadata from Mega.nz...</p>
      </div>
    {:else if nodes.length > 0}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {#each nodes as node (node.id)}
          <FileCard {node} onSelect={handleNodeSelect} />
        {/each}
      </div>
    {:else}
      <div class="max-w-2xl mx-auto mt-12 text-center">
        <div class="bg-gray-900 rounded-2xl p-8 border border-gray-800 shadow-xl">
          <div class="bg-gray-800 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6">
            <Info class="text-blue-400" size={32} />
          </div>
          <h2 class="text-2xl font-bold mb-4">Welcome to MegaStream</h2>
          <p class="text-gray-400 mb-8 leading-relaxed">
            Enter a Mega.nz file or folder link in the search bar above to start browsing and streaming your videos.
          </p>
          
          {#if history.length > 0}
            <div class="text-left">
              <h3 class="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Recent Links</h3>
              <div class="space-y-2">
                {#each history as item}
                  <button 
                    onclick={() => handleUrlSubmit(item)}
                    class="w-full text-left p-3 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm truncate transition-colors border border-transparent hover:border-gray-600"
                  >
                    {item}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>

        <div class="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6 text-sm text-gray-500">
          <div class="p-4">
            <h4 class="font-bold text-gray-400 mb-2">Private</h4>
            <p>Direct streaming from Mega without logging in.</p>
          </div>
          <div class="p-4">
            <h4 class="font-bold text-gray-400 mb-2">Fast</h4>
            <p>Built with Svelte 5 and Vite for extreme performance.</p>
          </div>
          <div class="p-4">
            <h4 class="font-bold text-gray-400 mb-2">Simple</h4>
            <p>No account required. Just paste the link and play.</p>
          </div>
        </div>
      </div>
    {/if}
  </main>

  <footer class="p-6 text-center text-gray-600 text-sm border-t border-gray-900 mt-auto">
    <p>&copy; 2026 MegaStream. Powered by <a href="https://svelte.dev" class="text-red-500 hover:underline">Svelte 5</a> & <a href="https://github.com/tonygomes/megajs" class="text-blue-500 hover:underline">megajs</a>.</p>
  </footer>

  {#if selectedVideo}
    <VideoPlayer node={selectedVideo} onClose={() => selectedVideo = null} />
  {/if}
</div>

<style>
  :global(body) {
    background-color: #030712; /* gray-950 */
    color: #f9fafb;
    margin: 0;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
  }
</style>
