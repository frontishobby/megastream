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
    onSelect,
  } = $props<{
    node: MegaFile;
    depth?: number;
    isRoot?: boolean;
    currentId: string | null;
    expanded: Set<string>;
    onSelect: (node: MegaFile, isRoot: boolean) => void;
  }>();

  const id = $derived((node as unknown as { nodeId?: string }).nodeId);

  const childFolders = $derived(
    ((node.children ?? []) as MegaFile[])
      .filter((c) => c.directory && c.name !== THUMB_FOLDER)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  );

  const fileCount = $derived(
    ((node.children ?? []) as MegaFile[]).filter((c) => !c.directory).length
  );

  const label = $derived(isRoot ? 'Root' : node.name || 'Folder');
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
    : 'text-gray-300 hover:bg-gray-800'}"
  style="padding-left: {depth * 14 + 6}px"
  onclick={select}
  onkeydown={onKey}
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
      <FolderTree node={child} depth={depth + 1} {currentId} {expanded} {onSelect} />
    {/each}
  </div>
{/if}
