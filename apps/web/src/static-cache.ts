export async function registerStaticCache(): Promise<string> {
  if (!('serviceWorker' in navigator))
    return 'Static cache unavailable in this browser.';
  try {
    await navigator.serviceWorker.register('./service-worker.js', {
      updateViaCache: 'none',
    });
    return 'Static cache registered; updates apply after all TailMouse tabs close.';
  } catch {
    return 'Static cache unavailable. This session can continue online.';
  }
}
