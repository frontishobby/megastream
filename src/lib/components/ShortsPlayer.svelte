<script lang="ts">
  import {
    X,
    Volume2,
    VolumeX,
    Maximize,
    Minimize,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    ChevronDown,
    Play,
    Shuffle,
  } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { Storage } from 'megajs';
  import type { MegaNode } from '../mega';
  import { getStoredScenes, sceneEvents, type Scene } from '../scenes';
  import { createStreamUrl } from '../stream';
  import { getStoredThumbnail } from '../thumbnails';
  import { showToast, showStreamErrorToast } from '../toast.svelte';
  import { listSceneVideoIds, collectCandidates, pickRandomVideo } from '../shorts';

  let { storage, scope, folderId, onExit } = $props<{
    storage: Storage;
    scope: 'all' | 'folder';
    folderId?: string;
    onExit: () => void;
  }>();

  interface ShortsEntry {
    node: MegaNode;
    scenes: Scene[];
    sceneIndex: number;
  }

  let pool = $state<MegaNode[]>([]);
  let history = $state<ShortsEntry[]>([]);
  let cursor = $state(-1);
  const current = $derived(history[cursor] ?? null);

  let streamUrl = $state<string | null>(null);
  let poster = $state<string | null>(null);
  let loading = $state(true);
  let paused = $state(false);
  let muted = $state(false);
  let fullscreen = $state(false);
  let videoEl = $state<HTMLVideoElement | undefined>();

  let navLock = false;
  let disposed = false;
  let consecutiveErrors = 0;

  $effect(() => () => {
    disposed = true;
    clearTimeout(pendingTapTimer);
    clearTimeout(skipFlashTimer);
  });

  // --- Pool construction (per scope/folder) ---
  $effect(() => {
    const sceneIds = listSceneVideoIds(storage);
    const candidates = collectCandidates(storage, scope, folderId);
    const p = candidates.filter((c) => sceneIds.has(c.id));
    if (candidates.length === 0) {
      showToast('No playable videos here for shorts', 'warning');
      onExit();
      return;
    }
    if (p.length === 0) {
      showToast('No videos with scene data — run "Detect scenes" first', 'warning');
      onExit();
      return;
    }
    untrack(() => {
      history = [];
      cursor = -1;
      pool = p;
      advanceForward();
    });

    // A bulk scan finishing while shorts is open grows the pool live.
    const onScenes = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      const cand = candidates.find((c) => c.id === id);
      if (cand && !pool.some((v) => v.id === id)) pool = [...pool, cand];
    };
    sceneEvents.addEventListener('scenes', onScenes);
    return () => sceneEvents.removeEventListener('scenes', onScenes);
  });

  // --- Navigation ---
  function recentIds(): string[] {
    const ids: string[] = [];
    for (let i = cursor; i >= 0 && ids.length < 5; i--) {
      const id = history[i]?.node.id;
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  async function advanceForward() {
    if (navLock || disposed) return;
    if (cursor < history.length - 1) {
      cursor++;
      return;
    }
    navLock = true;
    try {
      while (pool.length > 0) {
        const video = pickRandomVideo(pool, recentIds());
        if (!video) break;
        const data = await getStoredScenes(video.id, video.node);
        if (disposed) return;
        if (!data || data.scenes.length === 0) {
          // Sidecar listed but unreadable/empty — drop it and re-pick.
          pool = pool.filter((v) => v.id !== video.id);
          continue;
        }
        const sceneIndex = Math.floor(Math.random() * data.scenes.length);
        history = [...history, { node: video, scenes: data.scenes, sceneIndex }];
        cursor = history.length - 1;
        return;
      }
      showToast('No videos with scene data left', 'warning');
      onExit();
    } finally {
      navLock = false;
    }
  }

  function goBack() {
    if (cursor > 0) cursor--;
  }

  function seekScene(i: number) {
    const entry = current;
    if (!entry || !videoEl) return;
    const clamped = Math.max(0, Math.min(entry.scenes.length - 1, i));
    if (clamped === entry.sceneIndex) return;
    entry.sceneIndex = clamped;
    videoEl.currentTime = entry.scenes[clamped].start;
    videoEl.play()?.catch?.(() => {});
  }

  function nextScene() {
    if (current) seekScene(current.sceneIndex + 1);
  }

  function prevScene() {
    if (current) seekScene(current.sceneIndex - 1);
  }

  function failAdvance() {
    consecutiveErrors++;
    if (consecutiveErrors >= 3) {
      showToast('Playback keeps failing — leaving shorts');
      onExit();
      return;
    }
    setTimeout(() => {
      if (!disposed) advanceForward();
    }, 1200);
  }

  // --- Stream lifecycle: exactly one live session, cleaned up on advance ---
  $effect(() => {
    const entry = current;
    if (!entry) return;
    const id = entry.node.id;
    const file = entry.node.node;
    let cancelled = false;
    let cleanupFn: (() => void) | null = null;
    loading = true;
    streamUrl = null;
    poster = null;
    paused = false;
    getStoredThumbnail(id, file).then((p) => {
      if (!cancelled && p) poster = p;
    });
    createStreamUrl(file)
      .then(({ url, cleanup }) => {
        if (cancelled) {
          cleanup();
          return;
        }
        cleanupFn = cleanup;
        streamUrl = url;
        loading = false;
      })
      .catch((err) => {
        if (cancelled) return;
        loading = false;
        showStreamErrorToast('Shorts stream failed', err);
        failAdvance();
      });
    return () => {
      cancelled = true;
      cleanupFn?.();
    };
  });

  function onLoadedMetadata() {
    consecutiveErrors = 0;
    const entry = current;
    if (!videoEl || !entry) return;
    const scene = entry.scenes[entry.sceneIndex];
    if (scene && scene.start > 0.1) videoEl.currentTime = scene.start;
    videoEl.play().catch(() => {
      paused = true;
    });
  }

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
    showToast(`Shorts playback stopped: ${codes[e.code] ?? 'unknown error'}`);
    failAdvance();
  }

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) videoEl.play().catch(() => {});
    else videoEl.pause();
  }

  // --- Double-tap seek: left/right half of the screen skips ±10s. A single
  // tap waits out the double-tap window before toggling play; further taps
  // within the chain window keep stacking skips (YouTube-style). ---
  const DOUBLE_TAP_MS = 300;
  const TAP_CHAIN_MS = 350;
  const SKIP_SECONDS = 10;

  let pendingTapTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTapAt = 0;
  let chainUntil = 0;
  let skipFlash = $state<{ side: 'left' | 'right'; total: number } | null>(null);
  let skipFlashTimer: ReturnType<typeof setTimeout> | undefined;

  function handleTap(x: number) {
    const now = performance.now();
    const isDouble = now < chainUntil || now - lastTapAt < DOUBLE_TAP_MS;
    lastTapAt = now;
    clearTimeout(pendingTapTimer);
    if (isDouble) {
      chainUntil = now + TAP_CHAIN_MS;
      skipBy(x >= window.innerWidth / 2 ? SKIP_SECONDS : -SKIP_SECONDS);
      return;
    }
    pendingTapTimer = setTimeout(() => togglePlay(), DOUBLE_TAP_MS);
  }

  function skipBy(delta: number) {
    if (!videoEl) return;
    const dur = Number.isFinite(videoEl.duration) ? videoEl.duration : Infinity;
    videoEl.currentTime = Math.max(0, Math.min(dur, videoEl.currentTime + delta));
    const side = delta > 0 ? 'right' : 'left';
    skipFlash = {
      side,
      total: (skipFlash?.side === side ? skipFlash.total : 0) + Math.abs(delta),
    };
    clearTimeout(skipFlashTimer);
    skipFlashTimer = setTimeout(() => (skipFlash = null), 700);
  }

  // --- Fullscreen / orientation (best-effort; iOS gets the overlay only) ---
  $effect(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })
      ?.lock?.('landscape')
      .catch(() => {});
    const onFs = () => {
      fullscreen = !!document.fullscreenElement;
    };
    onFs();
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      (screen.orientation as unknown as { unlock?: () => void })?.unlock?.();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  // --- Gestures ---
  const SWIPE_THRESHOLD = 60;
  const TAP_MAX_DIST = 10;
  const TAP_MAX_MS = 300;

  let gesture = $state<{ id: number; x: number; y: number; t: number } | null>(null);
  let dragX = $state(0);

  function onPointerDown(e: PointerEvent) {
    if (gesture) return;
    gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    wakeControls();
  }

  function onPointerMove(e: PointerEvent) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    dragX = Math.abs(dx) > Math.abs(dy) ? dx : 0;
  }

  function onPointerUp(e: PointerEvent) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    const dt = performance.now() - gesture.t;
    gesture = null;
    dragX = 0;
    resolveGesture(dx, dy, dt, e.clientX);
  }

  function onPointerCancel(e: PointerEvent) {
    if (gesture && e.pointerId === gesture.id) {
      gesture = null;
      dragX = 0;
    }
  }

  // The finger moves the content: dragging LEFT advances to the new video
  // sitting "on the right", dragging UP moves down to the next scene — the
  // usual shorts convention. Flip the four calls here if it feels inverted.
  function resolveGesture(dx: number, dy: number, dt: number, x: number) {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < TAP_MAX_DIST && ay < TAP_MAX_DIST) {
      if (dt < TAP_MAX_MS) handleTap(x);
      return;
    }
    if (ax >= ay) {
      if (ax < SWIPE_THRESHOLD) return;
      if (dx < 0) advanceForward();
      else goBack();
    } else {
      if (ay < SWIPE_THRESHOLD) return;
      if (dy < 0) nextScene();
      else prevScene();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        advanceForward();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        goBack();
        break;
      case 'ArrowDown':
        e.preventDefault();
        nextScene();
        break;
      case 'ArrowUp':
        e.preventDefault();
        prevScene();
        break;
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'Escape':
        // First Escape leaves fullscreen (browser-handled); second exits shorts.
        if (!document.fullscreenElement) onExit();
        break;
      case 'm':
        muted = !muted;
        break;
      case 'f':
        toggleFullscreen();
        break;
    }
    wakeControls();
  }

  // --- Auto-fading controls ---
  let controlsVisible = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function wakeControls() {
    controlsVisible = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      controlsVisible = false;
    }, 2500);
  }

  $effect(() => {
    wakeControls();
    return () => clearTimeout(hideTimer);
  });

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div
  class="fixed inset-0 z-50 bg-black text-gray-100 overflow-hidden select-none"
  style="touch-action: none; overscroll-behavior: contain;"
