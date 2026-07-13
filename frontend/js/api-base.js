/**
 * Resolve the game API origin for static frontend pages.
 * - slc.identyclaw.com → cross-origin API at api.slc.identyclaw.com:444
 * - api.* or localhost → same origin (legacy /play, /watch on API host)
 */
export function resolveApiBase() {
  const meta = document.querySelector('meta[name="slc-api-base"]');
  if (meta?.content) {
    return meta.content.replace(/\/$/, "");
  }

  const { hostname, origin } = window.location;
  if (hostname === "slc.identyclaw.com") {
    return "https://api.slc.identyclaw.com:444";
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
