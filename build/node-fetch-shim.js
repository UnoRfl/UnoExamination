// supabase-js ships a node-fetch polyfill for older Node. Browsers have all of
// this natively, so the browser bundle uses the real thing instead of dragging
// in a Node-only dependency (which also fails at import time outside Node).
export default globalThis.fetch;
export const fetch = globalThis.fetch;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
