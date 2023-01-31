import type {
  GrpcWebTransportOptions,
  StreamResponse,
  Transport,
  UnaryRequest,
  UnaryResponse,
} from "@bufbuild/connect-web";
import {
  connectErrorFromReason,
  runServerStream,
  Code,
} from "@bufbuild/connect-web";
import type {
  AnyMessage,
  Message,
  ServiceType,
  MethodInfo,
  PartialMessage,
} from "@bufbuild/protobuf";
import { MethodKind } from "@bufbuild/protobuf";
import { BaseStream } from "./BaseStream";
import type { ClientChannel } from "./ClientChannel";
import { GRPCError } from "./errors";
import {
  Metadata,
  PacketMessage,
  RequestHeaders,
  RequestMessage,
  Response,
  ResponseHeaders,
  ResponseMessage,
  ResponseTrailers,
  Stream,
  Strings,
} from "./gen/proto/rpc/webrtc/v1/grpc_pb";

// see golang/client_stream.go
const maxRequestMessagePacketDataSize = 16373;

export class ClientStream extends BaseStream implements Transport {
  private readonly channel: ClientChannel;
  private headersReceived: boolean = false;
  private trailersReceived: boolean = false;

  protected responseMessage?: Uint8Array | undefined;

  constructor(
    channel: ClientChannel,
    stream: Stream,
    onDone: (id: bigint) => void,
    // TODO: use connect-web transport options
    opts: GrpcWebTransportOptions
  ) {
    super(stream, onDone, opts);
    this.channel = channel;
  }

  // CONNECT-WEB INTERFACE

