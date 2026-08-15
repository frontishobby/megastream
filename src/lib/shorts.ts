import type { Storage, File as MegaFile } from 'megajs';
import { MegaService, type MegaNode } from './mega';
import { findThumbFolder, THUMB_FOLDER } from './thumbnails';
import { isTransportStream } from './stream';

const SCENES_SUFFIX = '.scenes.json';

/**
 * Ids of videos that have a scene sidecar, read from the .megastream folder's
 * child listing alone — node metadata is already in memory, no downloads.
 */
export function listSceneVideoIds(storage: Storage): Set<string> {
  const ids = new Set<string>();
  const folder = findThumbFolder(storage);
  if (!folder) return ids;
  for (const child of folder.children || []) {
    const name = child.name || '';
    if (!child.directory && name.endsWith(SCENES_SUFFIX)) {
      ids.add(name.slice(0, -SCENES_SUFFIX.length));
    }
  }
  return ids;
}

function toMegaNode(id: string, file: MegaFile): MegaNode {
  return {
    name: file.name || 'Unknown',
    size: file.size,
    type: 'file',
    id,
    node: file,
  };
}

// isVideo deliberately keeps .ts (thumbnails only) — playback was removed,
// so shorts must filter transport streams out on top of it.
function isPlayableVideo(name: string): boolean {
  return MegaService.isVideo(name) && !isTransportStream(name);
}

/** Candidate videos for the shorts pool (before scene-data intersection). */
export function collectCandidates(
  storage: Storage,
  scope: 'all' | 'folder',
  folderId?: string
): MegaNode[] {
  const files = (storage as unknown as { files: Record<string, MegaFile> }).files;

  if (scope === 'folder') {
    const folder = folderId ? files[folderId] : undefined;
    if (!folder?.directory) return [];
    return MegaService.listChildren(folder).filter(
      (n) => n.type === 'file' && isPlayableVideo(n.name)
    );
  }

  const root = storage.root as unknown as MegaFile;
  const out: MegaNode[] = [];
  for (const [id, file] of Object.entries(files)) {
    if (file.directory || !isPlayableVideo(file.name || '')) continue;
    // Only files whose ancestor chain reaches root without passing through
    // .megastream count — this drops sidecars and Rubbish Bin/inbox contents
    // (their chains never reach the cloud root).
    let cur: MegaFile | undefined = file.parent;
    let reachesRoot = false;
    while (cur) {
      if (cur.directory && cur.name === THUMB_FOLDER) break;
      if (cur === root) {
        reachesRoot = true;
        break;
      }
      cur = cur.parent;
    }
    if (reachesRoot) out.push(toMegaNode(id, file));
  }
  return out;
}

/** Uniform random pick avoiding recently watched ids; null if pool is empty. */
export function pickRandomVideo(
  pool: MegaNode[],
  recentIds: readonly string[]
): MegaNode | null {
  if (pool.length === 0) return null;
  const recent = new Set(recentIds);
  const fresh = pool.filter((v) => !recent.has(v.id));
  const source = fresh.length > 0 ? fresh : pool;
  return source[Math.floor(Math.random() * source.length)];
}
