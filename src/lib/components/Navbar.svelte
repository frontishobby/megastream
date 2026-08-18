<script lang="ts">
  import { Play, LogOut, Search, X } from '@lucide/svelte';
  import Breadcrumb from './Breadcrumb.svelte';
  import QuotaInfo from './QuotaInfo.svelte';
  import LabelerStatus from './LabelerStatus.svelte';

  let { path, accountEmail, quota, searchQuery, onSearch, onNavigate, onLogout } = $props<{
    path: { name: string }[];
    accountEmail: string;
    quota: {
      spaceUsed?: number;
      spaceTotal?: number;
      bandwidthUsed?: number;
      bandwidthTotal?: number;
    } | null;
    searchQuery: string;
    onSearch: (query: string) => void;
    onNavigate: (index: number) => void;
    onLogout: () => void;
  }>();
</script>

<nav class="bg-gray-900 text-white p-4 sticky top-0 z-10 shadow-lg">
  <div class="container mx-auto flex flex-col gap-3">
    <div class="flex flex-wrap md:flex-nowrap items-center gap-x-4 gap-y-3">
      <div class="flex items-center gap-2 flex-shrink-0">
        <Play class="text-red-500 fill-current" size={28} />
        <h1 class="text-xl font-bold tracking-tight">MegaPlay</h1>
      </div>
      <div class="order-3 md:order-none w-full md:w-auto md:flex-1 min-w-0">
        <Breadcrumb {path} {onNavigate} />
      </div>
      <div class="order-4 md:order-none w-full md:w-56 lg:w-72 flex-shrink-0 relative">
        <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
        <input
          type="text"
          placeholder="Search videos"
          value={searchQuery}
          oninput={(e) => onSearch(e.currentTarget.value)}
          class="w-full bg-gray-800 text-sm text-gray-100 placeholder-gray-500 rounded-full pl-9 pr-8 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-500"
        />
        {#if searchQuery}
          <button
            type="button"
            aria-label="Clear search"
            onclick={() => onSearch('')}
            class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200 p-0.5"
          >
            <X size={14} />
          </button>
        {/if}
      </div>
      <div class="flex items-center gap-3 flex-shrink-0 ml-auto min-w-0">
        <LabelerStatus />
        {#if quota}
          <div class="hidden lg:block">
            <QuotaInfo
              spaceUsed={quota.spaceUsed}
              spaceTotal={quota.spaceTotal}
              bandwidthUsed={quota.bandwidthUsed}
              bandwidthTotal={quota.bandwidthTotal}
            />
          </div>
        {/if}
        {#if accountEmail}
          <span class="text-gray-400 text-xs hidden md:inline truncate max-w-[180px]">{accountEmail}</span>
        {/if}
        <button
          type="button"
          onclick={onLogout}
          class="flex items-center gap-1.5 text-sm text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-full transition-colors"
        >
          <LogOut size={14} />
          <span>Logout</span>
        </button>
      </div>
    </div>

    {#if quota}
      <div class="lg:hidden border-t border-gray-800 pt-3">
        <QuotaInfo
          spaceUsed={quota.spaceUsed}
          spaceTotal={quota.spaceTotal}
          bandwidthUsed={quota.bandwidthUsed}
          bandwidthTotal={quota.bandwidthTotal}
        />
      </div>
    {/if}
  </div>
</nav>
