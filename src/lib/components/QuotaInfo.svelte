<script lang="ts">
  import { HardDrive, ArrowDownToLine } from '@lucide/svelte';

  let { spaceUsed, spaceTotal, bandwidthUsed, bandwidthTotal } = $props<{
    spaceUsed?: number;
    spaceTotal?: number;
    bandwidthUsed?: number;
    bandwidthTotal?: number;
  }>();

  function fmt(bytes?: number): string {
    if (bytes === undefined || bytes === null || !isFinite(bytes) || bytes < 0) return '—';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function pct(used?: number, total?: number): number {
    if (!total || !used || total <= 0) return 0;
    return Math.max(0, Math.min(100, (used / total) * 100));
  }

  // Mega returns a 10PB fallback for unlimited; treat anything > 1PB as no limit
  const TB = 1024 ** 4;
  const UNLIMITED = 1024 * TB;

  const hasStorage = $derived(spaceTotal && spaceTotal > 0 && spaceTotal < UNLIMITED);
  const hasBandwidth = $derived(
    bandwidthTotal && bandwidthTotal > 0 && bandwidthTotal < UNLIMITED
  );
  const storagePct = $derived(pct(spaceUsed, spaceTotal));
  const bandwidthPct = $derived(pct(bandwidthUsed, bandwidthTotal));

  function barColor(p: number): string {
    if (p >= 90) return 'bg-red-500';
    if (p >= 70) return 'bg-amber-500';
    return 'bg-emerald-500';
  }
</script>

{#if hasStorage || hasBandwidth || bandwidthUsed}
  <div class="flex items-center gap-4 text-xs">
    {#if hasStorage}
      <div
        class="flex items-center gap-2"
        title="Storage: {fmt(spaceUsed)} of {fmt(spaceTotal)} used"
      >
        <HardDrive class="text-gray-400 flex-shrink-0" size={14} />
        <div class="flex flex-col gap-1 min-w-0">
          <span class="text-gray-300 tabular-nums whitespace-nowrap">
            {fmt(spaceUsed)} / {fmt(spaceTotal)}
          </span>
          <div class="w-28 h-1 bg-gray-700 rounded-full overflow-hidden">
            <div class="h-full {barColor(storagePct)} transition-all" style="width: {storagePct}%"></div>
          </div>
        </div>
      </div>
    {/if}

    {#if hasBandwidth}
      <div
        class="flex items-center gap-2"
        title="Transfer: {fmt(bandwidthUsed)} of {fmt(bandwidthTotal)} used"
      >
        <ArrowDownToLine class="text-gray-400 flex-shrink-0" size={14} />
        <div class="flex flex-col gap-1 min-w-0">
          <span class="text-gray-300 tabular-nums whitespace-nowrap">
            {fmt(bandwidthUsed)} / {fmt(bandwidthTotal)}
          </span>
          <div class="w-28 h-1 bg-gray-700 rounded-full overflow-hidden">
            <div class="h-full {barColor(bandwidthPct)} transition-all" style="width: {bandwidthPct}%"></div>
          </div>
        </div>
      </div>
    {:else if bandwidthUsed && bandwidthUsed > 0}
      <div class="flex items-center gap-2" title="Transfer used: {fmt(bandwidthUsed)}">
        <ArrowDownToLine class="text-gray-400 flex-shrink-0" size={14} />
        <span class="text-gray-300 tabular-nums whitespace-nowrap">{fmt(bandwidthUsed)}</span>
      </div>
    {/if}
  </div>
{/if}
