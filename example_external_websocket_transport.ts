/**
 * Example usage of ExternalWebSocketTransport
 *
 * This example shows how to use the ExternalWebSocketTransport class
 * with your own WebSocket instance instead of providing a URL.
 */

import { ExternalWebSocketTransport } from "./src/transports/websocket/websocket_transport.ts";
import { ReconnectingWebSocket } from "./src/transports/websocket/_reconnecting_websocket.ts";

// Example 1: Using with a regular WebSocket
function createTransportWithRegularWebSocket() {
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

  return transport;
}

// Example 2: Using with a ReconnectingWebSocket
function createTransportWithReconnectingWebSocket() {
  // Create your own ReconnectingWebSocket instance with custom options
  const socket = new ReconnectingWebSocket(
    "wss://api.hyperliquid.xyz/ws",
    undefined,
    {
      maxRetries: 5,
      connectionTimeout: 15000,
      connectionDelay: (attempt) =>
        Math.min(1000 * Math.pow(2, attempt), 30000),
    }
  );

  // Create transport with the socket
  const transport = new ExternalWebSocketTransport(socket, {
    timeout: 15000,
    autoResubscribe: true,
  });

  return transport;
}

// Example 3: Using with a pre-configured socket
async function exampleUsage() {
  // Create a WebSocket with custom headers or other configuration
  const socket = new WebSocket("wss://api.hyperliquid.xyz/ws");

  // Wait for the socket to open
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  // Create transport with the already-connected socket
  const transport = new ExternalWebSocketTransport(socket);

  try {
    // Wait for transport to be ready
    await transport.ready();

    // Make a request
    const response = await transport.request("info", {
      type: "allMids",
    });

    console.log("Response:", response);

    // Subscribe to events
    const subscription = await transport.subscribe(
      "trades",
      {
        type: "trades",
        coin: "BTC",
      },
      (event) => {
        console.log("Trade event:", event.detail);
      }
    );

    // Later, unsubscribe
    setTimeout(async () => {
      await subscription.unsubscribe();
      await transport.dispose();
    }, 30000);
  } catch (error) {
    console.error("Error:", error);
    await transport.dispose();
  }
}

export {
  createTransportWithRegularWebSocket,
  createTransportWithReconnectingWebSocket,
  exampleUsage,
};
