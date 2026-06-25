/**
 * Resolve the game API origin for static frontend pages.
 * - bae.identyclaw.com → cross-origin API at api.bae.identyclaw.com:444
 * - api.* or localhost → same origin (legacy /play, /watch on API host)
 */
export function resolveApiBase() {
  const meta = document.querySelector('meta[name="bae-api-base"]');
  if (meta?.content) {
    return meta.content.replace(/\/$/, "");
  }

  const { hostname, origin } = window.location;
  if (hostname === "bae.identyclaw.com") {
    return "https://api.bae.identyclaw.com:444";
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
