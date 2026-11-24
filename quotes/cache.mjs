// One shared hour for every session. The client does not poll faster while
// the market is open, in pre-market, or after hours.
export const CACHE_SECONDS = 60 * 60;
export const POLL_MS = 60 * 60 * 1000;

export function cacheSeconds() {
  return CACHE_SECONDS;
}

export function pollIntervalMs() {
  return POLL_MS;
}

export function cacheControl() {
  return {
    ttl: CACHE_SECONDS,
    'cache-control': 'public, max-age=0, must-revalidate',
    'netlify-cdn-cache-control': 'public, durable, s-maxage=3600, stale-while-revalidate=300'
  };
}
