<script lang="ts">
  import { Play, LogOut } from '@lucide/svelte';
  import Breadcrumb from './Breadcrumb.svelte';
  import QuotaInfo from './QuotaInfo.svelte';

  let { path, accountEmail, quota, onNavigate, onLogout } = $props<{
    path: { name: string }[];
    accountEmail: string;
    quota: {
      spaceUsed?: number;
      spaceTotal?: number;
      bandwidthUsed?: number;
      bandwidthTotal?: number;
    } | null;
    onNavigate: (index: number) => void;
    onLogout: () => void;
  }>();
</script>

<nav class="bg-gray-900 text-white p-4 sticky top-0 z-10 shadow-lg">
  <div class="container mx-auto flex flex-col gap-3">
    <div class="flex flex-col md:flex-row items-stretch md:items-center gap-4">
      <div class="flex items-center gap-2 flex-shrink-0">
        <Play class="text-red-500 fill-current" size={28} />
        <h1 class="text-xl font-bold tracking-tight">MegaStream</h1>
      </div>
      <div class="flex-1 min-w-0">
        <Breadcrumb {path} {onNavigate} />
      </div>
      <div class="flex items-center gap-3 flex-shrink-0">
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
