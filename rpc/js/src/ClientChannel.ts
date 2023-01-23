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
import type {
  AnyMessage,
  Message,
  ServiceType,
  MethodInfo,
  PartialMessage,
} from "@bufbuild/protobuf";
import type {
  StreamResponse,
  Transport,
  UnaryResponse,
} from "@bufbuild/connect-web";
import { Code, connectErrorFromReason } from "@bufbuild/connect-web";

// MaxStreamCount is the max number of streams a channel can have.
let MaxStreamCount = 256;

interface activeClientStream {
  cs: ClientStream;
}

type TransportFactory = (opts: grpc.TransportOptions) => Transport;

export class ClientChannel extends BaseChannel {
  private streamIDCounter: bigint = BigInt(0);
  private readonly streams: Record<string, activeClientStream> = {};

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

  public transportFactory(): TransportFactory {
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
    const activeStream = this.streams[id.toString()];
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

  private newStream(stream: Stream, opts: grpc.TransportOptions): Transport {
    if (this.isClosed()) {
      return new FailingClientStream(
        new ConnectionClosedError("connection closed")
      );
    }
    let activeStream = this.streams[stream.id.toString()];
    if (activeStream === undefined) {
      if (Object.keys(this.streams).length > MaxStreamCount) {
        return new FailingClientStream(new Error("stream limit hit"));
      }
      const clientStream = new ClientStream(
        this,
        stream,
        (id: bigint) => this.removeStreamByID(id),
        opts
      );
      activeStream = { cs: clientStream };
      this.streams[stream.id.toString()] = activeStream;
    }
    return activeStream.cs;
  }

  private removeStreamByID(id: bigint) {
    delete this.streams[id.toString()];
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

class FailingClientStream implements Transport {
  private readonly err: Error;

  constructor(err: Error) {
    this.err = err;
  }

  // connect-web interface

  public async unary<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    _service: ServiceType,
    _method: MethodInfo<I, O>,
    _signal: AbortSignal | undefined,
    _timeoutMs: number | undefined,
    _header: HeadersInit | undefined,
    _message: PartialMessage<I>
  ): Promise<UnaryResponse<O>> {
    throw connectErrorFromReason(this.err, Code.Internal);
  }

  public async serverStream<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    _service: ServiceType,
    _method: MethodInfo<I, O>,
    _signal: AbortSignal | undefined,
    _timeoutMs: number | undefined,
    _header: HeadersInit | undefined,
    _message: PartialMessage<I>
  ): Promise<StreamResponse<O>> {
    throw connectErrorFromReason(this.err, Code.Internal);
  }
}