>
  <!-- Media layer (follows the drag slightly for feedback) -->
  <div
    class="absolute inset-0 {gesture ? '' : 'transition-transform duration-150 ease-out'}"
    style:transform="translateX({dragX * 0.35}px)"
  >
    {#if poster && !streamUrl}
      <img src={poster} alt="" class="absolute inset-0 w-full h-full object-contain opacity-50" />
    {/if}
    {#if streamUrl}
      <video
        bind:this={videoEl}
        src={streamUrl}
        autoplay
        playsinline
        {muted}
        onloadedmetadata={onLoadedMetadata}
        onended={advanceForward}
        onerror={onVideoError}
        onplay={() => (paused = false)}
        onpause={() => (paused = true)}
        class="absolute inset-0 w-full h-full object-contain"
      >
        <track kind="captions" />
      </video>
    {/if}
  </div>

  <!-- Gesture surface -->
  <div
    class="absolute inset-0 z-10"
    role="presentation"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
  ></div>

  {#if skipFlash}
    <div
      class="absolute inset-y-0 z-10 w-1/3 flex items-center justify-center pointer-events-none {skipFlash.side ===
      'left'
        ? 'left-0'
        : 'right-0'}"
    >
      <div class="bg-black/60 rounded-full px-4 py-2 text-sm font-semibold">
        {skipFlash.side === 'left' ? '«' : ''}
        {skipFlash.side === 'left' ? '−' : '+'}{skipFlash.total}s
        {skipFlash.side === 'right' ? '»' : ''}
      </div>
    </div>
  {/if}

  {#if loading}
    <div class="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div class="w-12 h-12 border-4 border-red-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else if paused}
    <div class="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div class="bg-black/50 rounded-full p-5">
        <Play size={40} class="text-white" fill="currentColor" />
      </div>
    </div>
  {/if}

  <!-- HUD -->
  <div
    class="absolute inset-x-0 top-0 z-20 p-4 bg-gradient-to-b from-black/70 to-transparent flex items-start gap-3 transition-opacity duration-300 {controlsVisible
      ? 'opacity-100'
      : 'opacity-0 pointer-events-none'}"
  >
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium truncate">{current?.node.name ?? '…'}</p>
      {#if current}
        <p class="text-xs text-gray-400 mt-0.5 flex items-center gap-2">
          <span class="inline-flex items-center gap-1">
            <Shuffle size={11} />
            {scope === 'all' ? 'All videos' : 'This folder'}
          </span>
          <span>
            Scene {current.sceneIndex + 1}/{current.scenes.length}
            · {formatTime(current.scenes[current.sceneIndex].start)}
          </span>
          {#if current.scenes[current.sceneIndex].position}
            <span class="uppercase tracking-wide text-[10px] text-amber-300/90">
              {current.scenes[current.sceneIndex].position}
            </span>
          {/if}
        </p>
      {/if}
    </div>
    <button
      type="button"
      onclick={() => (muted = !muted)}
      class="shrink-0 p-2 rounded-full bg-black/40 hover:bg-black/70 transition-colors"
      aria-label={muted ? 'Unmute' : 'Mute'}
    >
      {#if muted}<VolumeX size={18} />{:else}<Volume2 size={18} />{/if}
    </button>
    <button
      type="button"
      onclick={toggleFullscreen}
      class="shrink-0 p-2 rounded-full bg-black/40 hover:bg-black/70 transition-colors"
      aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
    >
      {#if fullscreen}<Minimize size={18} />{:else}<Maximize size={18} />{/if}
    </button>
    <button
      type="button"
      onclick={onExit}
      class="shrink-0 p-2 rounded-full bg-black/40 hover:bg-black/70 transition-colors"
      aria-label="Exit shorts"
    >
      <X size={18} />
    </button>
  </div>

  <!-- Nav fallback buttons (desktop / no-gesture) -->
  <div
    class="absolute right-3 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-2 transition-opacity duration-300 {controlsVisible
      ? 'opacity-100'
      : 'opacity-0 pointer-events-none'}"
  >
    <button
      type="button"
      onclick={prevScene}
      disabled={!current || current.sceneIndex === 0}
      class="p-2 rounded-full bg-black/40 hover:bg-black/70 disabled:opacity-30 transition-colors"
      aria-label="Previous scene"
      title="Previous scene (↑)"
    >
      <ChevronUp size={20} />
    </button>
    <button
      type="button"
      onclick={goBack}
      disabled={cursor <= 0}
      class="p-2 rounded-full bg-black/40 hover:bg-black/70 disabled:opacity-30 transition-colors"
      aria-label="Previous video"
      title="Previous video (←)"
    >
      <ChevronLeft size={20} />
    </button>
    <button
      type="button"
      onclick={advanceForward}
      class="p-2 rounded-full bg-red-600/80 hover:bg-red-600 transition-colors"
      aria-label="New random video"
      title="New random video (→)"
    >
      <ChevronRight size={20} />
    </button>
    <button
      type="button"
      onclick={nextScene}
      disabled={!current || current.sceneIndex >= current.scenes.length - 1}
      class="p-2 rounded-full bg-black/40 hover:bg-black/70 disabled:opacity-30 transition-colors"
      aria-label="Next scene"
      title="Next scene (↓)"
    >
      <ChevronDown size={20} />
    </button>
  </div>
</div>
