export type Route = { kind: 'home' } | { kind: 'file'; id: string };

function parse(hash: string): Route {
  const m = hash.match(/^#\/file\/(.+)$/);
  if (m) return { kind: 'file', id: decodeURIComponent(m[1]) };
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
  const next = `#/file/${encodeURIComponent(r.id)}`;
  if (location.hash !== next) {
    location.hash = next;
  }
}
