import {
  type IRequestTransport,
  type ISubscriptionTransport,
  type Subscription,
  TransportError,
} from "../base.ts";
import { HyperliquidEventTarget } from "./_hyperliquid_event_target.ts";
import { WebSocketAsyncRequest } from "./_websocket_async_request.ts";
import { ReconnectingWebSocket } from "./_reconnecting_websocket.ts";

/** Configuration options for the external WebSocket transport layer. */
export interface ExternalWebSocketTransportOptions {
  /**
   * Timeout for requests in ms.
   * Set to `null` to disable.
   * @defaultValue `10_000`
   */
  timeout?: number | null;

  /** Keep-alive configuration. */
  keepAlive?: {
    /**
     * Interval between sending ping messages in ms.
     * Set to `null` to disable.
     * @defaultValue `30_000`
     */
    interval?: number | null;

    /**
     * Timeout for the ping request in ms.
     * Set to `null` to disable.
     * @defaultValue same as {@link timeout} for requests.
     */
    timeout?: number | null;
  };

  /**
   * Enable automatic event resubscription after reconnection.
   * Only applies to ReconnectingWebSocket instances.
   * @defaultValue `true`
   */
  autoResubscribe?: boolean;
}

/** Error thrown when an external WebSocket request fails. */
export class ExternalWebSocketRequestError extends TransportError {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExternalWebSocketRequestError";
  }
}