  public async unary<
    // TODO: move definitions to top-level of class
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    service: ServiceType,
    method: MethodInfo<I, O>,
    signal: AbortSignal | undefined,
    _timeoutMs: number | undefined,
    header: Headers,
    message: PartialMessage<I>
  ): Promise<UnaryResponse<O>> {
    console.debug("starting unary call with gRPC over WebRTC transport");

    try {
      if (signal && signal.aborted) {
        this.cancel();
      }
      this.start(header, service, method);
      this.sendMessage(
        message instanceof method.I ? message : new method.I(message)
      );
      this.finishSend(method);
      await this.waitUntilComplete();

      if (!this.responseHeaders) {
        throw connectErrorFromReason("no response headers", Code.Internal);
      }

      if (!this.responseMessage) {
        throw connectErrorFromReason("no response message", Code.Internal);
      }

      if (!this.responseTrailers) {
        throw connectErrorFromReason("no response trailers", Code.Internal);
      }

      return {
        stream: false as const,
        service: service,
        method: method,
        header: this.responseHeaders,
        message: method.O.fromBinary(this.responseMessage),
        trailer: this.responseTrailers,
      };

      // const request: UnaryRequest = {
      //   stream: false,
      //   service: service,
      //   method: method,
      //   url: this.getUrl(service, method),
      //   init: {},
      //   signal: signal ?? new AbortController().signal,
      //   header: header,
      //   message: method.O.fromBinary(new Uint8Array()),
      // };
      // const next = async (req: UnaryRequest): Promise<UnaryResponse<O>> => {
      //   return {
      //     stream: false as const,
      //     service: service,
      //     method: method,
      //     header: req.header,
      //     message: req.message as O,
      //     trailer: new Headers(),
      //   };
      // };
      // // TODO: add interceptors?
      // return runUnary(request, next);
    } catch (e) {
      throw connectErrorFromReason(e, Code.Internal);
    }
  }

  public async serverStream<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    service: ServiceType,
    method: MethodInfo<I, O>,
    signal: AbortSignal | undefined,
    _timeoutMs: number | undefined,
    header: Headers,
    _message: PartialMessage<I>
  ): Promise<StreamResponse<O>> {
    try {
      const request: UnaryRequest = {
        stream: false,
        service: service,
        method: method,
        url: this.getUrl(service, method),
        init: {},
        signal: signal ?? new AbortController().signal,
        header: header,
        message: method.O.fromBinary(new Uint8Array()),
      };
      const read = async () => {
        return {
          done: true as const,
        };
      };
      const next = async (req: UnaryRequest): Promise<StreamResponse<O>> => {
        return {
          stream: true as const,
          service: service,
          method: method,
          header: req.header,
          read: read,
          trailer: new Headers(),
        };
      };
      // TODO: add interceptors?
      return runServerStream(request, next);
    } catch (e) {
      throw connectErrorFromReason(e, Code.Internal);
    }
  }

  // https://github.com/bufbuild/connect-web/blob/125e35ddd39c15272721f67685146abeb366aa72/packages/connect-web/src/grpc-web-transport.ts#L110-L112
  getUrl<I extends Message<I> = AnyMessage, O extends Message<O> = AnyMessage>(
    service: ServiceType,
    method: MethodInfo<I, O>
  ) {
    return `${this.opts.baseUrl.replace(/\/$/, "")}/${service.typeName}/${
      method.name
    }`;
  }

  // IMPROBABLE-ENG INTERFACE

  public start<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(metadata: Headers, service: ServiceType, method: MethodInfo<I, O>) {
    const requestMethod = `/${service.typeName}/${method.name}`;
    const requestHeaders = new RequestHeaders();
    requestHeaders.method = requestMethod;
    requestHeaders.metadata = fromGRPCMetadata(metadata);

    try {
      this.channel.writeHeaders(this.stream, requestHeaders);
    } catch (error) {
      console.error("error writing headers", error);
      this.closeWithRecvError(error as Error);
    }
  }

  public sendMessage<I extends Message<I>>(message: I) {
    // TODO: skip frame header bytes?
    const msgBytes = message.toBinary();
    // TODO: Do we need to slice the message here?
    this.writeMessage(false, msgBytes.slice(5));
  }

  // public sendMessage(msgBytes?: Uint8Array) {
  //   // skip frame header bytes
  //   if (msgBytes) {
  //     this.writeMessage(false, msgBytes.slice(5));
  //     return;
  //   }
  //   this.writeMessage(false, undefined);
  // }

  public resetStream() {
    try {
      this.channel.writeReset(this.stream);
    } catch (error) {
      console.error("error writing reset", error);
      this.closeWithRecvError(error as Error);
    }
  }

  public finishSend<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(method: MethodInfo<I, O>) {
    switch (method.kind) {
      case MethodKind.Unary:
        return;
      case MethodKind.ServerStreaming:
        return;
    }
    this.writeMessage(true, undefined);
  }

  public cancel() {
    if (this.closed) {
      return;
    }
    this.resetStream();
  }

  private writeMessage(eos: boolean, msgBytes?: Uint8Array) {
    try {
      if (!msgBytes || msgBytes.length === 0) {
        const packet = new PacketMessage();
        packet.eom = true;
        const requestMessage = new RequestMessage();
        requestMessage.hasMessage = !!msgBytes;
        requestMessage.packetMessage = packet;
        requestMessage.eos = eos;
        this.channel.writeMessage(this.stream, requestMessage);
        return;
      }

      while (msgBytes.length !== 0) {
        const amountToSend = Math.min(
          msgBytes.length,
          maxRequestMessagePacketDataSize
        );
        const packet = new PacketMessage();
        packet.data = msgBytes.slice(0, amountToSend);
        msgBytes = msgBytes.slice(amountToSend);
        if (msgBytes.length === 0) {
          packet.eom = true;
        }
        const requestMessage = new RequestMessage();
        requestMessage.hasMessage = !!msgBytes;
        requestMessage.packetMessage = packet;
        requestMessage.eos = eos;
        this.channel.writeMessage(this.stream, requestMessage);
      }
    } catch (error) {
      console.error("error writing message", error);
      this.closeWithRecvError(error as Error);
    }
  }

  public onResponse(resp: Response) {
    switch (resp.type.case) {
      case "headers":
        console.debug(`got headers: '${resp.type.value!.toJsonString()}'`);
        if (this.headersReceived) {
          this.closeWithRecvError(new Error("headers already received"));
          return;
        }
        if (this.trailersReceived) {
          this.closeWithRecvError(new Error("headers received after trailers"));
          return;
        }
        this.processHeaders(resp.type.value!);
        break;
      case "message":
        console.debug(`got message: '${resp.type.value!.toJsonString()}'`);
        if (!this.headersReceived) {
          this.closeWithRecvError(new Error("headers not yet received"));
          return;
        }
        if (this.trailersReceived) {
          this.closeWithRecvError(new Error("message received after trailers"));
          return;
        }
        this.processMessage(resp.type.value!);
        break;
      case "trailers":
        console.debug(`got trailers: '${resp.type.value!.toJsonString()}'`);
        this.processTrailers(resp.type.value!);
        break;
      default:
        console.error("unknown response type", resp.type.case);
        break;
    }
  }

  private processHeaders(headers: ResponseHeaders) {
    console.debug(`processing headers ${headers}`);
    this.headersReceived = true;
    // this.opts.onHeaders(toGRPCMetadata(headers.metadata), 200);
    this.onHeaders(toGRPCMetadata(headers.metadata), 200);
  }

  private processMessage(msg: ResponseMessage) {
    console.debug(`processing message ${msg}`);
    const result = super.processPacketMessage(msg.packetMessage!);
    if (!result) {
      return;
    }
    const chunk = new ArrayBuffer(result.length + 5);
    new DataView(chunk, 1, 4).setUint32(0, result.length, false);
    new Uint8Array(chunk, 5).set(result);
    // this.onChunk(new Uint8Array(chunk));
    this.responseMessage = new Uint8Array(chunk);
  }

  private processTrailers(trailers: ResponseTrailers) {
    console.debug(`processing trailers ${trailers}`);

    this.trailersReceived = true;
    const headers = toGRPCMetadata(trailers.metadata);
    let statusCode, statusMessage;
    const status = trailers.status;
    if (status) {
      statusCode = status.code;
      statusMessage = status.message;
      headers.set("grpc-status", `${status.code}`);
      if (statusMessage !== undefined) {
        headers.set("grpc-message", status.message);
      }
    } else {
      statusCode = 0;
      headers.set("grpc-status", "0");
      statusMessage = "";
    }

    const headerBytes = headersToBytes(headers);
    const chunk = new ArrayBuffer(headerBytes.length + 5);
    new DataView(chunk, 0, 1).setUint8(0, 1 << 7);
    new DataView(chunk, 1, 4).setUint32(0, headerBytes.length, false);
    new Uint8Array(chunk, 5).set(headerBytes);
    // this.onChunk(new Uint8Array(chunk));
    if (statusCode === 0) {
      this.closeWithRecvError();
      return;
    }
    this.closeWithRecvError(new GRPCError(statusCode, statusMessage));
  }

  // EXTENDED TRANSPORT OPTIONS
  //
  // ported from improbably engine transport logic - used to be defined in
  // transport options

  onHeaders(headers: Headers, status: number) {
    if (this.closed) {
      return;
    }

    if (status === 0) {
      // The request has failed due to connectivity issues. Do not capture the headers
    } else {
      this.responseHeaders = headers;

      const gRPCStatus = this.getStatusFromHeaders(headers);

      const code =
        gRPCStatus && gRPCStatus >= 0
          ? gRPCStatus
          : codeFromGrpcWebHttpStatus(status);

      const gRPCMessage = headers.get("grpc-message") || [];

      this.rawOnHeaders(headers);

      if (code !== null) {
        const statusMessage = this.decodeGRPCStatus(gRPCMessage[0]);
        this.rawOnError(code, statusMessage, headers);
      }
    }
  }

  // onChunk(chunkBytes: Uint8Array) {
  //   if (this.closed) {
  //     return;
  //   }
  //
  //   let data: Chunk[] = [];
  //   try {
  //     data = this.parser.parse(chunkBytes);
  //   } catch (err) {
  //     this.rawOnError(Code.Internal, `parsing error: ${err.message}`);
  //     return;
  //   }
  //
  //   data.forEach((chunk: Chunk) => {
  //     if (chunk.chunkType === ChunkType.MESSAGE) {
  //       const deserialized =
  //         this.methodDefinition.responseType.deserializeBinary(chunk.data!);
  //       this.rawOnMessage(deserialized);
  //     } else if (chunk.chunkType === ChunkType.TRAILERS) {
  //       if (!this.responseHeaders) {
  //         this.responseHeaders = new Headers(chunk.trailers);
  //         this.rawOnHeaders(this.responseHeaders);
  //       } else {
  //         this.responseTrailers = new Headers(chunk.trailers);
  //       }
  //     }
  //   });
  // }

  // UTILITIES

  rawOnHeaders(_headers: Headers) {
    if (this.completed) return;
    // this.onHeadersCallbacks.forEach((callback) => {
    //   try {
    //     callback(headers);
    //   } catch (e) {
    //     setTimeout(() => {
    //       throw e;
    //     }, 0);
    //   }
    // });
  }

  rawOnMessage(_res: Response) {
    if (this.completed || this.closed) return;
    // this.onMessageCallbacks.forEach(callback => {
    //   if (this.closed) return;
    //   try {
    //     callback(res);
    //   } catch (e) {
    //     setTimeout(() => {
    //       throw e;
    //     }, 0);
    //   }
    // });
  }
}

