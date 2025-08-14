# ExternalWebSocketTransport

A version of the Hyperliquid WebSocketTransport that accepts an existing WebSocket instance instead of creating one from a URL.

## Overview

The `ExternalWebSocketTransport` class allows you to:

- Use your own pre-configured WebSocket instance
- Apply custom WebSocket settings, headers, or connection logic
- Integrate with existing WebSocket management systems
- Use either regular `WebSocket` or `ReconnectingWebSocket` instances

## Usage

### Basic Example with Regular WebSocket

```typescript
import { ExternalWebSocketTransport } from "./src/transports/websocket/websocket_transport.ts";

// Create your own WebSocket instance
const socket = new WebSocket("wss://api.hyperliquid.xyz/ws");

// Create transport with the socket
const transport = new ExternalWebSocketTransport(socket, {
  timeout: 10000,
  keepAlive: {
    interval: 30000,
    timeout: 10000,
  },
  autoResubscribe: true,
});

// Use the transport
await transport.ready();
const response = await transport.request("info", { type: "allMids" });
```

### Example with ReconnectingWebSocket

```typescript
import { ExternalWebSocketTransport } from "./src/transports/websocket/websocket_transport.ts";
import { ReconnectingWebSocket } from "./src/transports/websocket/_reconnecting_websocket.ts";

// Create ReconnectingWebSocket with custom options
const socket = new ReconnectingWebSocket(
  "wss://api.hyperliquid.xyz/ws",
  undefined,
  {
    maxRetries: 5,
    connectionTimeout: 15000,
    connectionDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 30000),
  }
);

const transport = new ExternalWebSocketTransport(socket);
```

## Configuration Options

The `ExternalWebSocketTransportOptions` interface supports:

- `timeout?: number | null` - Request timeout in milliseconds (default: 10,000)
- `keepAlive.interval?: number | null` - Ping interval in milliseconds (default: 30,000)
- `keepAlive.timeout?: number | null` - Ping timeout in milliseconds (default: same as request timeout)
- `autoResubscribe?: boolean` - Auto-resubscribe after reconnection (default: true, only applies to ReconnectingWebSocket)

## API Compatibility

The `ExternalWebSocketTransport` implements the same interfaces as the regular `WebSocketTransport`:

- `IRequestTransport` - for making API requests
- `ISubscriptionTransport` - for WebSocket subscriptions

All methods work identically:

- `request(type, payload, signal?)` - Make API requests
- `subscribe(channel, payload, listener)` - Subscribe to events
- `ready(signal?)` - Wait for connection
- `close(signal?)` - Close connection
- `dispose()` - Clean up resources

## Differences from WebSocketTransport

1. **Constructor**: Takes a `WebSocket` or `ReconnectingWebSocket` instance instead of a URL
2. **No URL management**: You're responsible for creating and configuring the WebSocket
3. **Reconnection**: Only available if you pass a `ReconnectingWebSocket` instance
4. **Connection lifecycle**: You control when the socket connects

## Use Cases

- Custom authentication headers
- Proxy configuration
- Custom TLS/SSL settings
- Integration with existing WebSocket pools
- Testing with mock WebSocket instances
- Advanced connection management scenarios
