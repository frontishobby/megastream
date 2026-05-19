import type { File, MutableFile } from 'megajs';

export interface MegaNode {
  name: string;
  size?: number;
  type: 'file' | 'folder';
  id: string;
  memo?: string;
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

export class MegaService {
  static listChildren(folder: File): MegaNode[] {
    const children = folder.children || [];
    return children.map((child) => ({
      name: child.name || 'Unknown',
      size: child.size,
      type: child.directory ? 'folder' : 'file',
      id: fileId(child),
      memo: readMemo(child),
      node: child,
    }));
  }

  static isVideo(name: string): boolean {
    const videoExtensions = ['.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.ogg', '.ogv'];
    return videoExtensions.some((ext) => name.toLowerCase().endsWith(ext));
  }

  static async setMemo(file: File, memo: string): Promise<string | undefined> {
    const trimmed = memo.trim();
    const value = trimmed.length > 0 ? trimmed : undefined;
    await (file as MutableFile).setAttributes({ _memo: value } as unknown as JSON);
    return value;
  }
}