// from https://github.com/improbable-eng/grpc-web/blob/6fb683f067bd56862c3a510bc5590b955ce46d2a/ts/src/ChunkParser.ts#L22
export function encodeASCII(input: string): Uint8Array {
  const encoded = new Uint8Array(input.length);
  for (let i = 0; i !== input.length; ++i) {
    const charCode = input.charCodeAt(i);
    if (!isValidHeaderAscii(charCode)) {
      throw new Error(`Metadata contains invalid ASCII: '${charCode}'`);
    }
    encoded[i] = charCode;
  }
  return encoded;
}

const isAllowedControlChars = (char: number) =>
  char === 0x9 || char === 0xa || char === 0xd;

function isValidHeaderAscii(val: number): boolean {
  return isAllowedControlChars(val) || (val >= 0x20 && val <= 0x7e);
}

// TODO: should we encode binary headers here?
function headersToBytes(headers: Headers): Uint8Array {
  let asString = "";
  headers.forEach((key, values) => {
    asString += `${key}: ${values}}\r\n`;
  });
  return encodeASCII(asString);
}

// from https://github.com/jsmouret/grpc-over-webrtc/blob/45cd6d6cf516e78b1e262ea7aa741bc7a7a93dbc/client-improbable/src/grtc/webrtcclient.ts#L7
//
// TODO: should we expect a binary header here?
// https://connect.build/docs/web/headers-and-trailers#binary-headers
const fromGRPCMetadata = (headers?: Headers): Metadata | undefined => {
  if (!headers) {
    return undefined;
  }
  const result = new Metadata();
  headers.forEach((values, key) => {
    const strings = new Strings();
    strings.values = values.split(", ");
    result.md[key] = strings;
  });
  if (Object.keys(result.md).length === 0) {
    return undefined;
  }
  return result;
};

