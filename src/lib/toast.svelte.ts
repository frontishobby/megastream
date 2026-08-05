export interface Toast {
  id: number;
  message: string;
  kind: 'error' | 'warning';
}

let nextId = 1;

export const toastState = $state<{ items: Toast[] }>({ items: [] });

export function showToast(message: string, kind: Toast['kind'] = 'error', durationMs = 10000) {
  // Identical message already visible — don't stack duplicates
  if (toastState.items.some((t) => t.message === message)) return;
  const id = nextId++;
  toastState.items.push({ id, message, kind });
  setTimeout(() => dismissToast(id), durationMs);
}

export function dismissToast(id: number) {
  const i = toastState.items.findIndex((t) => t.id === id);
  if (i >= 0) toastState.items.splice(i, 1);
}

// Translates raw download-layer errors into something actionable. The big one
// is MEGA's transfer quota (HTTP 509): megajs surfaces it as "Bandwidth limit
// reached: N seconds until it resets".
export function streamErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const bw = /bandwidth limit reached:?\s*(\d+)/i.exec(raw);
  if (bw) {
    const mins = Math.ceil(parseInt(bw[1], 10) / 60);
    return `MEGA transfer quota exceeded — downloads blocked for ~${mins} min`;
  }
  if (/bandwidth limit|509/i.test(raw)) {
    return 'MEGA transfer quota exceeded (HTTP 509)';
  }
  return raw;
}

export function showStreamErrorToast(context: string, err: unknown) {
  showToast(`${context}: ${streamErrorMessage(err)}`);
}
