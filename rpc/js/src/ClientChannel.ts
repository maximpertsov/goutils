import type { grpc } from "@improbable-eng/grpc-web";
import { BaseChannel } from "./BaseChannel";
import { ClientStream } from "./ClientStream";
import { ConnectionClosedError } from "./errors";
import {
  Request,
  RequestHeaders,
  RequestMessage,
  // ResponseMessage,
  Response,
  Stream,
} from "./gen/proto/rpc/webrtc/v1/grpc_pb";
import type {
  Transport,
  // UnaryRequest,
  UnaryResponse,
  // StreamResponse,
  // runUnary,
} from "@bufbuild/connect-web";
import type {
  AnyMessage,
  Message,
  MethodInfo,
  PartialMessage,
  ServiceType,
} from "@bufbuild/protobuf";
// MaxStreamCount is the max number of streams a channel can have.
let MaxStreamCount = 256;

interface activeClientStream {
  cs: ClientStream;
}

export class ClientChannel extends BaseChannel implements Transport {
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

  public async unary<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    service: ServiceType,
    method: MethodInfo<I, O>,
    _signal: AbortSignal | undefined,
    _timeoutMs: number | undefined,
    _header: Headers,
    _message: PartialMessage<I>
  ): Promise<UnaryResponse<O>> {
    // TODO: read from bytes
    const resp = new Response();

    // TODO: get headers
    let header = new Headers();
    if (resp.type.case === "headers") {
      const metadata = resp.type.value.metadata;
      if (metadata) {
        for (const [key, strings] of Object.entries(metadata.md)) {
          strings.values.forEach((value) => {
            header.append(key, value);
          });
        }
      }
    }

    // TODO: get message
    let message: O = new method.O();
    if (resp.type.case === "message") {
      const packetMessage = resp.type.value.packetMessage;
      if (packetMessage) {
        message = method.O.fromBinary(packetMessage.data);
      }
    }

    // TODO: get trailers
    let trailer = new Headers();
    if (resp.type.case === "headers") {
      const metadata = resp.type.value.metadata;
      if (metadata) {
        for (const [key, strings] of Object.entries(metadata.md)) {
          strings.values.forEach((value) => {
            trailer.append(key, value);
          });
        }
      }
    }

    return <UnaryResponse<O>>{
      stream: resp.stream || false,
      service,
      method,
      // TODO: this might be wrong - what if this isn't a header message?
      header,
      // TODO: this might be wrong - what if this isn't a "body" message?
      message,
      // TODO: this might be wrong - what if this isn't a trailer message?
      trailer,
    };
  }

  // public async serverStream<
  //   I extends Message<I> = AnyMessage,
  //   O extends Message<O> = AnyMessage
  // >(
  //   service: ServiceType,
  //   method: MethodInfo<I, O>,
  //   _signal: AbortSignal | undefined,
  //   _timeoutMs: number | undefined,
  //   _header: Headers,
  //   _message: PartialMessage<I>
  // ): Promise<StreamResponse<O>> {
  //   // TODO: read from bytes
  //   const resp = new Response();
  //
  //   // TODO: get headers
  //   let header = new Headers();
  //   if (resp.type.case === "headers") {
  //     const metadata = resp.type.value.metadata;
  //     if (metadata) {
  //       for (const [key, strings] of Object.entries(metadata.md)) {
  //         strings.values.forEach((value) => {
  //           header.append(key, value);
  //         });
  //       }
  //     }
  //   }
  //
  //   // TODO: get message
  //   let message: O = new method.O();
  //   if (resp.type.case === "message") {
  //     const packetMessage = resp.type.value.packetMessage;
  //     if (packetMessage) {
  //       message = method.O.fromBinary(packetMessage.data);
  //     }
  //   }
  //
  //   // TODO: get trailers
  //   let trailer = new Headers();
  //   if (resp.type.case === "headers") {
  //     const metadata = resp.type.value.metadata;
  //     if (metadata) {
  //       for (const [key, strings] of Object.entries(metadata.md)) {
  //         strings.values.forEach((value) => {
  //           trailer.append(key, value);
  //         });
  //       }
  //     }
  //   }
  //
  //   return <StreamResponse<O>>{
  //     stream: resp.stream || false,
  //     service,
  //     method,
  //     // TODO: this might be wrong - what if this isn't a header message?
  //     header,
  //     // TODO: this might be wrong - what if this isn't a "body" message?
  //     message,
  //     // TODO: this might be wrong - what if this isn't a trailer message?
  //     trailer,
  //   };
  // }

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
