import type { GrpcWebTransportOptions } from "@bufbuild/connect-web";
import type {
  AnyMessage,
  Message,
  MethodInfo,
  ServiceType,
} from "@bufbuild/protobuf";

export interface GrpcWebRTCTransportOptions<
  I extends Message<I> = AnyMessage,
  O extends Message<O> = AnyMessage
> extends GrpcWebTransportOptions {
  service: ServiceType;
  method: MethodInfo<I, O>;
  // methodDefinition: MethodDefinition<ProtobufMessage, ProtobufMessage>;
  // debug: boolean;
  // url: string;
  // onHeaders: (headers: Metadata, status: number) => void;
  // onChunk: (chunkBytes: Uint8Array, flush?: boolean) => void;
  // onEnd: (err?: Error) => void;
}
