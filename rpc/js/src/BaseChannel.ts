// import { decodeBinaryHeader } from "@bufbuild/connect-web";
import type { AnyMessage } from "@bufbuild/protobuf";
import { ConnectionClosedError } from "./errors";

export class BaseChannel {
  public readonly ready: Promise<unknown>;

  private readonly peerConn: RTCPeerConnection;
  private readonly dataChannel: RTCDataChannel;
  private pResolve: ((value: unknown) => void) | undefined;
  private pReject: ((reason?: unknown) => void) | undefined;

  private closed = false;
  private closedReason?: Error;

  protected maxDataChannelSize = 16384;

  constructor(peerConn: RTCPeerConnection, dataChannel: RTCDataChannel) {
    this.peerConn = peerConn;
    this.dataChannel = dataChannel;

    this.ready = new Promise<unknown>((resolve, reject) => {
      this.pResolve = resolve;
      this.pReject = reject;
    });

    dataChannel.onopen = () => this.onChannelOpen();
    dataChannel.onclose = () => this.onChannelClose();
    dataChannel.onerror = (ev: Event) =>
      this.onChannelError(ev as RTCErrorEvent);

    peerConn.addEventListener("iceconnectionstatechange", () => {
      const state = peerConn.iceConnectionState;
      if (
        !(state === "failed" || state === "disconnected" || state === "closed")
      ) {
        return;
      }
      this.pReject?.(new Error(`ICE connection failed with state: ${state}`));
    });
  }

  public close() {
    this.closeWithReason(undefined);
  }

  public isClosed() {
    return this.closed;
  }

  public isClosedReason() {
    return this.closedReason;
  }

  protected closeWithReason(err?: Error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closedReason = err;
    this.peerConn.close();
  }

  private onChannelOpen() {
    console.debug("channel open");
    this.pResolve?.(undefined);
  }

  private onChannelClose() {
    this.closeWithReason(new ConnectionClosedError("data channel closed"));
  }

  private onChannelError(ev: RTCErrorEvent) {
    console.error("channel error", ev);
    this.closeWithReason(ev.error);
  }

  protected write(msg: AnyMessage) {
    console.debug(`writing message to channel '${msg.toJsonString()}'`);
    this.dataChannel.send(msg.toBinary());
  }
}
