// realtime-js imports `ws` for Node. Browsers have WebSocket natively, so this
// stub stands in for it and keeps the bundle free of Node-only dependencies.
export default globalThis.WebSocket;
export const WebSocket = globalThis.WebSocket;
