export type Route =
  | { kind: 'home' }
  | { kind: 'file'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'shorts'; scope: 'all' | 'folder'; folderId?: string };

function parse(hash: string): Route {
  let m = hash.match(/^#\/file\/(.+)$/);
  if (m) return { kind: 'file', id: decodeURIComponent(m[1]) };
  m = hash.match(/^#\/folder\/(.+)$/);
  if (m) return { kind: 'folder', id: decodeURIComponent(m[1]) };
  m = hash.match(/^#\/shorts\/folder\/(.+)$/);
  if (m) return { kind: 'shorts', scope: 'folder', folderId: decodeURIComponent(m[1]) };
  if (hash === '#/shorts/all') return { kind: 'shorts', scope: 'all' };
  return { kind: 'home' };
}

let current = $state<Route>(parse(typeof location === 'undefined' ? '' : location.hash));

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = parse(location.hash);
  });
}

export const router = {
  get current(): Route {
    return current;
  },
};

export function navigate(r: Route) {
  if (r.kind === 'home') {
    if (location.hash) {
      history.pushState(null, '', location.pathname + location.search);
      current = r;
    }
    return;
  }
  let next: string;
  if (r.kind === 'shorts') {
    next =
      r.scope === 'folder' && r.folderId
        ? `#/shorts/folder/${encodeURIComponent(r.folderId)}`
        : '#/shorts/all';
  } else {
    const prefix = r.kind === 'file' ? '#/file/' : '#/folder/';
    next = `${prefix}${encodeURIComponent(r.id)}`;
  }
  if (location.hash !== next) {
    location.hash = next;
  }
}
