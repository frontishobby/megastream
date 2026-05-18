<script lang="ts">
  import type { Storage, File as MegaFile } from 'megajs';
  import Navbar from './lib/components/Navbar.svelte';
  import FileCard from './lib/components/FileCard.svelte';
  import VideoPlayer from './lib/components/VideoPlayer.svelte';
  import LoginScreen from './lib/components/LoginScreen.svelte';
  import { MegaService, type MegaNode } from './lib/mega';
  import {
    loginWithCredentials,
    restoreSession,
    clearSession,
    hasSavedSession,
  } from './lib/session';
  import { Loader2, AlertCircle } from '@lucide/svelte';
  import './app.css';

  let storage = $state<Storage | null>(null);
  let pathFolders = $state<MegaFile[]>([]);
  let nodes = $state<MegaNode[]>([]);
  let restoring = $state(hasSavedSession());
  let error = $state<string | null>(null);
  let selectedVideo = $state<MegaNode | null>(null);

  const pathDisplay = $derived(
    pathFolders.map((f, i) => ({
      name: i === 0 ? 'Root' : f.name || 'Folder',
    }))
  );

  $effect(() => {
    if (!restoring) return;
    let cancelled = false;
    restoreSession()
      .then((s) => {
        if (cancelled) return;
        if (s) setStorage(s);
      })
      .catch((err) => {
        console.warn('Session restore failed:', err);
      })
      .finally(() => {
        if (!cancelled) restoring = false;
      });
    return () => {
      cancelled = true;
    };
  });

  function setStorage(s: Storage) {
    storage = s;
    pathFolders = [s.root as unknown as MegaFile];
    nodes = MegaService.listChildren(s.root as unknown as MegaFile);
    error = null;
  }

  async function handleLogin(email: string, password: string) {
    const s = await loginWithCredentials(email, password);
    setStorage(s);
  }

  function handleLogout() {
    clearSession();
    try {
      storage?.close?.();
    } catch (_) {}
    storage = null;
    pathFolders = [];
    nodes = [];
    selectedVideo = null;
    error = null;
  }

  function handleSelect(node: MegaNode) {
    if (node.type === 'folder') {
      pathFolders = [...pathFolders, node.node];
      nodes = MegaService.listChildren(node.node);
    } else if (MegaService.isVideo(node.name)) {
      selectedVideo = node;
    }
  }

  function handleNavigate(index: number) {
    pathFolders = pathFolders.slice(0, index + 1);
    const target = pathFolders[pathFolders.length - 1];
    nodes = MegaService.listChildren(target);
  }
</script>

{#if restoring && !storage}
  <div class="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center justify-center gap-4">
    <Loader2 class="text-red-500 animate-spin" size={48} />
    <p class="text-gray-400 text-sm">Restoring session...</p>
  </div>
{:else if !storage}
  <div class="min-h-screen bg-gray-950 text-gray-100 flex flex-col font-sans">
    <LoginScreen onLogin={handleLogin} />
  </div>
{:else}
  <div class="min-h-screen bg-gray-950 text-gray-100 flex flex-col font-sans">
    <Navbar
      path={pathDisplay}
      accountEmail={storage.email || ''}
      onNavigate={handleNavigate}
      onLogout={handleLogout}
    />

    <main class="flex-1 container mx-auto p-4 md:p-8">
      {#if error}
        <div class="bg-red-900/20 border border-red-900/50 text-red-400 p-4 rounded-lg flex items-center gap-3 mb-8">
          <AlertCircle size={20} />
          <p>{error}</p>
        </div>
      {/if}

      {#if nodes.length > 0}
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {#each nodes as node (node.id)}
            <FileCard {node} onSelect={handleSelect} />
          {/each}
        </div>
      {:else}
        <div class="text-center py-20 text-gray-500">This folder is empty.</div>
      {/if}
    </main>

    <footer class="p-6 text-center text-gray-600 text-sm border-t border-gray-900 mt-auto">
      <p>
        &copy; 2026 MegaStream. Powered by
        <a href="https://svelte.dev" class="text-red-500 hover:underline">Svelte 5</a> &
        <a href="https://github.com/tonygomes/megajs" class="text-blue-500 hover:underline">megajs</a>.
      </p>
    </footer>

    {#if selectedVideo}
      <VideoPlayer node={selectedVideo} onClose={() => (selectedVideo = null)} />
    {/if}
  </div>
{/if}

<style>
  :global(body) {
    background-color: #030712;
    color: #f9fafb;
    margin: 0;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
  }
</style>
