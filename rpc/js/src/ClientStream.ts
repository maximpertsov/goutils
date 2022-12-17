import { grpc } from "@improbable-eng/grpc-web";
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

export class ClientStream extends BaseStream implements grpc.Transport {
  private readonly channel: ClientChannel;
  private headersReceived: boolean = false;
  private trailersReceived: boolean = false;

  constructor(
    channel: ClientChannel,
    stream: Stream,
    onDone: (id: bigint) => void,
    opts: grpc.TransportOptions
  ) {
    super(stream, onDone, opts);
    this.channel = channel;
  }

  public start(metadata: grpc.Metadata) {
    const method = `/${this.opts.methodDefinition.service.serviceName}/${this.opts.methodDefinition.methodName}`;
    const requestHeaders = new RequestHeaders();
    requestHeaders.method = method;
    requestHeaders.metadata = fromGRPCMetadata(metadata);

    try {
      this.channel.writeHeaders(this.stream, requestHeaders);
    } catch (error) {
      console.error("error writing headers", error);
      this.closeWithRecvError(error as Error);
    }
  }

  public sendMessage(msgBytes?: Uint8Array) {
    // skip frame header bytes
    if (msgBytes) {
      this.writeMessage(false, msgBytes.slice(5));
      return;
    }
    this.writeMessage(false, undefined);
  }

  public resetStream() {
    try {
      this.channel.writeReset(this.stream);
    } catch (error) {
      console.error("error writing reset", error);
      this.closeWithRecvError(error as Error);
    }
  }

  public finishSend() {
    if (!this.opts.methodDefinition.requestStream) {
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
      if (!msgBytes || msgBytes.length == 0) {
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

  public getOpts(): grpc.TransportOptions {
    return this.opts;
  }

  public onResponse(resp: Response) {
    switch (resp.type.case) {
      case "headers":
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
        if (!this.headersReceived) {
          this.closeWithRecvError(new Error("headers not yet received"));
          return;
        }
        if (this.trailersReceived) {
          this.closeWithRecvError(new Error("headers received after trailers"));
          return;
        }
        this.processMessage(resp.type.value!);
        break;
      case "trailers":
        this.processTrailers(resp.type.value!);
        break;
      default:
        console.error("unknown response type", resp.type.case);
        break;
    }
  }

  private processHeaders(headers: ResponseHeaders) {
    this.headersReceived = true;
    this.opts.onHeaders(toGRPCMetadata(headers.metadata), 200);
  }

  private processMessage(msg: ResponseMessage) {
    const result = super.processPacketMessage(msg.packetMessage!);
    if (!result) {
      return;
    }
    const chunk = new ArrayBuffer(result.length + 5);
    new DataView(chunk, 1, 4).setUint32(0, result.length, false);
    new Uint8Array(chunk, 5).set(result);
    this.opts.onChunk(new Uint8Array(chunk));
  }

  private processTrailers(trailers: ResponseTrailers) {
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
    this.opts.onChunk(new Uint8Array(chunk));
    if (statusCode === 0) {
      this.closeWithRecvError();
      return;
    }
    this.closeWithRecvError(new GRPCError(statusCode, statusMessage));
  }
}

// from https://github.com/improbable-eng/grpc-web/blob/6fb683f067bd56862c3a510bc5590b955ce46d2a/ts/src/ChunkParser.ts#L22
export function encodeASCII(input: string): Uint8Array {
  const encoded = new Uint8Array(input.length);
  for (let i = 0; i !== input.length; ++i) {
    const charCode = input.charCodeAt(i);
    if (!isValidHeaderAscii(charCode)) {
      throw new Error("Metadata contains invalid ASCII");
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

function headersToBytes(headers: grpc.Metadata): Uint8Array {
  let asString = "";
  headers.forEach((key, values) => {
    asString += `${key}: ${values.join(", ")}\r\n`;
  });
  return encodeASCII(asString);
}

// from https://github.com/jsmouret/grpc-over-webrtc/blob/45cd6d6cf516e78b1e262ea7aa741bc7a7a93dbc/client-improbable/src/grtc/webrtcclient.ts#L7
const fromGRPCMetadata = (metadata?: grpc.Metadata): Metadata | undefined => {
  if (!metadata) {
    return undefined;
  }
  const result = new Metadata();
  metadata.forEach((key, values) => {
    const strings = new Strings();
    strings.values = values;
    result.md[key] = strings;
  });
  if (Object.keys(result.md).length === 0) {
    return undefined;
  }
  return result;
};

const toGRPCMetadata = (metadata?: Metadata): grpc.Metadata => {
  const result = new grpc.Metadata();
  if (metadata !== undefined) {
    for (let [key, strings] of Object.entries(metadata.md)) {
      result.append(key, strings.values);
    }
  }
  return result;
};
