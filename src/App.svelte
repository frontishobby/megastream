<script lang="ts">
  import type { Storage, File as MegaFile } from 'megajs';
  import Navbar from './lib/components/Navbar.svelte';
  import FileCard from './lib/components/FileCard.svelte';
  import VideoView from './lib/components/VideoView.svelte';
  import LoginScreen from './lib/components/LoginScreen.svelte';
  import { MegaService, type MegaNode } from './lib/mega';
  import {
    loginWithCredentials,
    restoreSession,
    clearSession,
    hasSavedSession,
  } from './lib/session';
  import { router, navigate } from './lib/router.svelte';
  import { enqueueUpload } from './lib/upload.svelte';
  import UploadPanel from './lib/components/UploadPanel.svelte';
  import { Loader2, AlertCircle, Upload } from '@lucide/svelte';
  import './app.css';

  interface Quota {
    spaceUsed?: number;
    spaceTotal?: number;
    bandwidthUsed?: number;
    bandwidthTotal?: number;
  }

  let storage = $state<Storage | null>(null);
  let pathFolders = $state<MegaFile[]>([]);
  let nodes = $state<MegaNode[]>([]);
  let restoring = $state(hasSavedSession());
  let error = $state<string | null>(null);
  let quota = $state<Quota | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  const currentFolder = $derived(pathFolders[pathFolders.length - 1]);

  const selectedVideo = $derived.by<MegaNode | null>(() => {
    const r = router.current;
    if (r.kind !== 'file' || !storage) return null;
    const file = (storage as unknown as { files: Record<string, MegaFile> }).files[r.id];
    if (!file || file.directory) return null;
    return {
      name: file.name || 'Unknown',
      size: file.size,
      type: 'file',
      id: r.id,
      memo: readMemoFromFile(file),
      node: file,
    };
  });

  function readMemoFromFile(file: MegaFile): string | undefined {
    const attrs = (file as unknown as { attributes?: { _memo?: unknown } }).attributes;
    const m = attrs?._memo;
    return typeof m === 'string' && m.length > 0 ? m : undefined;
  }

  $effect(() => {
    // When entering the detail view via direct URL, rebuild the breadcrumb
    // path from the file's parent chain so the Back button + Navbar match.
    if (!selectedVideo || !storage) return;
    const parents: MegaFile[] = [];
    let cur: MegaFile | undefined = selectedVideo.node.parent;
    while (cur) {
      parents.unshift(cur);
      cur = cur.parent;
    }
    if (parents.length === 0) return;
    pathFolders = parents;
    const target = parents[parents.length - 1];
    nodes = MegaService.listChildren(target);
  });

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
    refreshQuota(s);
    (s as unknown as { on: (e: string, l: (f: MegaFile) => void) => void }).on('add', onNodeAdded);
  }

  function onNodeAdded(added: MegaFile) {
    if (!currentFolder) return;
    if (added.parent === currentFolder) {
      nodes = MegaService.listChildren(currentFolder);
      if (storage) refreshQuota(storage);
    }
  }

  function handleUploadClick() {
    fileInput?.click();
  }

  function handleFilesSelected(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0 || !currentFolder) return;
    const folder = currentFolder as unknown as Parameters<typeof enqueueUpload>[0];
    for (const file of Array.from(files)) {
      enqueueUpload(folder, file);
    }
    input.value = '';
  }

  async function refreshQuota(s: Storage) {
    try {
      const info = await s.getAccountInfo();
      // MEGA's `caxfer` (own downloads) is often 0 even on PRO accounts.
      // The quota actually consumed is `caxfer + csxfer` — bandwidth used via
      // shared links also counts against the PRO transfer quota, and is what
      // MEGA's own UI shows as "Transfer used".
      const used =
        (info.downloadBandwidthUsed || 0) + (info.sharedBandwidthUsed || 0);
      quota = {
        spaceUsed: info.spaceUsed,
        spaceTotal: info.spaceTotal,
        bandwidthUsed: used,
        bandwidthTotal: info.downloadBandwidthTotal,
      };
    } catch (err) {
      console.warn('Failed to fetch account info', err);
    }
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
    navigate({ kind: 'home' });
    quota = null;
    error = null;
  }

  function handleSelect(node: MegaNode) {
    if (node.type === 'folder') {
      pathFolders = [...pathFolders, node.node];
      nodes = MegaService.listChildren(node.node);
    } else if (MegaService.isVideo(node.name)) {
      navigate({ kind: 'file', id: node.id });
    }
  }

  function handleNavigate(index: number) {
    pathFolders = pathFolders.slice(0, index + 1);
    const target = pathFolders[pathFolders.length - 1];
    nodes = MegaService.listChildren(target);
    if (router.current.kind !== 'home') navigate({ kind: 'home' });
  }

  function handleBack() {
    if (history.length > 1) history.back();
    else navigate({ kind: 'home' });
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
      {quota}
      onNavigate={handleNavigate}
      onLogout={handleLogout}
    />

    {#if selectedVideo}
      <VideoView node={selectedVideo} onBack={handleBack} />
    {:else if router.current.kind === 'file'}
      <main class="flex-1 container mx-auto p-4 md:p-8 flex flex-col items-center justify-center text-gray-500 gap-3">
        <Loader2 class="text-red-500 animate-spin" size={32} />
        <p class="text-sm">Loading file…</p>
      </main>
    {:else}
      <main class="flex-1 container mx-auto p-4 md:p-8">
        {#if error}
          <div class="bg-red-900/20 border border-red-900/50 text-red-400 p-4 rounded-lg flex items-center gap-3 mb-8">
            <AlertCircle size={20} />
            <p>{error}</p>
          </div>
        {/if}

        <div class="flex justify-end mb-4">
          <button
            type="button"
            onclick={handleUploadClick}
            disabled={!currentFolder}
            class="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-full transition-colors"
          >
            <Upload size={16} />
            <span>Upload</span>
          </button>
        </div>

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
    {/if}

    <input
      bind:this={fileInput}
      type="file"
      multiple
      class="hidden"
      onchange={handleFilesSelected}
    />
    <UploadPanel />

    <footer class="p-6 text-center text-gray-600 text-sm border-t border-gray-900 mt-auto">
      <p>
        &copy; 2026 MegaStream. Powered by
        <a href="https://svelte.dev" class="text-red-500 hover:underline">Svelte 5</a> &
        <a href="https://github.com/tonygomes/megajs" class="text-blue-500 hover:underline">megajs</a>.
      </p>
    </footer>
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
