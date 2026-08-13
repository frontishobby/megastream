<script lang="ts">
  import { ArrowLeft, StickyNote, Pencil, Check, X, Loader2, Film, RefreshCw } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { MegaNode } from '../mega';
  import { MegaService } from '../mega';
  import { createStreamUrl } from '../stream';
  import { attachTsPlayer, isTransportStream } from '../tsPlayer';
  import {
    getStoredScenes,
    detectScenesFromNode,
    saveScenes,
    sceneEvents,
    type Scene,
    type SceneData,
  } from '../scenes';
  import { resolveSceneAnalysisMode } from '../labeler';
  import type { Storage } from 'megajs';
  import { showToast } from '../toast.svelte';

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

  let title = $state<string>(untrack(() => node.name));
  let renaming = $state(false);
  let nameDraft = $state('');
  let renameSaving = $state(false);
  let renameError = $state<string | null>(null);
  let nameInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    memo = node.memo;
  });

  $effect(() => {
    title = node.name;
  });

  const tsMode = $derived(isTransportStream(node.name));

  // --- Scene navigation ---
  let scenes = $state<SceneData | null>(null);
  let scenesLoading = $state(true);
  let detecting = $state<{ processed: number; duration: number } | null>(null);
  let currentTime = $state(0);

  $effect(() => {
    const id = node.id;
    const file = node.node;
    let cancelled = false;
    scenes = null;
    scenesLoading = true;
    getStoredScenes(id, file)
      .then((d) => {
        if (!cancelled) scenes = d;
      })
      .finally(() => {
        if (!cancelled) scenesLoading = false;
      });
    // Refresh when a bulk scan (or another view) produces data for this video.
    const onScenes = (e: Event) => {
      if ((e as CustomEvent).detail !== id) return;
      getStoredScenes(id, file).then((d) => {
        if (!cancelled && d) scenes = d;
      });
    };
    sceneEvents.addEventListener('scenes', onScenes);
    return () => {
      cancelled = true;
      sceneEvents.removeEventListener('scenes', onScenes);
    };
  });

  const activeSceneIndex = $derived.by(() => {
    const list = scenes?.scenes;
    if (!list || list.length === 0) return -1;
    for (let k = list.length - 1; k >= 0; k--) {
      if (currentTime >= list[k].start) return k;
    }
    return 0;
  });

  const detectPct = $derived(
    detecting && detecting.duration > 0
      ? Math.min(100, Math.round((detecting.processed / detecting.duration) * 100))
      : 0
  );

  function onTimeUpdate() {
    currentTime = videoEl?.currentTime ?? 0;
  }

  function jumpToScene(scene: Scene) {
    if (!videoEl) return;
    videoEl.currentTime = scene.start;
    videoEl.play()?.catch?.(() => {});
  }

  async function handleDetectScenes() {
    if (detecting) return;
    const mode = await resolveSceneAnalysisMode();
    if (mode === 'skip') return;
    detecting = { processed: 0, duration: 0 };
    // The scan streams the same file; pause the player so the two transfers
    // don't compete for MEGA's parallel-connection limit (which kills the
    // player's stream with a demuxer read error).
    const player = videoEl;
    const wasPlaying = !!player && !player.paused && !player.ended;
    try {
      player?.pause();
    } catch (_) {}
    try {
      const data = await detectScenesFromNode(node.node, {
        withLabels: mode === 'labeled',
        onProgress: (processed, dur) => {
          detecting = { processed, duration: dur };
        },
      });
      const storage = (node.node as unknown as { storage?: Storage }).storage;
      if (storage) await saveScenes(storage, node.id, data);
      scenes = data;
    } catch (err) {
      showToast(
        `Scene detection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      detecting = null;
      if (wasPlaying) player?.play().catch(() => {});
    }
  }

  $effect(() => {
    if (tsMode) return;
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

  // MPEG-TS path: browsers can't play .ts natively, so transmux to fMP4
  // through MediaSource. Needs the <video> element to exist first.
  $effect(() => {
    if (!tsMode || !videoEl) return;
    const el = videoEl;
    let cancelled = false;
    let handle: { destroy(): void } | null = null;

    loading = true;
    error = null;
    streamUrl = null;
    resolution = null;
    duration = null;

    attachTsPlayer(el, node.node)
      .then((h) => {
        if (cancelled) {
          h.destroy();
          return;
        }
        handle = h;
        loading = false;
      })
      .catch((err: any) => {
        console.error('TS playback setup error:', err);
        if (!cancelled) {
          error = err?.message || 'Failed to play transport stream';
          loading = false;
        }
      });

    return () => {
      cancelled = true;
      handle?.destroy();
    };
  });

  // Mid-playback failures (decode error, network drop, service worker losing
  // the session) surface only on the <video> element, not as setup errors.
  function onVideoError() {
    const e = videoEl?.error;
    if (!e) return;
    // src teardown during cleanup fires a spurious "empty src" error
    if (e.code === 4 && !videoEl?.currentSrc) return;
    const codes: Record<number, string> = {
      1: 'playback aborted',
      2: 'network error while streaming',
      3: 'video decode failed (corrupt data or unsupported codec)',
      4: 'video format not supported',
    };
    const detail = e.message ? ` — ${e.message}` : '';
    showToast(`Playback stopped: ${codes[e.code] ?? 'unknown error'}${detail}`);
  }

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

  function startRename() {
    nameDraft = title;
    renaming = true;
    renameError = null;
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  }

  function cancelRename() {
    renaming = false;
    nameDraft = '';
    renameError = null;
  }

  async function saveRename() {
    if (renameSaving) return;
    if (!nameDraft.trim() || nameDraft.trim() === title) {
      cancelRename();
      return;
    }
    renameSaving = true;
    renameError = null;
    try {
      const next = await MegaService.renameFile(node.node, nameDraft);
      title = next;
      node.name = next;
      renaming = false;
      nameDraft = '';
    } catch (err) {
      renameError = err instanceof Error ? err.message : 'Failed to rename';
    } finally {
      renameSaving = false;
    }
  }

  function nameKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      saveRename();
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

  <div class="w-full bg-black overflow-hidden aspect-video flex items-center justify-center relative">
    {#if error}
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
    {:else}
      {#if streamUrl || tsMode}
        <video
          bind:this={videoEl}
          src={streamUrl ?? undefined}
          controls
          autoplay
          playsinline
          onloadedmetadata={onLoadedMetadata}
          ontimeupdate={onTimeUpdate}
          onerror={onVideoError}
          class="w-full h-full"
        >
          <track kind="captions" />
        </video>
      {/if}
      {#if loading}
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60 pointer-events-none">
          <div class="w-12 h-12 border-4 border-red-500 border-t-transparent rounded-full animate-spin"></div>
          <p class="text-gray-400 animate-pulse">Preparing stream...</p>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Scene navigation strip -->
  <div class="mt-3">
    {#if scenes && scenes.scenes.length > 0}
      <div class="flex items-center gap-2 overflow-x-auto pb-1">
        <span class="shrink-0 text-xs text-gray-500 inline-flex items-center gap-1.5 pr-1">
          <Film size={14} />
          {scenes.scenes.length} scenes
        </span>
        {#each scenes.scenes as scene (scene.i)}
          <button
            type="button"
            onclick={() => jumpToScene(scene)}
            class="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors {activeSceneIndex ===
            scene.i
              ? 'bg-red-600 text-white'
              : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}"
            title={`Scene ${scene.i + 1}: ${formatDuration(scene.start)} – ${formatDuration(scene.end)}`}
          >
            <span class={activeSceneIndex === scene.i ? 'text-red-200' : 'text-gray-500'}>
              #{scene.i + 1}
            </span>
            <span>{formatDuration(scene.start)}</span>
            {#if scene.position}
              <span
                class="uppercase tracking-wide text-[10px] {activeSceneIndex === scene.i
                  ? 'text-red-100/90'
                  : 'text-amber-300/90'}"
              >
                {scene.position}
              </span>
            {/if}
          </button>
        {/each}
        <button
          type="button"
          onclick={handleDetectScenes}
          disabled={!!detecting}
          class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs text-gray-500 hover:text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed transition-colors"
          title="Re-detect scenes"
          aria-label="Re-detect scenes"
        >
          {#if detecting}
            <Loader2 size={12} class="animate-spin" />
            <span>{detectPct}%</span>
          {:else}
            <RefreshCw size={12} />
          {/if}
        </button>
      </div>
    {:else if scenesLoading}
      <p class="text-gray-600 text-xs px-1">Loading scenes…</p>
    {:else}
      <button
        type="button"
        onclick={handleDetectScenes}
        disabled={!!detecting}
        class="inline-flex items-center gap-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-60 disabled:cursor-not-allowed text-gray-200 text-xs font-medium px-3 py-1.5 rounded-full transition-colors"
      >
        {#if detecting}
          <Loader2 size={14} class="animate-spin" />
          <span>Scanning… {detectPct}%</span>
        {:else}
          <Film size={14} />
          <span>Detect scenes</span>
        {/if}
      </button>
    {/if}
  </div>

  <div class="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
    <div class="lg:col-span-2 space-y-4">
      {#if renaming}
        <div>
          <div class="flex items-center gap-2">
            <input
              bind:this={nameInput}
              bind:value={nameDraft}
              onkeydown={nameKey}
              disabled={renameSaving}
              maxlength="255"
              class="flex-1 bg-gray-950 border border-gray-700 rounded px-3 py-2 text-2xl font-semibold text-gray-100 focus:outline-none focus:border-red-500 disabled:opacity-50"
            />
            <button
              type="button"
              onclick={cancelRename}
              disabled={renameSaving}
              class="text-gray-400 hover:text-gray-200 p-2 rounded disabled:opacity-50"
              title="Cancel (Esc)"
              aria-label="Cancel rename"
            >
              <X size={16} />
            </button>
            <button
              type="button"
              onclick={saveRename}
              disabled={renameSaving}
              class="text-green-400 hover:text-green-300 p-2 rounded disabled:opacity-50"
              title="Save (Enter)"
              aria-label="Save rename"
            >
              {#if renameSaving}
                <Loader2 size={16} class="animate-spin" />
              {:else}
                <Check size={16} />
              {/if}
            </button>
          </div>
          {#if renameError}
            <p class="text-red-400 text-xs mt-1">{renameError}</p>
          {/if}
        </div>
      {:else}
        <div class="flex items-start gap-2 group">
          <h1 class="text-2xl font-semibold text-gray-100 break-words flex-1">{title}</h1>
          <button
            type="button"
            onclick={startRename}
            class="text-gray-500 hover:text-gray-200 p-1 rounded shrink-0 opacity-60 group-hover:opacity-100 transition-opacity"
            title="Rename"
            aria-label="Rename"
          >
            <Pencil size={16} />
          </button>
        </div>
      {/if}

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