// TODO: should we encode binary headers here?
// https://connect.build/docs/web/headers-and-trailers#binary-headers
const toGRPCMetadata = (metadata?: Metadata): Headers => {
  const result = new Headers();
  if (!metadata) {
    return result;
  }
  if (!metadata.md) {
    return result;
  }
  Object.entries(metadata.md).forEach(([key, strings]) => {
    strings.values.forEach((value: string) => {
      result.set(key, value);
    });
  });
  return result;
};

// https://github.com/bufbuild/connect-web/blob/125e35ddd39c15272721f67685146abeb366aa72/packages/connect-web/src/code.ts#L141-L165
// TODO: can connect-web expose this function?
export function codeFromGrpcWebHttpStatus(httpStatus: number): Code | null {
  switch (httpStatus) {
    case 200: // Ok
      return null;
    case 400: // Bad Request
      return Code.Internal;
    case 401: // Unauthorized
      return Code.Unauthenticated;
    case 403: // Forbidden
      return Code.PermissionDenied;
    case 404: // Not Found
      return Code.Unimplemented;
    case 429: // Too Many Requests
      return Code.Unavailable;
    case 502: // Bad Gateway
      return Code.Unavailable;
    case 503: // Service Unavailable
      return Code.Unavailable;
    case 504: // Gateway Timeout
      return Code.Unavailable;
    default:
      return Code.Unknown;
  }
}

