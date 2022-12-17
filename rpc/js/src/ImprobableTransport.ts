import { grpc } from "@improbable-eng/grpc-web";
// import type { ServiceType } from "@bufbuild/connect-web";
import {
  AnyMessage,
  // MethodInfo,
  type Message,
  // ServiceType,
} from "@bufbuild/protobuf";

// import { SignalingService } from "./gen/proto/rpc/webrtc/v1/signaling_connectweb";

// export function test() {
//   const it = new ImprobableTransport({
//     host: "foo",
//     transport: grpc.CrossBrowserHttpTransport({}),
//   });
//   const client = it.client(SignalingService);
//   client.start();
// }

// function toProtobufMessage<T extends grpc.ProtobufMessage>(message: Message<T>): grpc.ProtobufMessageClass<T> {
//   return {
//     ...message,
//     new: () => message.clone(),
//     deserializeBinary: (bytes: Uint8Array) => message.fromBinary(bytes).clone(),
//     toObject: () => message.toJson(),
//     serializeBinary: () => message.toBinary(),
//   };
// }

class ESProtobufMessageClass<M extends Message<M>>
  implements grpc.ProtobufMessageClass<grpc.ProtobufMessage>
{
  private message: Message<M>;

  constructor(message: Message<M>) {
    this.message = message;
  }

  deserializeBinary(bytes: Uint8Array) {
    return this.message.fromBinary(bytes).clone();
  }

  toObject() {
    return this.message.clone();
  }

  serializeBinary() {
    return this.message.toBinary();
  }
}

// function toMethodDefinition<
//   I extends grpc.ProtobufMessage,
//   O extends grpc.ProtobufMessage
// >(service: ServiceType, methodInfo: MethodInfo): grpc.MethodDefinition<I, O> {
//   return {
//     service: {
//       serviceName: service.typeName,
//     },
//     methodName: methodInfo.name,
//     requestStream: false,
//     responseStream: false,
//     // requestType: new grpc.ProtobufMessageClass<I>(),
//     // responseType: new grpc.ProtobufMessageClass<O>(),
//     ...service,
//   };
// }

// export class ImprobableTransport implements Transport {
export class ImprobableTransport {
  private readonly opts: grpc.ClientRpcOptions;

  constructor(opts: grpc.ClientRpcOptions) {
    this.opts = opts;
  }

  public client<
    TRequest extends grpc.ProtobufMessage,
    TResponse extends grpc.ProtobufMessage,
    M extends grpc.MethodDefinition<TRequest, TResponse>
  >(methodDescriptor: M): grpc.Client<TRequest, TResponse> {
    return grpc.client<TRequest, TResponse, M>(methodDescriptor, this.opts);
  }

  // public async unary<
  //   I extends Message<I> = AnyMessage,
  //   O extends Message<O> = AnyMessage
  // >(
  //   service: ServiceType,
  //   method: MethodInfo<I, O>,
  //   _signal: AbortSignal | undefined,
  //   _timeoutMs: number | undefined,
  //   _header: Headers,
  //   _message: PartialMessage<I>
  // ): Promise<UnaryResponse<O>> {
  //
  //   this.transport.start()
  //   this.transport.sendMessage
  //
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
}
