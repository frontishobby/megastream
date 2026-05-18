import type { File } from 'megajs';

export interface MegaNode {
  name: string;
  size?: number;
  type: 'file' | 'folder';
  id: string;
  node: File;
}

function fileId(file: File): string {
  if (file.nodeId) return file.nodeId;
  const dl = (file as any).downloadId;
  if (typeof dl === 'string') return dl;
  if (Array.isArray(dl)) return dl.join('/');
  return '';
}

export class MegaService {
  static listChildren(folder: File): MegaNode[] {
    const children = folder.children || [];
    return children.map((child) => ({
      name: child.name || 'Unknown',
      size: child.size,
      type: child.directory ? 'folder' : 'file',
      id: fileId(child),
      node: child,
    }));
  }

  static isVideo(name: string): boolean {
    const videoExtensions = ['.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.ogg', '.ogv'];
    return videoExtensions.some((ext) => name.toLowerCase().endsWith(ext));
  }
}
