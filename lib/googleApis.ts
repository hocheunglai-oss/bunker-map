let googleApisPromise: Promise<typeof import("googleapis")> | null = null

/**
 * Load the large Google API SDK only after authentication and only on routes
 * that actually need it. Keeping the import out of module scope prevents
 * ordinary API cold starts from paying the SDK initialization cost.
 */
export function loadGoogleApis() {
  googleApisPromise ||= import("googleapis")
  return googleApisPromise
}
