<script lang="ts">
  import { LogIn, Loader2, AlertCircle } from '@lucide/svelte';

  let { onLogin } = $props<{
    onLogin: (email: string, password: string) => Promise<void>;
  }>();

  let email = $state('');
  let password = $state('');
  let loading = $state(false);
  let error = $state<string | null>(null);

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    loading = true;
    error = null;
    try {
      await onLogin(email.trim(), password);
    } catch (err: any) {
      error = err?.message || 'Login failed';
    } finally {
      loading = false;
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-md bg-gray-900 rounded-2xl p-8 border border-gray-800 shadow-xl">
    <div class="text-center mb-8">
      <div class="bg-red-600/20 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
        <LogIn class="text-red-500" size={32} />
      </div>
      <h1 class="text-2xl font-bold mb-2">MegaStream</h1>
      <p class="text-gray-400 text-sm">Sign in to your Mega.nz account</p>
    </div>

    {#if error}
      <div class="bg-red-900/20 border border-red-900/50 text-red-400 p-3 rounded-lg flex items-start gap-2 mb-4 text-sm">
        <AlertCircle class="flex-shrink-0 mt-0.5" size={16} />
        <p class="break-words">{error}</p>
      </div>
    {/if}

    <form onsubmit={handleSubmit} class="space-y-4">
      <div>
        <label for="email" class="block text-sm text-gray-400 mb-1">Email</label>
        <input
          id="email"
          type="email"
          bind:value={email}
          required
          autocomplete="email"
          disabled={loading}
          class="w-full bg-gray-800 border border-gray-700 rounded-lg py-2 px-3 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
        />
      </div>
      <div>
        <label for="password" class="block text-sm text-gray-400 mb-1">Password</label>
        <input
          id="password"
          type="password"
          bind:value={password}
          required
          autocomplete="current-password"
          disabled={loading}
          class="w-full bg-gray-800 border border-gray-700 rounded-lg py-2 px-3 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
        />
      </div>
      <button
        type="submit"
        disabled={loading || !email.trim() || !password}
        class="w-full bg-red-600 hover:bg-red-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white py-2 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
      >
        {#if loading}
          <Loader2 class="animate-spin" size={18} />
          <span>Signing in...</span>
        {:else}
          <span>Sign in</span>
        {/if}
      </button>
    </form>

    <p class="text-xs text-gray-500 text-center mt-6 leading-relaxed">
      Session is stored locally in your browser.<br/>
      Use the logout button to clear it.
    </p>
  </div>
</div>
