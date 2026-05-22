<script lang="ts">
  import { Upload, X, CheckCircle2, AlertCircle, Loader2 } from '@lucide/svelte';
  import { uploads, clearFinishedUploads, cancelUpload } from '../upload.svelte';

  let collapsed = $state(false);

  const jobs = $derived(uploads.jobs);
  const active = $derived(
    jobs.filter((j) => j.status === 'uploading' || j.status === 'queued').length
  );

  function formatSize(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let i = 0;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return `${size.toFixed(size >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }
</script>

{#if jobs.length > 0}
  <div class="fixed bottom-4 right-4 z-40 w-80 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden">
    <button
      type="button"
      onclick={() => (collapsed = !collapsed)}
      class="w-full flex items-center justify-between px-4 py-2 bg-gray-800 hover:bg-gray-700 transition-colors text-left"
    >
      <div class="flex items-center gap-2 text-sm text-gray-200">
        <Upload size={14} class="text-red-400" />
        <span class="font-medium">Uploads</span>
        <span class="text-gray-500">
          {active > 0 ? `${active} active · ${jobs.length} total` : `${jobs.length}`}
        </span>
      </div>
      {#if active === 0}
        <span
          role="button"
          tabindex="0"
          onclick={(e) => { e.stopPropagation(); clearFinishedUploads(); }}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); clearFinishedUploads(); }
          }}
          class="text-xs text-gray-500 hover:text-gray-200"
        >
          Clear
        </span>
      {/if}
    </button>

    {#if !collapsed}
      <div class="max-h-72 overflow-y-auto divide-y divide-gray-800">
        {#each jobs as job (job.id)}
          {@const pct = job.size > 0 ? Math.min(100, (job.uploaded / job.size) * 100) : 0}
          <div class="p-3 text-xs">
            <div class="flex items-start gap-2">
              <div class="mt-0.5 flex-shrink-0">
                {#if job.status === 'uploading'}
                  <Loader2 size={14} class="text-red-400 animate-spin" />
                {:else if job.status === 'queued'}
                  <Loader2 size={14} class="text-gray-500" />
                {:else if job.status === 'done'}
                  <CheckCircle2 size={14} class="text-green-400" />
                {:else if job.status === 'error'}
                  <AlertCircle size={14} class="text-red-400" />
                {:else}
                  <X size={14} class="text-gray-500" />
                {/if}
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-gray-100 truncate" title={job.name}>{job.name}</p>
                <div class="flex justify-between text-[10px] text-gray-500 mt-0.5">
                  <span>
                    {#if job.status === 'done'}
                      {formatSize(job.size)} · Done
                    {:else if job.status === 'error'}
                      {job.error ?? 'Failed'}
                    {:else if job.status === 'cancelled'}
                      Cancelled
                    {:else if job.status === 'queued'}
                      Queued
                    {:else}
                      {formatSize(job.uploaded)} / {formatSize(job.size)}
                    {/if}
                  </span>
                  {#if job.status === 'uploading' || job.status === 'queued'}
                    <span>{pct.toFixed(0)}%</span>
                  {/if}
                </div>
                {#if job.status === 'uploading' || job.status === 'queued'}
                  <div class="mt-1 h-1 bg-gray-800 rounded overflow-hidden">
                    <div
                      class="h-full bg-red-500 transition-[width] duration-150"
                      style="width: {pct}%"
                    ></div>
                  </div>
                {/if}
              </div>
              {#if job.status === 'uploading' || job.status === 'queued'}
                <button
                  type="button"
                  onclick={() => cancelUpload(job.id)}
                  class="text-gray-500 hover:text-red-400 p-0.5"
                  title="Cancel"
                  aria-label="Cancel"
                >
                  <X size={14} />
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
