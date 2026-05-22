<script lang="ts">
  import { File, Folder, Play, StickyNote, Pencil, Check, X, Loader2 } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { MegaNode } from '../mega';
  import { MegaService } from '../mega';
  import { getThumbnail } from '../thumbnails';

  let { node, onSelect } = $props<{
    node: MegaNode;
    onSelect: (node: MegaNode) => void;
  }>();

  const isVideo = $derived(node.type === 'file' && MegaService.isVideo(node.name));

  let cardEl: HTMLDivElement | undefined = $state();
  let thumbnail = $state<string | null>(null);
  let thumbnailLoading = $state(false);

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

  function handleCardClick(e: MouseEvent) {
    if (editing || renaming) return;
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).closest('[data-card-surface]')) return;
    onSelect(node);
  }

  function handleCardKey(e: KeyboardEvent) {
    if (editing || renaming) return;
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(node);
    }
  }

  function startEdit(e: MouseEvent) {
    e.stopPropagation();
    draft = memo ?? '';
    editing = true;
    saveError = null;
    queueMicrotask(() => textareaEl?.focus());
  }

  function cancelEdit(e?: MouseEvent) {
    e?.stopPropagation();
    editing = false;
    draft = '';
    saveError = null;
  }

  async function saveMemo(e?: MouseEvent) {
    e?.stopPropagation();
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
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveMemo();
    }
  }

  function startRename(e: MouseEvent) {
    e.stopPropagation();
    nameDraft = title;
    renaming = true;
    renameError = null;
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  }

  function cancelRename(e?: MouseEvent) {
    e?.stopPropagation();
    renaming = false;
    nameDraft = '';
    renameError = null;
  }

  async function saveRename(e?: MouseEvent) {
    e?.stopPropagation();
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
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      saveRename();
    }
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

<div
  bind:this={cardEl}
  role="button"
  tabindex="0"
  class="w-full text-left bg-gray-800 rounded-lg overflow-hidden hover:bg-gray-700 transition-colors cursor-pointer group border border-gray-700 flex flex-col focus:outline-none focus:ring-2 focus:ring-red-500"
  onclick={handleCardClick}
  onkeydown={handleCardKey}
>
  <div class="aspect-video bg-gray-900 relative overflow-hidden" data-card-surface>
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

    {#if memo && !editing}
      <div
        class="absolute top-2 right-2 bg-amber-500/90 text-gray-900 rounded-full p-1"
        title="Has a note"
      >
        <StickyNote size={14} />
      </div>
    {/if}
  </div>

  <div class="p-3 flex-1 min-w-0">
    {#if renaming}
      <div>
        <div class="flex items-center gap-1">
          <input
            bind:this={nameInput}
            bind:value={nameDraft}
            onclick={(e) => e.stopPropagation()}
            onkeydown={nameKey}
            disabled={renameSaving}
            maxlength="255"
            class="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-red-500 disabled:opacity-50"
          />
          <button
            type="button"
            onclick={cancelRename}
            disabled={renameSaving}
            class="text-gray-400 hover:text-gray-200 p-1 rounded disabled:opacity-50"
            title="Cancel (Esc)"
            aria-label="Cancel rename"
          >
            <X size={14} />
          </button>
          <button
            type="button"
            onclick={saveRename}
            disabled={renameSaving}
            class="text-green-400 hover:text-green-300 p-1 rounded disabled:opacity-50"
            title="Save (Enter)"
            aria-label="Save rename"
          >
            {#if renameSaving}
              <Loader2 size={14} class="animate-spin" />
            {:else}
              <Check size={14} />
            {/if}
          </button>
        </div>
        {#if renameError}
          <p class="text-red-400 text-[11px] mt-1">{renameError}</p>
        {/if}
      </div>
    {:else}
      <div class="flex items-start gap-1">
        <h3
          class="text-gray-100 text-sm font-medium truncate flex-1 min-w-0"
          title={title}
          data-card-surface
        >
          {title}
        </h3>
        <button
          type="button"
          onclick={startRename}
          class="text-gray-500 hover:text-gray-200 p-0.5 rounded shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          title="Rename"
          aria-label="Rename"
        >
          <Pencil size={12} />
        </button>
      </div>
    {/if}
    <p class="text-gray-400 text-xs mt-1" data-card-surface>
      {node.type === 'folder' ? 'Folder' : formatSize(node.size)}
    </p>

    {#if editing}
      <div class="mt-2">
        <textarea
          bind:this={textareaEl}
          bind:value={draft}
          onclick={(e) => e.stopPropagation()}
          onkeydown={memoKey}
          rows="3"
          maxlength="2000"
          placeholder="Add a note…"
          class="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 resize-none focus:outline-none focus:border-red-500"
        ></textarea>
        {#if saveError}
          <p class="text-red-400 text-[11px] mt-1">{saveError}</p>
        {/if}
        <div class="flex items-center justify-end gap-1 mt-1">
          <button
            type="button"
            onclick={cancelEdit}
            disabled={saving}
            class="text-gray-400 hover:text-gray-200 p-1 rounded disabled:opacity-50"
            title="Cancel (Esc)"
            aria-label="Cancel"
          >
            <X size={14} />
          </button>
          <button
            type="button"
            onclick={saveMemo}
            disabled={saving}
            class="text-green-400 hover:text-green-300 p-1 rounded disabled:opacity-50"
            title="Save (⌘/Ctrl + Enter)"
            aria-label="Save"
          >
            {#if saving}
              <Loader2 size={14} class="animate-spin" />
            {:else}
              <Check size={14} />
            {/if}
          </button>
        </div>
      </div>
    {:else if memo}
      <div class="mt-2 flex items-start gap-1.5">
        <p class="text-amber-300/90 text-xs flex-1 whitespace-pre-wrap break-words line-clamp-3">
          {memo}
        </p>
        <button
          type="button"
          onclick={startEdit}
          class="text-gray-500 hover:text-gray-200 p-0.5 rounded shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          title="Edit note"
          aria-label="Edit note"
        >
          <Pencil size={12} />
        </button>
      </div>
    {:else}
      <button
        type="button"
        onclick={startEdit}
        class="mt-2 text-gray-500 hover:text-gray-200 text-xs inline-flex items-center gap-1"
      >
        <StickyNote size={12} />
        <span>Add note</span>
      </button>
    {/if}
  </div>
</div>
