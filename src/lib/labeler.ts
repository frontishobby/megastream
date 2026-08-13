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
  /** General booru tags for the frame, tag -> confidence. */
  tags: Record<string, number>;
}

export async function classifyFrame(frame: Blob): Promise<FrameLabel | null> {
  try {
    const res = await fetch(`${labelerUrl()}/classify`, {
      method: 'POST',
      body: frame,
      headers: { 'Content-Type': 'image/jpeg' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const tags: Record<string, number> = {};
    if (data.tags && typeof data.tags === 'object') {
      for (const [tag, conf] of Object.entries(data.tags)) {
        if (typeof conf === 'number') tags[tag] = conf;
      }
    }
    return {
      position: typeof data.position === 'string' ? data.position : null,
      confidence: typeof data.confidence === 'number' ? data.confidence : null,
      tags,
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
