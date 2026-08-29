import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import {
  DeviceHello,
  DeviceRequest,
  DeviceResponse,
  PROTOCOL_VERSION,
} from "@trueforge-android/protocol";

const REQUEST_TIMEOUT_MS = 15_000;

/** DeviceRequest minus the requestId that sendRequest assigns. */
export type DeviceRequestInput = DeviceRequest extends infer T
  ? T extends { requestId: string }
    ? Omit<T, "requestId">
    : never
  : never;

export interface DeviceConnectionInfo {
  deviceId: string;
  model: string | null;
  androidVersion: string | null;
  accessibilityServiceEnabled: boolean;
  connectedAt: number;
}

type Pending = {
  resolve: (response: DeviceResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * In-memory device registry + WebSocket gateway.
 *
 * Protocol (packages/protocol): the device sends DeviceHello immediately on
 * connect; afterwards it answers DeviceRequest messages with correlated
 * DeviceResponse messages (same requestId).
 */
export class DeviceGateway extends EventEmitter {
  private readonly wss: WebSocketServer;
  private readonly devices = new Map<string, RegisteredDevice>();

  constructor() {
    super();
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (socket, req) => this.onConnection(socket, req));
  }

  /** Attach to an existing http server's upgrade event. */
  bind(server: HttpServer): void {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/device") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });
  }

  listDevices(): DeviceConnectionInfo[] {
    return [...this.devices.values()].map((d) => d.info);
  }

  isOnline(deviceId: string): boolean {
    return this.devices.get(deviceId)?.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Sends a request to a device and resolves with its correlated response.
   * Rejects when the device is offline or the device/times out.
   */
  sendRequest(
    deviceId: string,
    request: DeviceRequestInput,
    opts?: { timeoutMs?: number },
  ): Promise<DeviceResponse> {
    const device = this.devices.get(deviceId);
    if (!device || device.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Device '${deviceId}' is offline`));
    }
    const requestId = `req_${randomUUID().slice(0, 8)}`;
    const full = { ...request, requestId } as DeviceRequest;
    // Approvals wait on a human, far past the default per-request budget.
    const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;

    return new Promise<DeviceResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        device.pending.delete(requestId);
        reject(new Error(`Device '${deviceId}' timed out for ${full.type}`));
      }, timeoutMs);
      device.pending.set(requestId, { resolve, reject, timer });
      device.socket.send(JSON.stringify(full), (err) => {
        if (err) {
          clearTimeout(timer);
          device.pending.delete(requestId);
          reject(err);
        }
      });
    });
  }

  private onConnection(socket: WebSocket, _req: IncomingMessage): void {
    let registered: RegisteredDevice | null = null;

    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        console.error("[gateway] non-JSON message dropped");
        return;
      }
      try {
        this.onMessage(socket, parsed, (info) => {
          registered = info;
        });
      } catch (err) {
        console.error("[gateway] message error:", err);
      }
    });

    socket.on("close", () => {
      if (!registered) return;
      const deviceId = registered.info.deviceId;
      const current = this.devices.get(deviceId);
      if (current === registered) {
        this.devices.delete(deviceId);
        for (const pending of current.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("device disconnected"));
        }
        current.pending.clear();
      }
      this.emit("device.offline", deviceId);
      console.log(`[gateway] device offline: ${deviceId}`);
    });

    socket.on("error", () => socket.close());
  }

  private onMessage(
    socket: WebSocket,
    parsed: unknown,
    register: (info: RegisteredDevice) => void,
  ): void {
    const hello = DeviceHello.safeParse(parsed);
    if (hello.success) {
      if (hello.data.protocolVersion !== PROTOCOL_VERSION) {
        socket.close(1010, `unsupported protocolVersion ${hello.data.protocolVersion}`);
        return;
      }
      const device: RegisteredDevice = {
        info: {
          deviceId: hello.data.deviceId,
          model: hello.data.model,
          androidVersion: hello.data.androidVersion,
          accessibilityServiceEnabled: hello.data.accessibilityServiceEnabled,
          connectedAt: Date.now(),
        },
        socket,
        pending: new Map(),
      };
      this.devices.set(device.info.deviceId, device);
      register(device);
      this.emit("device.online", device.info);
      console.log(`[gateway] device online: ${device.info.deviceId} (${hello.data.model ?? "?"})`);
      return;
    }

    const response = DeviceResponse.safeParse(parsed);
    if (response.success) {
      const device = [...this.devices.values()].find((d) => d.socket === socket);
      if (!device) return;
      const requestId = response.data.requestId;
      const pending = device.pending.get(requestId);
      if (!pending) return;
      device.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(response.data);
      return;
    }

    console.error("[gateway] unparseable message:", JSON.stringify(parsed).slice(0, 300));
  }
}

interface RegisteredDevice {
  info: DeviceConnectionInfo;
  socket: WebSocket;
  pending: Map<string, Pending>;
}
