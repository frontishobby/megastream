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
    Trash2,
    Loader2,
  } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { Storage } from 'megajs';
  import { MegaService, type MegaNode } from '../mega';
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
    poster?: string | null;
  }

  let pool = $state<MegaNode[]>([]);
  let history = $state<ShortsEntry[]>([]);
  let cursor = $state(-1);
  const current = $derived(history[cursor] ?? null);
  const prevEntry = $derived(cursor > 0 ? history[cursor - 1] : null);
  const redoEntry = $derived(
    cursor >= 0 && cursor < history.length - 1 ? history[cursor + 1] : null
  );

  let paused = $state(false);
  let muted = $state(false);
  let fullscreen = $state(false);

  let navLock = false;
  let disposed = false;
  let consecutiveErrors = 0;

  // --- Two media slots: the active one plays, the standby one preloads the
  // next random pick (2 connections, paused at its scene start) so a forward
  // swipe can slide an already-buffered video in. ---
  interface Slot {
    entry: ShortsEntry | null;
    url: string | null;
    loading: boolean;
    hasFrame: boolean;
    gen: number;
  }

  function emptySlot(): Slot {
    return { entry: null, url: null, loading: false, hasFrame: false, gen: 0 };
  }

  let slots = $state<[Slot, Slot]>([emptySlot(), emptySlot()]);
  let active = $state(0);
  let slotEls = $state<(HTMLVideoElement | undefined)[]>([undefined, undefined]);
  const slotCleanups: (null | (() => void))[] = [null, null];

  const videoEl = $derived(slotEls[active]);
  const activeLoading = $derived(!slots[active].url || slots[active].loading);
  const standbyIdx = $derived(1 - active);

  function cleanupSlotStream(i: number) {
    slotCleanups[i]?.();
    slotCleanups[i] = null;
    slots[i].url = null;
    slots[i].hasFrame = false;
  }

  function clearSlot(i: number) {
    slots[i].gen++;
    cleanupSlotStream(i);
    slots[i].entry = null;
    slots[i].loading = false;
  }

  async function loadSlot(i: number, entry: ShortsEntry, opts: { preload: boolean }) {
    const gen = ++slots[i].gen;
    cleanupSlotStream(i);
    slots[i].entry = entry;
    slots[i].loading = true;
    const tracked = slots[i].entry!;
    if (tracked.poster === undefined) {
      tracked.poster = null;
      getStoredThumbnail(tracked.node.id, tracked.node.node).then((p) => {
        if (p) tracked.poster = p;
      });
    }
    try {
      // Preloads use fewer connections so they never starve the live stream
      // (MEGA throttles parallel connections; same pattern as downloads).
      const { url, cleanup } = await createStreamUrl(entry.node.node, {
        maxConnections: opts.preload ? 2 : 4,
      });
      if (slots[i].gen !== gen || disposed) {
        cleanup();
        return;
      }
      slotCleanups[i] = cleanup;
      slots[i].url = url;
      slots[i].loading = false;
    } catch (err) {
      if (slots[i].gen !== gen || disposed) return;
      slots[i].loading = false;
      if (opts.preload) {
        clearSlot(i);
      } else {
        showStreamErrorToast('Shorts stream failed', err);
        failAdvance();
      }
    }
  }

  $effect(() => () => {
    disposed = true;
    clearSlot(0);
    clearSlot(1);
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
      clearSlot(0);
      clearSlot(1);
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

  // --- Random picking ---
  function recentIds(): string[] {
    const ids: string[] = [];
    const standbyId = slots[standbyIdx].entry?.node.id;
    if (standbyId) ids.push(standbyId);
    for (let i = cursor; i >= 0 && ids.length < 6; i--) {
      const id = history[i]?.node.id;
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  async function pickEntry(): Promise<ShortsEntry | null> {
    while (pool.length > 0) {
      const video = pickRandomVideo(pool, recentIds());
      if (!video) break;
      const data = await getStoredScenes(video.id, video.node);
      if (disposed) return null;
      if (!data || data.scenes.length === 0) {
        // Sidecar listed but unreadable/empty — drop it and re-pick.
        pool = pool.filter((v) => v.id !== video.id);
        continue;
      }
      return {
        node: video,
        scenes: data.scenes,
        sceneIndex: Math.floor(Math.random() * data.scenes.length),
      };
    }
    showToast('No videos with scene data left', 'warning');
    onExit();
    return null;
  }

  let prefetchLock = false;

  async function ensurePrefetch() {
    if (disposed || prefetchLock) return;
    if (cursor !== history.length - 1) return; // only prefetch at the head
    if (slots[standbyIdx].entry) return;
    prefetchLock = true;
    try {
      const entry = await pickEntry();
      if (!entry || disposed) return;
      if (cursor !== history.length - 1 || slots[standbyIdx].entry) return;
      loadSlot(standbyIdx, entry, { preload: true });
    } finally {
      prefetchLock = false;
    }
  }

  // --- Slide animation ---
  const SLIDE_MS = 300;
  let offsetX = $state(0);
  let animating = $state<null | 'forward' | 'back'>(null);
  let resetting = $state(false);

  function runSlide(dir: 'forward' | 'back'): Promise<void> {
    return new Promise((resolve) => {
      animating = dir;
      offsetX = (dir === 'forward' ? -1 : 1) * window.innerWidth;
      setTimeout(resolve, SLIDE_MS);
    });
  }

  function finishSlide() {
    resetting = true;
    animating = null;
    offsetX = 0;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resetting = false;
      });
    });
  }

  function playActive() {
    const el = slotEls[active];
    if (!el || !slots[active].entry) return;
    consecutiveErrors = 0;
    el.play().catch(() => {
      paused = true;
    });
  }

  function swapActiveToFresh(entry: ShortsEntry) {
    const old = active;
    active = 1 - active;
    loadSlot(active, entry, { preload: false });
    clearSlot(old);
    finishSlide();
  }

  // --- Navigation ---
  async function advanceForward() {
    if (navLock || disposed || animating) {
      offsetX = 0;
      return;
    }
    navLock = true;
    try {
      if (cursor === -1) {
        // Very first entry — no animation.
        const entry = await pickEntry();
        if (!entry) return;
        history = [entry];
        cursor = 0;
        loadSlot(active, entry, { preload: false });
        return;
      }
      if (redoEntry) {
        // Forward through existing history — poster slides in, fresh stream.
        await runSlide('forward');
        cursor++;
        swapActiveToFresh(history[cursor]);
        return;
      }
      const sIdx = standbyIdx;
      if (slots[sIdx].entry && slots[sIdx].url) {
        // Preloaded next — slide it in and keep its (already-buffering) stream.
        await runSlide('forward');
        const entry = slots[sIdx].entry!;
        history = [...history, entry];
        cursor = history.length - 1;
        const old = active;
        active = sIdx;
        clearSlot(old);
        finishSlide();
        playActive();
        ensurePrefetch();
        return;
      }
      // Prefetch not ready (rapid swipes / startup) — slide to an empty panel,
      // then pick and load into it.
      await runSlide('forward');
      const old = active;
      active = 1 - active;
      clearSlot(active);
      clearSlot(old);
      finishSlide();
      const entry = await pickEntry();
      if (!entry) return;
      history = [...history, entry];
      cursor = history.length - 1;
      loadSlot(active, entry, { preload: false });
    } finally {
      navLock = false;
    }
  }

  async function goBack() {
    if (navLock || disposed || animating || cursor <= 0) {
      offsetX = 0;
      return;
    }
    navLock = true;
    try {
      await runSlide('back');
      cursor--;
      swapActiveToFresh(history[cursor]);
    } finally {
      navLock = false;
    }
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

  // --- Delete current video (to MEGA's Rubbish Bin) then advance ---
  let deleting = $state(false);

  async function deleteCurrent() {
    const entry = current;
    if (!entry || deleting || navLock || animating) return;
    deleting = true;
    try {
      await MegaService.deleteFile(entry.node.node);
    } catch (err) {
      if (!disposed) {
        showToast(err instanceof Error ? err.message : 'Failed to delete video');
        deleting = false;
      }
      return;
    }
    if (disposed) return;
    const id = entry.node.id;
    pool = pool.filter((v) => v.id !== id);
    if (slots[standbyIdx].entry?.node.id === id) clearSlot(standbyIdx);
    // Drop the deleted video from history (redo entries included) and step back
    // one position so advanceForward slides the next video in.
    history = history.slice(0, cursor).filter((h) => h.node.id !== id);
    cursor = history.length - 1;
    deleting = false;
    showToast(`Moved to Rubbish Bin: ${entry.node.name}`, 'warning', 4000);
    advanceForward();
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

  // --- Slot <video> events ---
  function onSlotMetadata(i: number) {
    const el = slotEls[i];
    const entry = slots[i].entry;
    if (!el || !entry) return;
    const scene = entry.scenes[entry.sceneIndex];
    if (scene && scene.start > 0.1) el.currentTime = scene.start;
    if (i === active) {
      consecutiveErrors = 0;
      el.play().catch(() => {
        paused = true;
      });
      ensurePrefetch();
    } else {
      el.pause();
    }
  }

  function onSlotError(i: number) {
    const el = slotEls[i];
    const e = el?.error;
    if (!e) return;
    // src teardown during cleanup fires a spurious "empty src" error
    if (e.code === 4 && !el?.currentSrc) return;
    if (i !== active) {
      // Broken preload — drop it so the next advance picks fresh.
      clearSlot(i);
      return;
    }
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

  // --- Fullscreen / orientation (user-initiated via the button or `f`;
  // landscape lock is best-effort and only possible while fullscreen) ---
  $effect(() => {
    const onFs = () => {
      fullscreen = !!document.fullscreenElement;
      if (document.fullscreenElement) {
        (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })
          ?.lock?.('landscape')
          .catch(() => {});
      }
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

  function onPointerDown(e: PointerEvent) {
    if (gesture || animating) return;
    gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    wakeControls();
  }

  function onPointerMove(e: PointerEvent) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      // Rubber-band when there's nothing to go back to.
      offsetX = dx > 0 && cursor <= 0 ? dx * 0.25 : dx;
    } else {
      offsetX = 0;
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!gesture || e.pointerId !== gesture.id) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    const dt = performance.now() - gesture.t;
    gesture = null;
    resolveGesture(dx, dy, dt, e.clientX);
  }

  function onPointerCancel(e: PointerEvent) {
    if (gesture && e.pointerId === gesture.id) {
      gesture = null;
      offsetX = 0;
    }
  }

  // The finger moves the content: dragging LEFT advances to the new video
  // sitting "on the right", dragging UP moves down to the next scene — the
  // usual shorts convention. Flip the four calls here if it feels inverted.
  function resolveGesture(dx: number, dy: number, dt: number, x: number) {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < TAP_MAX_DIST && ay < TAP_MAX_DIST) {
      offsetX = 0;
      if (dt < TAP_MAX_MS) handleTap(x);
      return;
    }
    if (ax >= ay) {
      if (ax < SWIPE_THRESHOLD) {
        offsetX = 0;
        return;
      }
      // advanceForward/goBack animate from the current drag offset, or snap
      // the panels back themselves when they can't run.
      if (dx < 0) advanceForward();
      else goBack();
    } else {
      offsetX = 0;
      if (ay < SWIPE_THRESHOLD) return;
      if (dy < 0) nextScene();
      else prevScene();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowRight':
      case 'd':
        e.preventDefault();
        advanceForward();
        break;
      case 'ArrowLeft':
      case 'a':
        e.preventDefault();
        goBack();
        break;
      case 'ArrowDown':
      case 's':
        e.preventDefault();
        nextScene();
        break;
      case 'ArrowUp':
      case 'w':
        e.preventDefault();
        prevScene();
        break;
      case 'z':
        skipBy(-SKIP_SECONDS);
        break;
      case 'x':
        skipBy(SKIP_SECONDS);
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

  // --- Auto-fading controls (mouse movement wakes them; pause pins them) ---
  let controlsVisible = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function wakeControls() {
    controlsVisible = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      controlsVisible = false;
    }, 2500);
  }

  const hudVisible = $derived(controlsVisible || paused);

  $effect(() => {
    // Also restarts the fade timer on resume, so the HUD doesn't vanish
    // the instant playback continues after a pause.
    void paused;
    wakeControls();
    return () => clearTimeout(hideTimer);
  });

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  const panelTransition = $derived(
    gesture || resetting ? '' : 'transition-transform duration-300 ease-out'
  );
</script>

<svelte:window onkeydown={onKeyDown} />

<div
  class="fixed inset-0 z-50 bg-black text-gray-100 overflow-hidden select-none"
  style="touch-action: none; overscroll-behavior: contain;"
  role="presentation"
  onmousemove={wakeControls}
>
  <!-- Previous entry peeking in from the left on a back drag -->
  {#if prevEntry}
    <div
      class="absolute inset-0 {panelTransition}"
      style:transform="translateX(calc(-100% + {offsetX}px))"
    >
      {#if prevEntry.poster}
        <img src={prevEntry.poster} alt="" class="absolute inset-0 w-full h-full object-contain" />
      {/if}
    </div>
  {/if}

  <!-- Media slots: the active one plays at offsetX, the standby one holds the
       preloaded next pick just offscreen to the right -->
  {#each [0, 1] as i (i)}
    <div
      class="absolute inset-0 {panelTransition}"
      style:transform={i === active
        ? `translateX(${offsetX}px)`
        : `translateX(calc(100% + ${offsetX}px))`}
    >
      {#if slots[i].entry?.poster && !slots[i].hasFrame}
        <img
          src={slots[i].entry?.poster}
          alt=""
          class="absolute inset-0 w-full h-full object-contain {slots[i].url ? '' : 'opacity-50'}"
        />
      {/if}
      {#if slots[i].url}
        <video
          bind:this={slotEls[i]}
          src={slots[i].url}
          autoplay={i === active}
          playsinline
          preload="auto"
          muted={i === active ? muted : true}
          onloadedmetadata={() => onSlotMetadata(i)}
          onloadeddata={() => (slots[i].hasFrame = true)}
          onended={() => i === active && advanceForward()}
          onerror={() => onSlotError(i)}
          onplay={() => i === active && (paused = false)}
          onpause={() => i === active && (paused = true)}
          class="absolute inset-0 w-full h-full object-contain"
        >
          <track kind="captions" />
        </video>
      {/if}
      {#if i !== active && slots[i].loading}
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-8 h-8 border-4 border-gray-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {/if}
    </div>
  {/each}

  <!-- Incoming panel on the right when the standby slot has nothing to show:
       redo through history (poster) or a not-yet-picked fresh entry -->
  {#if !slots[standbyIdx].entry}
    <div
      class="absolute inset-0 {panelTransition}"
      style:transform="translateX(calc(100% + {offsetX}px))"
    >
      {#if redoEntry?.poster}
        <img src={redoEntry.poster} alt="" class="absolute inset-0 w-full h-full object-contain" />
      {:else}
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-8 h-8 border-4 border-gray-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      {/if}
    </div>
  {/if}

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

  {#if activeLoading}
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
    class="absolute inset-x-0 top-0 z-20 p-4 bg-gradient-to-b from-black/70 to-transparent flex items-start gap-3 transition-opacity duration-300 {hudVisible
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
      onclick={deleteCurrent}
      disabled={!current || deleting}
      class="shrink-0 p-2 rounded-full bg-black/40 hover:bg-red-600/80 disabled:opacity-40 transition-colors"
      aria-label="Delete video"
      title="Delete video (moves to Rubbish Bin)"
    >
      {#if deleting}<Loader2 size={18} class="animate-spin" />{:else}<Trash2 size={18} />{/if}
    </button>
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
    class="absolute right-3 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-2 transition-opacity duration-300 {hudVisible
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