/** WebSocket implementation that accepts an external socket instance. */
export class ExternalWebSocketTransport
  implements IRequestTransport, ISubscriptionTransport
{
  protected _wsRequester: WebSocketAsyncRequest;
  protected _hlEvents: HyperliquidEventTarget;
  protected _keepAliveTimeout: ReturnType<typeof setTimeout> | null = null;
  protected _subscriptions: Map<
    string, // Unique identifier based on the payload
    {
      listeners: Map<
        (data: CustomEvent) => void, // Event listener function
        () => Promise<void> // Unsubscribe function
      >;
      promise: Promise<unknown>; // Subscription request promise
      resubscribeAbortController?: AbortController; // To monitor reconnection errors
    }
  > = new Map();
  protected _isReconnecting = false;

  /**
   * Request timeout in ms.
   * Set to `null` to disable.
   */
  timeout: number | null;

  /** Keep-alive configuration. */
  keepAlive: {
    /**
     * Interval between sending ping messages in ms.
     * Set to `null` to disable.
     */
    interval: number | null;

    /**
     * Timeout for the ping request in ms.
     * Set to `null` to disable.
     */
    timeout?: number | null;
  };

  /** Enable automatic resubscription after reconnection. */
  autoResubscribe: boolean;

  /** The WebSocket that is used for communication. */
  readonly socket: WebSocket | ReconnectingWebSocket;

  /**
   * Creates a new external WebSocket transport instance.
   * @param socket - The WebSocket or ReconnectingWebSocket instance to use for communication.
   * @param options - Configuration options for the WebSocket transport layer.
   */
  constructor(
    socket: WebSocket | ReconnectingWebSocket,
    options?: ExternalWebSocketTransportOptions
  ) {
    this.socket = socket;
    this._hlEvents = new HyperliquidEventTarget(this.socket);

    // Create a wrapper if we have a regular WebSocket to make it compatible with WebSocketAsyncRequest
    const socketWrapper =
      socket instanceof ReconnectingWebSocket
        ? socket
        : this._createWebSocketWrapper(socket);
    this._wsRequester = new WebSocketAsyncRequest(
      socketWrapper,
      this._hlEvents
    );

    this.timeout = options?.timeout === undefined ? 10_000 : options.timeout;
    this.keepAlive = {
      interval:
        options?.keepAlive?.interval === undefined
          ? 30_000
          : options.keepAlive?.interval,
      timeout:
        options?.keepAlive?.timeout === undefined
          ? this.timeout
          : options.keepAlive?.timeout,
    };
    this.autoResubscribe = options?.autoResubscribe ?? true;

    // Initialize listeners
    this.socket.addEventListener("open", () => {
      this._keepAliveStart();
      this._resubscribeStart();
    });
    this.socket.addEventListener("close", () => {
      this._keepAliveStop();
      this._resubscribeStop();
      this._isReconnecting = true;
    });
  }

  /**
   * Sends a request to the Hyperliquid API via WebSocket.
   *
   * Note: Explorer requests are not supported in the Hyperliquid WebSocket API.
   *
   * @param endpoint - The API endpoint to send the request to (`explorer` requests are not supported).
   * @param payload - The payload to send with the request.
   * @param signal - An {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | AbortSignal}. If this option is set, the request can be canceled by calling {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort | abort()} on the corresponding {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/AbortController | AbortController}.
   * @returns A promise that resolves with parsed JSON response body.
   *
   * @throws {ExternalWebSocketRequestError} - An error that occurs when a WebSocket request fails.
   */
  async request<T>(
    type: "info" | "exchange",
    payload: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    try {
      const timeoutSignal = this.timeout
        ? AbortSignal.timeout(this.timeout)
        : undefined;
      const combinedSignal =
        signal && timeoutSignal
          ? AbortSignal.any([signal, timeoutSignal])
          : signal ?? timeoutSignal;

      return await this._wsRequester.request(
        "post",
        {
          type: type === "exchange" ? "action" : type,
          payload,
        },
        combinedSignal
      );
    } catch (error) {
      if (error instanceof ExternalWebSocketRequestError) throw error; // Re-throw known errors
      throw new ExternalWebSocketRequestError(
        `Unknown error while making a WebSocket request: ${error}`,
        { cause: error }
      );
    }
  }

  /**
   * Subscribes to a Hyperliquid event channel.
   * Sends a subscription request to the server and listens for events.
   *
   * @param channel - The event channel to listen to.
   * @param payload - A payload to send with the subscription request.
   * @param listener - A function to call when the event is dispatched.
   * @returns A promise that resolves with a {@link Subscription} object to manage the subscription lifecycle.
   *
   * @throws {ExternalWebSocketRequestError} - An error that occurs when a WebSocket request fails.
   */
  async subscribe<T>(
    channel: string,
    payload: unknown,
    listener: (data: CustomEvent<T>) => void
  ): Promise<Subscription> {
    try {
      // Create a unique identifier for the subscription
      const id = WebSocketAsyncRequest.requestToId(payload);

      // Initialize new subscription, if it doesn't exist
      let subscription = this._subscriptions.get(id);
      if (!subscription) {
        // Send subscription request
        const promise = this._wsRequester.request("subscribe", payload);

        // Cache subscription info
        subscription = {
          listeners: new Map(),
          promise,
          resubscribeAbortController: new AbortController(),
        };
        this._subscriptions.set(id, subscription);
      }

      // Initialize new listener, if it doesn't exist
      let unsubscribe = subscription.listeners.get(listener);
      if (!unsubscribe) {
        // Create new unsubscribe function
        unsubscribe = async () => {
          try {
            // Remove listener and cleanup
            this._hlEvents.removeEventListener(
              channel,
              listener as EventListener
            );
            const subscription = this._subscriptions.get(id);
            subscription?.listeners.delete(listener);

            // If no listeners remain, remove subscription entirely
            if (subscription?.listeners.size === 0) {
              // Cleanup subscription
              this._subscriptions.delete(id);

              // If the socket is open, send unsubscription request
              if (this.socket.readyState === WebSocket.OPEN) {
                await this._wsRequester.request("unsubscribe", payload);
              }
            }
          } catch (error) {
            if (error instanceof ExternalWebSocketRequestError) throw error; // Re-throw known errors
            throw new ExternalWebSocketRequestError(
              `Unknown error while unsubscribing from a WebSocket channel: ${error}`,
              { cause: error }
            );
          }
        };

        // Add listener and cache unsubscribe function
        this._hlEvents.addEventListener(channel, listener as EventListener);
        subscription.listeners.set(listener, unsubscribe);
      }

      // Wait for the initial subscription request to complete
      await subscription.promise;

      // Return subscription control object
      return {
        unsubscribe,
        resubscribeSignal: subscription.resubscribeAbortController?.signal,
      };
    } catch (error) {
      if (error instanceof ExternalWebSocketRequestError) throw error; // Re-throw known errors
      throw new ExternalWebSocketRequestError(
        `Unknown error while subscribing to a WebSocket channel: ${error}`,
        { cause: error }
      );
    }
  }

  /**
   * Waits until the WebSocket connection is ready.
   * @param signal - An {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | AbortSignal}. If this option is set, the promise can be canceled by calling {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort | abort()} on the corresponding {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/AbortController | AbortController}.
   * @returns A promise that resolves when the connection is ready.
   */
  ready(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      // Handle ReconnectingWebSocket case
      const reconnectSignal =
        this.socket instanceof ReconnectingWebSocket
          ? this.socket.reconnectAbortController.signal
          : undefined;

      const combinedSignal =
        signal && reconnectSignal
          ? AbortSignal.any([reconnectSignal, signal])
          : signal ?? reconnectSignal;

      if (combinedSignal?.aborted) return reject(combinedSignal.reason);
      if (this.socket.readyState === WebSocket.OPEN) return resolve();

      const handleOpen = () => {
        combinedSignal?.removeEventListener("abort", handleAbort);
        resolve();
      };
      const handleAbort = () => {
        this.socket.removeEventListener("open", handleOpen);
        reject(combinedSignal?.reason);
      };

      this.socket.addEventListener("open", handleOpen, { once: true });
      combinedSignal?.addEventListener("abort", handleAbort, { once: true });
    });
  }

  /**
   * Closes the WebSocket connection and waits until it is fully closed.
   * @param signal - An {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | AbortSignal}. If this option is set, the promise can be canceled by calling {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort | abort()} on the corresponding {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/AbortController | AbortController}.
   * @returns A promise that resolves when the connection is fully closed.
   */
  close(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      if (this.socket.readyState === WebSocket.CLOSED) return resolve();

      const handleClose = () => {
        signal?.removeEventListener("abort", handleAbort);
        resolve();
      };
      const handleAbort = () => {
        this.socket.removeEventListener("close", handleClose);
        reject(signal?.reason);
      };

      this.socket.addEventListener("close", handleClose, { once: true });
      signal?.addEventListener("abort", handleAbort, { once: true });

      this.socket.close();
    });
  }

  /** Keep the connection alive. Sends ping only when necessary. */
  protected _keepAliveStart(): void {
    if (this.keepAlive.interval === null || this._keepAliveTimeout) return;

    const tick = async () => {
      if (
        this.socket.readyState !== WebSocket.OPEN ||
        !this._keepAliveTimeout ||
        this.keepAlive.interval === null
      )
        return;

      // Check if the last request was sent more than the keep-alive interval ago
      if (
        Date.now() - this._wsRequester.lastRequestTime >=
        this.keepAlive.interval
      ) {
        const timeoutSignal = this.keepAlive.timeout
          ? AbortSignal.timeout(this.keepAlive.timeout)
          : undefined;
        await this._wsRequester
          .request("ping", timeoutSignal)
          .catch(() => undefined); // Ignore errors
      }

      // Schedule the next ping
      if (
        this.socket.readyState === WebSocket.OPEN &&
        this._keepAliveTimeout &&
        this.keepAlive.interval !== null
      ) {
        const nextDelay =
          this.keepAlive.interval -
          (Date.now() - this._wsRequester.lastRequestTime);
        this._keepAliveTimeout = setTimeout(tick, nextDelay);
      }
    };

    this._keepAliveTimeout = setTimeout(tick, this.keepAlive.interval);
  }

  protected _keepAliveStop(): void {
    if (this._keepAliveTimeout !== null) {
      clearTimeout(this._keepAliveTimeout);
      this._keepAliveTimeout = null;
    }
  }

  /** Resubscribe to all existing subscriptions if auto-resubscribe is enabled. */
  protected _resubscribeStart(): void {
    if (this.autoResubscribe && this._isReconnecting) {
      for (const [id, subscriptionInfo] of this._subscriptions.entries()) {
        subscriptionInfo.promise = this._wsRequester
          .request("subscribe", JSON.parse(id))
          .catch((error) => {
            subscriptionInfo.resubscribeAbortController?.abort(error);
          });
      }
    }
  }

  protected _resubscribeStop(): void {
    if (
      !this.autoResubscribe ||
      (this.socket instanceof ReconnectingWebSocket &&
        this.socket.reconnectAbortController.signal.aborted)
    ) {
      for (const subscriptionInfo of this._subscriptions.values()) {
        for (const [_, unsubscribe] of subscriptionInfo.listeners) {
          unsubscribe(); // does not cause an error if used when the connection is closed
        }
      }
    }
  }

  /** Create a wrapper for regular WebSocket to make it compatible with ReconnectingWebSocket interface */
  protected _createWebSocketWrapper(socket: WebSocket): ReconnectingWebSocket {
    // Create a minimal ReconnectingWebSocket-like wrapper
    const wrapper = Object.create(ReconnectingWebSocket.prototype);

    // Copy all WebSocket properties and methods
    Object.setPrototypeOf(wrapper, socket);

    // Add ReconnectingWebSocket-specific properties that might be needed
    wrapper.reconnectAbortController = new AbortController();
    wrapper.reconnectOptions = {};

    // Forward all WebSocket properties
    wrapper.url = socket.url;
    wrapper.readyState = socket.readyState;
    wrapper.bufferedAmount = socket.bufferedAmount;
    wrapper.extensions = socket.extensions;
    wrapper.protocol = socket.protocol;
    wrapper.binaryType = socket.binaryType;
    wrapper.onclose = socket.onclose;
    wrapper.onerror = socket.onerror;
    wrapper.onmessage = socket.onmessage;
    wrapper.onopen = socket.onopen;

    // Forward methods
    wrapper.send = socket.send.bind(socket);
    wrapper.close = socket.close.bind(socket);
    wrapper.addEventListener = socket.addEventListener.bind(socket);
    wrapper.removeEventListener = socket.removeEventListener.bind(socket);
    wrapper.dispatchEvent = socket.dispatchEvent.bind(socket);

    return wrapper;
  }

  async dispose(): Promise<void> {
    await this.close();
  }
}
