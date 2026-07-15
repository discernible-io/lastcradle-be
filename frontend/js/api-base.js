/**
 * Resolve the game API origin for static frontend pages.
 * - slc.discernible.io (frontend :443) → API at slc.discernible.io:8443
 * - api.* or localhost → same origin (legacy /play, /watch on API host)
 */
export function resolveApiBase() {
  const meta = document.querySelector('meta[name="slc-api-base"]');
  if (meta?.content) {
    return meta.content.replace(/\/$/, "");
  }

  const { hostname, origin } = window.location;
  if (hostname === "slc.discernible.io") {
    const { port, protocol } = window.location;
    if (port === "8443") return origin;
    return `${protocol}//${hostname}:8443`;
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
