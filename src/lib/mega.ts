import { File, Storage } from 'megajs';

export interface MegaNode {
  name: string;
  size?: number;
  type: 'file' | 'folder';
  id: string;
  attributes?: any;
  handle?: string;
  node?: any;
}

export class MegaService {
  static async getNodesFromUrl(url: string): Promise<MegaNode[]> {
    try {
      const file = File.fromURL(url);
      await file.loadAttributes();

      if (file.children) {
        return file.children.map(child => ({
          name: child.name || 'Unknown',
          size: child.size,
          type: child.directory ? 'folder' : 'file',
          id: child.handle || '',
          node: child
        }));
      }

      return [{
        name: file.name || 'Unknown',
        size: file.size,
        type: file.directory ? 'folder' : 'file',
        id: file.handle || '',
        node: file
      }];
    } catch (error) {
      console.error('Error loading Mega URL:', error);
      throw error;
    }
  }

  static isVideo(name: string): boolean {
    const videoExtensions = ['.mp4', '.mkv', '.webm', '.avi', '.mov'];
    return videoExtensions.some(ext => name.toLowerCase().endsWith(ext));
  }
}
