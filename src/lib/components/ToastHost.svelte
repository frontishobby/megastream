<script lang="ts">
  import { AlertTriangle, X } from '@lucide/svelte';
  import { toastState, dismissToast } from '../toast.svelte';
</script>

{#if toastState.items.length > 0}
  <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[calc(100vw-2rem)] max-w-sm">
    {#each toastState.items as t (t.id)}
      <div
        class="bg-gray-900 border rounded-lg shadow-xl px-4 py-3 flex items-start gap-3 text-sm
          {t.kind === 'error' ? 'border-red-800 text-red-200' : 'border-amber-700 text-amber-100'}"
      >
        <AlertTriangle
          size={16}
          class="shrink-0 mt-0.5 {t.kind === 'error' ? 'text-red-400' : 'text-amber-400'}"
        />
        <p class="flex-1 break-words">{t.message}</p>
        <button
          type="button"
          onclick={() => dismissToast(t.id)}
          class="text-gray-500 hover:text-gray-300 shrink-0"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    {/each}
  </div>
{/if}
