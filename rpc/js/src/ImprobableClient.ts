import { grpc } from "@improbable-eng/grpc-web";
import type {
  MethodInfo,
  MethodInfoServerStreaming,
  MethodInfoUnary,
  PartialMessage,
  ServiceType,
  Message,
  MethodKind,
} from "@bufbuild/protobuf";
export { makeAnyClient } from "@bufbuild/connect-web";

export function createImprobableClient<T extends ServiceType>(
  service: T,
  client: grpc.Client
) {
  return makeAnyClient(service, (method) => {
    switch (method.kind) {
      case MethodKind.Unary:
        return grpc.client(T
      case MethodKind.ServerStreaming:
        return createServerStreamingFn(transport, service, method);
      default:
        return null;
    }
  }) as PromiseClient<T>;
}
