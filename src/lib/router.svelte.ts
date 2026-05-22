export type Route =
  | { kind: 'home' }
  | { kind: 'file'; id: string }
  | { kind: 'folder'; id: string };

function parse(hash: string): Route {
  let m = hash.match(/^#\/file\/(.+)$/);
  if (m) return { kind: 'file', id: decodeURIComponent(m[1]) };
  m = hash.match(/^#\/folder\/(.+)$/);
  if (m) return { kind: 'folder', id: decodeURIComponent(m[1]) };
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
  const prefix = r.kind === 'file' ? '#/file/' : '#/folder/';
  const next = `${prefix}${encodeURIComponent(r.id)}`;
  if (location.hash !== next) {
    location.hash = next;
  }
}