// // CHUNK
//
// const HEADER_SIZE = 5;
//
// export enum ChunkType {
//   MESSAGE = 1,
//   TRAILERS = 2,
// }
//
// export type Chunk = {
//   chunkType: ChunkType;
//   trailers?: Headers;
//   data?: Uint8Array;
// };
//
// function isTrailerHeader(headerView: DataView) {
//   // This is encoded in the MSB of the grpc header's first byte.
//   return (headerView.getUint8(0) & 0x80) === 0x80;
// }
//
// export function decodeASCII(input: Uint8Array): string {
//   // With ES2015, TypedArray.prototype.every can be used
//   for (let i = 0; i !== input.length; ++i) {
//     if (!isValidHeaderAscii(input[i])) {
//       throw new Error("Metadata is not valid (printable) ASCII");
//     }
//   }
//   // With ES2017, the array conversion can be omitted with iterables
//   return String.fromCharCode(...Array.prototype.slice.call(input));
// }
//
// function parseTrailerData(msgData: Uint8Array): Headers {
//   return new Headers(decodeASCII(msgData));
// }
//
// function readLengthFromHeader(headerView: DataView) {
//   return headerView.getUint32(1, false);
// }
//
// function hasEnoughBytes(
//   buffer: Uint8Array,
//   position: number,
//   byteCount: number
// ) {
//   return buffer.byteLength - position >= byteCount;
// }
//
// function sliceUint8Array(buffer: Uint8Array, from: number, to?: number) {
//   if (buffer.slice) {
//     return buffer.slice(from, to);
//   }
//
//   let end = buffer.length;
//   if (to !== undefined) {
//     end = to;
//   }
//
//   const num = end - from;
//   const array = new Uint8Array(num);
//   let arrayIndex = 0;
//   for (let i = from; i < end; i++) {
//     array[arrayIndex++] = buffer[i];
//   }
//   return array;
// }
//
// export class ChunkParser {
//   buffer: Uint8Array | null = null;
//   position: number = 0;
//
//   parse(bytes: Uint8Array, flush?: boolean): Chunk[] {
//     if (bytes.length === 0 && flush) {
//       return [];
//     }
//
//     const chunkData: Chunk[] = [];
//
//     if (this.buffer == null) {
//       this.buffer = bytes;
//       this.position = 0;
//     } else if (this.position === this.buffer.byteLength) {
//       this.buffer = bytes;
//       this.position = 0;
//     } else {
//       const remaining = this.buffer.byteLength - this.position;
//       const newBuf = new Uint8Array(remaining + bytes.byteLength);
//       const fromExisting = sliceUint8Array(this.buffer, this.position);
//       newBuf.set(fromExisting, 0);
//       const latestDataBuf = new Uint8Array(bytes);
//       newBuf.set(latestDataBuf, remaining);
//       this.buffer = newBuf;
//       this.position = 0;
//     }
//
//     while (true) {
//       if (!hasEnoughBytes(this.buffer, this.position, HEADER_SIZE)) {
//         return chunkData;
//       }
//
//       let headerBuffer = sliceUint8Array(
//         this.buffer,
//         this.position,
//         this.position + HEADER_SIZE
//       );
//
//       const headerView = new DataView(
//         headerBuffer.buffer,
//         headerBuffer.byteOffset,
//         headerBuffer.byteLength
//       );
//
//       const msgLength = readLengthFromHeader(headerView);
//       if (
//         !hasEnoughBytes(this.buffer, this.position, HEADER_SIZE + msgLength)
//       ) {
//         return chunkData;
//       }
//
//       const messageData = sliceUint8Array(
//         this.buffer,
//         this.position + HEADER_SIZE,
//         this.position + HEADER_SIZE + msgLength
//       );
//       this.position += HEADER_SIZE + msgLength;
//
//       if (isTrailerHeader(headerView)) {
//         chunkData.push({
//           chunkType: ChunkType.TRAILERS,
//           trailers: parseTrailerData(messageData),
//         });
//         return chunkData;
//       } else {
//         chunkData.push({ chunkType: ChunkType.MESSAGE, data: messageData });
//       }
//     }
//   }
// }
