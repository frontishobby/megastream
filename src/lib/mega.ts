import type { File, MutableFile } from 'megajs';
import { THUMB_FOLDER } from './thumbnails';

export interface MegaNode {
  name: string;
  size?: number;
  type: 'file' | 'folder';
  id: string;
  memo?: string;
  /** Video-level descriptive tags mirrored from scene analysis (_tags). */
  tags?: string[];
  node: File;
}

function fileId(file: File): string {
  if (file.nodeId) return file.nodeId;
  const dl = (file as any).downloadId;
  if (typeof dl === 'string') return dl;
  if (Array.isArray(dl)) return dl.join('/');
  return '';
}

function readMemo(file: File): string | undefined {
  const attrs = (file as any).attributes;
  const m = attrs?._memo;
  return typeof m === 'string' && m.length > 0 ? m : undefined;
}

function readTags(file: File): string[] | undefined {
  const attrs = (file as any).attributes;
  const t = attrs?._tags;
  if (typeof t !== 'string' || t.length === 0) return undefined;
  const tags = t.split(',').map((x) => x.trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

export class MegaService {
  static listChildren(folder: File): MegaNode[] {
    const children = (folder.children || []).filter(
      (child) => !(child.directory && child.name === THUMB_FOLDER)
    );
    return children.map((child) => ({
      name: child.name || 'Unknown',
      size: child.size,
      type: child.directory ? 'folder' : 'file',
      id: fileId(child),
      memo: readMemo(child),
      tags: readTags(child),
      node: child,
    }));
  }

  static isVideo(name: string): boolean {
    const videoExtensions = ['.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.ogg', '.ogv', '.ts'];
    return videoExtensions.some((ext) => name.toLowerCase().endsWith(ext));
  }

  static async setMemo(file: File, memo: string): Promise<string | undefined> {
    const trimmed = memo.trim();
    const value = trimmed.length > 0 ? trimmed : undefined;
    await (file as MutableFile).setAttributes({ _memo: value } as unknown as JSON);
    return value;
  }

  static async renameFile(file: File, name: string): Promise<string> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Name cannot be empty');
    await (file as MutableFile).rename(trimmed);
    return trimmed;
  }

  static async deleteFile(file: File): Promise<void> {
    // Non-permanent: moves the node to MEGA's Rubbish Bin so it can be recovered.
    await (file as MutableFile).delete(false);
  }
}
