import type { grpc } from "@improbable-eng/grpc-web";
import { BaseChannel } from "./BaseChannel";
import { ClientStream } from "./ClientStream";
import { ConnectionClosedError } from "./errors";
import {
  Request,
  RequestHeaders,
  RequestMessage,
  Response,
  Stream,
} from "./gen/proto/rpc/webrtc/v1/grpc_pb";

// MaxStreamCount is the max number of streams a channel can have.
let MaxStreamCount = 256;

interface activeClientStream {
  cs: ClientStream;
}

export class ClientChannel extends BaseChannel {
  private streamIDCounter: bigint = BigInt(0);
  private readonly streams: Record<number, activeClientStream> = {};

  constructor(pc: RTCPeerConnection, dc: RTCDataChannel) {
    super(pc, dc);
    dc.onmessage = (event: MessageEvent<unknown>) =>
      this.onChannelMessage(event);
    pc.addEventListener("iceconnectionstatechange", () => {
      const state = pc.iceConnectionState;
      if (
        !(state === "failed" || state === "disconnected" || state === "closed")
      ) {
        return;
      }
      this.onConnectionTerminated();
    });
    dc.addEventListener("close", () => this.onConnectionTerminated());
  }

  public transportFactory(): grpc.TransportFactory {
    return (opts: grpc.TransportOptions) => {
      return this.newStream(this.nextStreamID(), opts);
    };
  }

  private onConnectionTerminated() {
    // we may call this twice but we know closed will be true at this point.
    this.closeWithReason(new ConnectionClosedError("data channel closed"));
    const err = new ConnectionClosedError("connection terminated");
    for (const streamId in this.streams) {
      const stream = this.streams[streamId]!;
      stream.cs.closeWithRecvError(err);
    }
  }

  private onChannelMessage(event: MessageEvent<any>) {
    let resp: Response;
    try {
      resp = Response.fromBinary(event.data);
    } catch (e) {
      console.error("error deserializing message", e);
      return;
    }

    const stream = resp.stream;
    if (stream === undefined) {
      console.error("no stream id; discarding");
      return;
    }

    const id = stream.id;
    const activeStream = this.streams[Number(id)];
    if (activeStream === undefined) {
      console.error("no stream for id; discarding", "id", id);
      return;
    }
    activeStream.cs.onResponse(resp);
  }

  private nextStreamID(): Stream {
    const stream = new Stream();
    stream.id = this.streamIDCounter++;
    return stream;
  }

  private newStream(
    stream: Stream,
    opts: grpc.TransportOptions
  ): grpc.Transport {
    if (this.isClosed()) {
      return new FailingClientStream(
        new ConnectionClosedError("connection closed"),
        opts
      );
    }
    let activeStream = this.streams[Number(stream.id)];
    if (activeStream === undefined) {
      if (Object.keys(this.streams).length > MaxStreamCount) {
        return new FailingClientStream(new Error("stream limit hit"), opts);
      }
      const clientStream = new ClientStream(
        this,
        stream,
        (id: bigint) => this.removeStreamByID(id),
        opts
      );
      activeStream = { cs: clientStream };
      this.streams[Number(stream.id)] = activeStream;
    }
    return activeStream.cs;
  }

  private removeStreamByID(id: bigint) {
    delete this.streams[Number(id)];
  }

  public writeHeaders(stream: Stream, headers: RequestHeaders) {
    const request = new Request();
    request.stream = stream;
    request.type = { case: "headers", value: headers };
    this.write(request);
  }

  public writeMessage(stream: Stream, msg: RequestMessage) {
    const request = new Request();
    request.stream = stream;
    request.type = { case: "message", value: msg };
    this.write(request);
  }

  public writeReset(stream: Stream) {
    const request = new Request();
    request.stream = stream;
    request.type = { case: "rstStream", value: true };
    this.write(request);
  }
}

class FailingClientStream implements grpc.Transport {
  private readonly err: Error;
  private readonly opts: grpc.TransportOptions;

  constructor(err: Error, opts: grpc.TransportOptions) {
    this.err = err;
    this.opts = opts;
  }

  public start() {
    if (this.opts.onEnd) {
      setTimeout(() => this.opts.onEnd(this.err));
    }
  }

  public sendMessage() {}

  public finishSend() {}

  public cancel() {}
}
