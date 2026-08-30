import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Deployed version shown in the footer: HEAD commit time as YYMMddhhmm
// (committer's own timezone, so local commits read as KST even on CI).
function buildVersion(): string {
  try {
    return execSync('git log -1 --format=%cd --date=format:%y%m%d%H%M', {
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'dev'
  }
}

// https://vite.dev/config/
export default defineConfig(() => ({
  base: '/',
  plugins: [svelte()],
  define: {
    'global': 'globalThis',
    __BUILD_VERSION__: JSON.stringify(buildVersion()),
  },
  resolve: {
    alias: {
      buffer: 'buffer'
    }
  },
  optimizeDeps: {
    include: ['megajs', 'buffer']
  }
}))
