<script lang="ts" module>
  // The folder currently being dragged, shared by every row of the tree so
  // each row can decide whether it is a valid drop target during dragover
  // (dataTransfer contents are unreadable until drop).
  let dragging = $state<{ id: string; parentId: string | null } | null>(null);
</script>

<script lang="ts">
  import type { File as MegaFile } from 'megajs';
  import { ChevronRight, ChevronDown, Folder, FolderOpen } from '@lucide/svelte';
  import { THUMB_FOLDER } from '../thumbnails';
  import FolderTree from './FolderTree.svelte';

  let {
    node,
    depth = 0,
    isRoot = false,
    currentId,
    expanded,
    version = 0,
    onSelect,
    onMoveFolder,
  } = $props<{
    node: MegaFile;
    depth?: number;
    isRoot?: boolean;
    currentId: string | null;
    expanded: Set<string>;
    /** Bumped by the parent when the (non-reactive) mega tree changes. */
    version?: number;
    onSelect: (node: MegaFile, isRoot: boolean) => void;
    onMoveFolder?: (sourceId: string, target: MegaFile) => void;
  }>();

  const id = $derived((node as unknown as { nodeId?: string }).nodeId);

  const childFolders = $derived.by(() => {
    void version;
    return ((node.children ?? []) as MegaFile[])
      .filter((c) => c.directory && c.name !== THUMB_FOLDER)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  });

  const fileCount = $derived.by(() => {
    void version;
    return ((node.children ?? []) as MegaFile[]).filter((c) => !c.directory).length;
  });

  const label = $derived.by(() => {
    void version;
    return isRoot ? 'Root' : node.name || 'Folder';
  });
  // Root is always open; other folders track the shared expanded set.
  const isOpen = $derived(isRoot || (!!id && expanded.has(id)));
  const isSelected = $derived(isRoot ? currentId === null : currentId === id);
  const hasChildren = $derived(childFolders.length > 0);

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (!id) return;
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
  }

  function select() {
    onSelect(node, isRoot);
  }

  // Counter instead of a boolean: dragenter/dragleave fire for every child
  // element crossed, so a plain flag flickers off mid-drag.
  let dragDepth = $state(0);

  const isDropTarget = $derived.by(() => {
    if (!dragging || !id) return false;
    if (dragging.parentId === id) return false; // already lives here
    // Reject the dragged folder itself and anything inside its subtree.
    for (let cur: MegaFile | undefined = node; cur; cur = cur.parent) {
      if ((cur as unknown as { nodeId?: string }).nodeId === dragging.id) return false;
    }
    return true;
  });
  const dropActive = $derived(isDropTarget && dragDepth > 0);

  function onDragStart(e: DragEvent) {
    if (isRoot || !id) return;
    const parentId =
      ((node.parent ?? undefined) as unknown as { nodeId?: string } | undefined)?.nodeId ?? null;
    dragging = { id, parentId };
    if (e.dataTransfer) {
      e.dataTransfer.setData('application/x-megastream-folder', id);
      e.dataTransfer.effectAllowed = 'move';
    }
  }

  function onDragEnd() {
    dragging = null;
    dragDepth = 0;
  }

  function onDragEnter(e: DragEvent) {
    if (!isDropTarget) return;
    e.preventDefault();
    dragDepth++;
  }

  function onDragOver(e: DragEvent) {
    if (!isDropTarget) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function onDragLeave() {
    if (dragDepth > 0) dragDepth--;
  }

  function onDrop(e: DragEvent) {
    if (!isDropTarget || !dragging) return;
    e.preventDefault();
    const sourceId = dragging.id;
    dragging = null;
    dragDepth = 0;
    onMoveFolder?.(sourceId, node);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    } else if (e.key === 'ArrowRight' && hasChildren && !isOpen && id) {
      expanded.add(id);
    } else if (e.key === 'ArrowLeft' && hasChildren && isOpen && id && !isRoot) {
      expanded.delete(id);
    }
  }
</script>

<div
  role="treeitem"
  aria-expanded={hasChildren ? isOpen : undefined}
  aria-selected={isSelected}
  tabindex="0"
  class="flex items-center gap-1 rounded-md py-1 pr-2 cursor-pointer text-sm select-none transition-colors focus:outline-none focus:ring-1 focus:ring-red-500 {isSelected
    ? 'bg-red-600/20 text-white'
    : 'text-gray-300 hover:bg-gray-800'} {dropActive
    ? 'bg-blue-500/20 ring-1 ring-inset ring-blue-500'
    : ''}"
  style="padding-left: {depth * 14 + 6}px"
  draggable={!isRoot}
  onclick={select}
  onkeydown={onKey}
  ondragstart={onDragStart}
  ondragend={onDragEnd}
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {#if hasChildren && !isRoot}
    <button
      type="button"
      onclick={toggle}
      class="shrink-0 text-gray-500 hover:text-gray-200 p-0.5 -m-0.5 rounded"
      aria-label={isOpen ? 'Collapse' : 'Expand'}
    >
      {#if isOpen}
        <ChevronDown size={14} />
      {:else}
        <ChevronRight size={14} />
      {/if}
    </button>
  {:else}
    <span class="shrink-0 w-[18px]"></span>
  {/if}

  {#if isOpen}
    <FolderOpen size={16} class={isSelected ? 'text-red-300' : 'text-blue-400'} />
  {:else}
    <Folder size={16} class={isSelected ? 'text-red-300' : 'text-blue-400'} />
  {/if}

  <span class="flex-1 truncate">{label}</span>

  {#if fileCount > 0}
    <span
      class="shrink-0 pl-1 text-[11px] tabular-nums {isSelected
        ? 'text-red-200/80'
        : 'text-gray-500'}"
    >
      {fileCount}
    </span>
  {/if}
</div>

{#if isOpen && hasChildren}
  <div role="group">
    {#each childFolders as child (child.nodeId)}
      <FolderTree
        node={child}
        depth={depth + 1}
        {currentId}
        {expanded}
        {version}
        {onSelect}
        {onMoveFolder}
      />
    {/each}
  </div>
{/if}
