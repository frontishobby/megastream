<script lang="ts">
  import { Upload, X, CheckCircle2, AlertCircle, Loader2, Captions } from '@lucide/svelte';
  import {
    uploads,
    clearFinishedUploads,
    cancelUpload,
    requestUploadSubtitles,
    cancelUploadSubtitles,
    type UploadJob,
  } from '../upload.svelte';
  import { labelerHealth } from '../labelerHealth.svelte';
  import { subtitleStageLabel } from '../subtitles.svelte';

  let collapsed = $state(false);

  const jobs = $derived(uploads.jobs);
  const active = $derived(
    jobs.filter(
      (j) =>
        j.status === 'uploading' ||
        j.status === 'queued' ||
        j.status === 'analyzing' ||
        j.status === 'subtitling'
    ).length
  );
  const subtitlesAvailable = $derived(!!labelerHealth.value?.subtitles);

  // Offered while the local file is still around (until the upload and
  // scene scan finish); once requested it stays visible to cancel.
  function showSubtitleToggle(job: UploadJob): boolean {
    if (!job.canSubtitle || job.subtitles?.error) return false;
    // While subtitling, the row's X already cancels them.
    if (job.subtitles) return job.status !== 'done' && job.status !== 'subtitling';
    return (
      subtitlesAvailable &&
      (job.status === 'queued' || job.status === 'uploading' || job.status === 'analyzing')
    );
  }

  function toggleSubtitles(job: UploadJob) {
    if (job.subtitles) cancelUploadSubtitles(job.id);
    else requestUploadSubtitles(job.id);
  }

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
  <div class="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden">
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
                {:else if job.status === 'analyzing'}
                  <Loader2 size={14} class="text-amber-400 animate-spin" />
                {:else if job.status === 'subtitling'}
                  <Loader2 size={14} class="text-sky-400 animate-spin" />
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
                    {:else if job.status === 'analyzing'}
                      Uploaded · Detecting scenes… {job.analysisPct != null
                        ? `${job.analysisPct}%`
                        : ''}
                    {:else if job.status === 'subtitling'}
                      Uploaded
                    {:else}
                      {formatSize(job.uploaded)} / {formatSize(job.size)}{job.analysisPct !=
                      null
                        ? ` · Scan ${job.analysisPct}%`
                        : ''}
                    {/if}
                  </span>
                  {#if job.status === 'uploading' || job.status === 'queued'}
                    <span>{pct.toFixed(0)}%</span>
                  {/if}
                </div>
                {#if job.subtitles}
                  <p
                    class="mt-0.5 text-[10px] truncate {job.subtitles.error
                      ? 'text-red-400'
                      : 'text-sky-300/80'}"
                    title={job.subtitles.error}
                  >
                    {#if job.subtitles.error}
                      Subtitles failed: {job.subtitles.error}
                    {:else if job.subtitles.ready && job.status !== 'subtitling'}
                      Subtitles ready · saving after upload
                    {:else}
                      Subtitles · {subtitleStageLabel(job.subtitles)}
                    {/if}
                  </p>
                {/if}
                {#if job.status === 'uploading' || job.status === 'queued'}
                  <div class="mt-1 h-1 bg-gray-800 rounded overflow-hidden">
                    <div
                      class="h-full bg-red-500 transition-[width] duration-150"
                      style="width: {pct}%"
                    ></div>
                  </div>
                {/if}
              </div>
              {#if showSubtitleToggle(job)}
                <button
                  type="button"
                  onclick={() => toggleSubtitles(job)}
                  class="p-0.5 {job.subtitles
                    ? 'text-sky-400 hover:text-red-400'
                    : 'text-gray-500 hover:text-sky-300'}"
                  title={job.subtitles ? 'Cancel subtitles' : 'Generate subtitles after upload'}
                  aria-label={job.subtitles ? 'Cancel subtitles' : 'Generate subtitles after upload'}
                  aria-pressed={!!job.subtitles}
                >
                  <Captions size={14} />
                </button>
              {/if}
              {#if job.status === 'uploading' || job.status === 'queued' || job.status === 'analyzing' || job.status === 'subtitling'}
                <button
                  type="button"
                  onclick={() => cancelUpload(job.id)}
                  class="text-gray-500 hover:text-red-400 p-0.5"
                  title={job.status === 'analyzing'
                    ? 'Skip scene detection'
                    : job.status === 'subtitling'
                      ? 'Cancel subtitles'
                      : 'Cancel'}
                  aria-label={job.status === 'analyzing'
                    ? 'Skip scene detection'
                    : job.status === 'subtitling'
                      ? 'Cancel subtitles'
                      : 'Cancel'}
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
