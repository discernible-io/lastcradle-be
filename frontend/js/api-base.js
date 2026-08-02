/**
 * Resolve the game API origin for static frontend pages.
 * - slc.discernible.io / slc.dihola.io (frontend :10443) → slcapi.*:9443
 * - slcapi.* or localhost → same origin (legacy /play, /watch on API host)
 */
export function resolveApiBase() {
  const meta = document.querySelector('meta[name="slc-api-base"]');
  if (meta?.content) {
    return meta.content.replace(/\/$/, "");
  }

  const { hostname, origin, protocol } = window.location;
  if (hostname === "slc.discernible.io") {
    return `${protocol}//slcapi.discernible.io:9443`;
  }
  if (hostname === "slc.dihola.io") {
    return `${protocol}//slcapi.dihola.io:9443`;
  }
  if (hostname === "slcapi.discernible.io" || hostname === "slcapi.dihola.io") {
    const { port } = window.location;
    if (port === "9443") return origin;
    return `${protocol}//${hostname}:9443`;
  }
  if (hostname.startsWith("api.") || hostname === "localhost" || hostname === "127.0.0.1") {
    return origin;
  }
  return "";
}

export function apiUrl(path) {
  const base = resolveApiBase();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${normalized}` : normalized;
}
