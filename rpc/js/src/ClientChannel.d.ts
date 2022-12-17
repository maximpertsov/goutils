import type { grpc } from "@improbable-eng/grpc-web";
import {
  Transport,
  UnaryResponse,
  StreamResponse,
} from "@bufbuild/connect-web";
import type {
  AnyMessage,
  Message,
  MethodInfo,
  PartialMessage,
  ServiceType,
} from "@bufbuild/protobuf";
import { BaseChannel } from "./BaseChannel";
import {
  RequestHeaders,
  RequestMessage,
  Stream,
} from "./gen/proto/rpc/webrtc/v1/grpc_pb";

export declare class ClientChannel extends BaseChannel implements Transport {
  private streamIDCounter;
  private readonly streams;
  constructor(pc: RTCPeerConnection, dc: RTCDataChannel);
  transportFactory(): grpc.TransportFactory;
  private onConnectionTerminated;
  private onChannelMessage;
  private nextStreamID;
  private newStream;
  private removeStreamByID;
  writeHeaders(stream: Stream, headers: RequestHeaders): void;
  writeMessage(stream: Stream, msg: RequestMessage): void;
  writeReset(stream: Stream): void;

  // implement connect-web transport interface
  public unary<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    service: ServiceType,
    method: MethodInfo<I, O>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    header: HeadersInit | undefined,
    message: PartialMessage<I>
  ): Promise<UnaryResponse<O>>;
  public serverStream<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    service: ServiceType,
    method: MethodInfo<I, O>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    header: HeadersInit | undefined,
    message: PartialMessage<I>
  ): Promise<StreamResponse<O>>;
}
