export const useSimpleAdminAuth = () => ({ loading: false, authenticated: !new URLSearchParams(location.search).has("signedout") })
