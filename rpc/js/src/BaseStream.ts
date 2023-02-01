import type { PacketMessage, Stream } from "./gen/proto/rpc/webrtc/v1/grpc_pb";
import type { GrpcWebTransportOptions } from "@bufbuild/connect-web";

import type { Code } from "@bufbuild/connect-web";

// MaxMessageSize is the maximum size a gRPC message can be.
let MaxMessageSize = 1 << 25;

export class BaseStream {
  protected readonly stream: Stream;
  private readonly onDone: (id: bigint) => void;
  protected readonly opts: GrpcWebTransportOptions;
  protected closed: boolean = false;
  private readonly packetBuf: Array<Uint8Array> = [];

  private packetBufSize = 0;
  private err?: Error;

  // extra Req-Resp lifecycle fields
  protected completed: boolean = false;
  protected responseHeaders?: Headers;
  protected responseTrailers?: Headers;

  constructor(
    stream: Stream,
    onDone: (id: bigint) => void,
    opts: GrpcWebTransportOptions
  ) {
    this.stream = stream;
    this.onDone = onDone;
    this.opts = opts;
  }

  public waitUntilComplete(): Promise<void> {
    const wait = (resolve: () => void) => {
      console.debug("waiting to complete...");
      if (this.completed) return resolve();
      setTimeout(wait, 1000);
    };
    return new Promise(function (resolve, _reject) {
      wait(resolve);
    });
  }

  public closeWithRecvError(err?: Error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.err = err;
    this.onDone(this.stream.id);
    // pretty sure passing the error does nothing.
    //
    // MP: yes, this seems to be the case - the value ultimately reaches a
    // function that optionally takes an error and does nothing with it.
    this.onEnd(this.err);
  }

  protected processPacketMessage(msg: PacketMessage): Uint8Array | undefined {
    const data = msg.data;
    if (data.length + this.packetBufSize > MaxMessageSize) {
      this.packetBuf.length = 0;
      this.packetBufSize = 0;
      console.error(
        `message size larger than max ${MaxMessageSize}; discarding`
      );
      return undefined;
    }
    this.packetBuf.push(data);
    this.packetBufSize += data.length;
    if (msg.eom) {
      const data = new Uint8Array(this.packetBufSize);
      let position = 0;
      for (let i = 0; i < this.packetBuf.length; i++) {
        const partialData = this.packetBuf[i]!;
        data.set(partialData, position);
        position += partialData.length;
      }
      this.packetBuf.length = 0;
      this.packetBufSize = 0;
      return data;
    }
    return undefined;
  }

  // EXTENDED TRANSPORT OPTIONS
  //
  // ported from improbably engine transport logic - used to be defined in
  // transport options

  onEnd(_err?: Error) {
    // if (this.closed) {
    //   return;
    // }
    //
    // if (this.responseTrailers === undefined) {
    //   if (this.responseHeaders === undefined) {
    //     // The request was unsuccessful - it did not receive any headers
    //     this.rawOnError(Code.Unknown, "Response closed without headers");
    //     return;
    //   }
    //
    //   const grpcStatus = this.getStatusFromHeaders(this.responseHeaders);
    //   const grpcMessage = this.responseHeaders.get("grpc-message");
    //
    //   // This was a headers/trailers-only response
    //
    //   if (grpcStatus === null) {
    //     this.rawOnEnd(
    //       Code.Unknown,
    //       "Response closed without grpc-status (Headers only)",
    //       this.responseHeaders
    //     );
    //     return;
    //   }
    //
    //   // Return an empty trailers instance
    //   const statusMessage = this.decodeGRPCStatus(grpcMessage[0]);
    //   this.rawOnEnd(grpcStatus, statusMessage, this.responseHeaders);
    //   return;
    // }
  }

  rawOnEnd(_code: Code, _message: string, _trailers: Headers) {
    if (this.completed) return;
    this.completed = true;

    // this.onEndCallbacks.forEach((callback) => {
    //   if (this.closed) return;
    //   try {
    //     callback(code, message, trailers);
    //   } catch (e) {
    //     setTimeout(() => {
    //       throw e;
    //     }, 0);
    //   }
    // });
  }

  rawOnError(_code: Code, _msg: string, _trailers: Headers = new Headers()) {
    if (this.completed) return;
    this.completed = true;
    // this.onEndCallbacks.forEach((callback) => {
    //   if (this.closed) return;
    //   try {
    //     callback(code, msg, trailers);
    //   } catch (e) {
    //     setTimeout(() => {
    //       throw e;
    //     }, 0);
    //   }
    // });
  }

  // UTILITIES

  protected getStatusFromHeaders(headers: Headers): Code | null {
    // TODO: should this be `grpc-status-bin` ?
    const maybeRawStatus = headers.get("grpc-status");
    const fromHeaders = maybeRawStatus ? maybeRawStatus.split(", ") : [];
    if (fromHeaders.length > 0) {
      try {
        const asString = fromHeaders[0];
        if (!asString) {
          return null;
        }
        return parseInt(asString, 10);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  protected decodeGRPCStatus(src: string | undefined): string {
    if (src) {
      try {
        return decodeURIComponent(src);
      } catch (err) {
        return src;
      }
    } else {
      return "";
    }
  }
}
