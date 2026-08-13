// Client for the local scene labeler (labeler/server.py). The server is a
// stateless "image in, label out" service on localhost; everything else
// (scene detection, MEGA writes) stays in the browser, so the app keeps
// working without it — scenes just get no position tags.

export const DEFAULT_LABELER_URL = 'http://127.0.0.1:8756';

export function labelerUrl(): string {
  try {
    return localStorage.getItem('megastream.labelerUrl') || DEFAULT_LABELER_URL;
  } catch (_) {
    return DEFAULT_LABELER_URL;
  }
}

export async function probeLabeler(timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`${labelerUrl()}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true;
  } catch (_) {
    return false;
  }
}

export interface FrameLabel {
  position: string | null;
  confidence: number | null;
  /** Best tag probability per position label (all candidates, not just the winner). */
  positions: Record<string, number>;
  /** General booru tags for the frame, tag -> confidence. */
  tags: Record<string, number>;
}

export async function classifyFrame(frame: Blob, mediaTime?: number): Promise<FrameLabel | null> {
  try {
    // media time rides along purely so the server log shows where in the
    // video each classification happened.
    const q = mediaTime != null ? `?t=${mediaTime.toFixed(1)}` : '';
    const res = await fetch(`${labelerUrl()}/classify${q}`, {
      method: 'POST',
      body: frame,
      headers: { 'Content-Type': 'image/jpeg' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const readMap = (obj: unknown): Record<string, number> => {
      const out: Record<string, number> = {};
      if (obj && typeof obj === 'object') {
        for (const [key, val] of Object.entries(obj)) {
          if (typeof val === 'number') out[key] = val;
        }
      }
      return out;
    };
    return {
      position: typeof data.position === 'string' ? data.position : null,
      confidence: typeof data.confidence === 'number' ? data.confidence : null,
      positions: readMap(data.positions),
      tags: readMap(data.tags),
    };
  } catch (err) {
    console.warn('Frame classification failed', err);
    return null;
  }
}

export type SceneAnalysisMode = 'labeled' | 'static' | 'skip';

/**
 * Decides how scene analysis should run: use the labeler when it responds;
 * otherwise ask whether plain (untagged) detection is acceptable.
 */
export async function resolveSceneAnalysisMode(): Promise<SceneAnalysisMode> {
  if (await probeLabeler()) return 'labeled';
  const ok = window.confirm(
    `Scene labeler is not reachable at ${labelerUrl()}.\n` +
      'Run basic scene detection without position tags instead?'
  );
  return ok ? 'static' : 'skip';
}
