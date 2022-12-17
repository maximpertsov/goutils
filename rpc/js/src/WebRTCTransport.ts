import { grpc } from "@improbable-eng/grpc-web";
import type { Message } from "@bufbuild/protobuf";
import {
  // Request,
  // RequestHeaders,
  // RequestMessage,
  ResponseMessage,
  Response,
  // Stream,
} from "./gen/proto/rpc/webrtc/v1/grpc_pb";
import type {
  Transport,
  // UnaryRequest,
  UnaryResponse,
  StreamResponse,
  // runUnary,
} from "@bufbuild/connect-web";
import type {
  AnyMessage,
  // Message,
  MethodInfo,
  PartialMessage,
  ServiceType,
} from "@bufbuild/protobuf";
import { MethodKind } from "@bufbuild/protobuf";

import type { ClientStream } from "./ClientStream";

export class WebRTCTransport<
  I extends Message<I> = AnyMessage,
  O extends Message<O> = AnyMessage
> implements Transport
{
  private clientStream: ClientStream;
  private methodInfo: MethodInfo<I, O>;
  // FOR CLIENT
  // TODO: union type?
  private started: boolean = false;
  private closed: boolean = false;
  private finishedSending: boolean = false;
  private sentFirstMessage: boolean = false;
  // FOR UNARY
  private responseHeaders: Headers | null = null;
  private responseMessage: ResponseMessage | null = null;

  constructor(clientStream: ClientStream, methodInfo: MethodInfo<I, O>) {
    this.clientStream = clientStream;
    this.methodInfo = methodInfo;
  }

  // ADAPTED FROM IMPROBABLE-ENGINE CLIENT

  start(metadata?: grpc.Metadata.ConstructorArg) {
    if (this.started) {
      throw new Error("Client already started - cannot .start()");
    }
    this.started = true;

    const requestHeaders = new grpc.Metadata(metadata ? metadata : {});
    requestHeaders.set("content-type", "application/grpc-web+proto");
    requestHeaders.set("x-grpc-web", "1"); // Required for CORS handling

    this.clientStream.start(requestHeaders);
  }

  send(msg: PartialMessage<I>) {
    if (!this.started) {
      throw new Error(
        "Client not started - .start() must be called before .send()"
      );
    }
    if (this.closed) {
      throw new Error("Client already closed - cannot .send()");
    }
    if (this.finishedSending) {
      throw new Error("Client already finished sending - cannot .send()");
    }
    if (
      this.methodInfo.kind !== MethodKind.ClientStreaming &&
      this.sentFirstMessage
    ) {
      // This is a unary method and the first and only message has been sent
      throw new Error(
        "Message already sent for non-client-streaming method - cannot .send()"
      );
    }
    this.sentFirstMessage = true;
    // const msgBytes = frameRequest(msg);
    const msgBytes = (msg as I).toBinary();
    this.clientStream.sendMessage(msgBytes);
  }

  finishSend() {
    if (!this.started) {
      throw new Error(
        "Client not started - .finishSend() must be called before .close()"
      );
    }
    if (this.closed) {
      throw new Error("Client already closed - cannot .send()");
    }
    if (this.finishedSending) {
      throw new Error("Client already finished sending - cannot .finishSend()");
    }
    this.finishedSending = true;
    this.clientStream.finishSend();
  }

  close() {
    if (!this.started) {
      throw new Error(
        "Client not started - .start() must be called before .close()"
      );
    }
    if (!this.closed) {
      this.closed = true;
      // this.props.debug && debug("request.abort aborting request");
      this.clientStream.cancel();
    } else {
      throw new Error("Client already closed - cannot .close()");
    }
  }

  // TRANSPORT INTERFACE

  public async unary<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    _service: ServiceType,
    method: MethodInfo<I, O>,
    _signal: AbortSignal | undefined,
    _timeoutMs: number | undefined,
    _header: Headers,
    _message: PartialMessage<I>
  ): Promise<UnaryResponse<O>> {
    // ADAPTED FROM IMPROBABLE-ENGINE UNARY

    switch (method.kind) {
      case MethodKind.ServerStreaming:
        throw new Error(
          ".unary cannot be used with server-streaming methods. Use .invoke or .client instead."
        );
      case MethodKind.ClientStreaming:
        throw new Error(
          ".unary cannot be used with client-streaming methods. Use .client instead."
        );
    }

    this.responseHeaders = null;
    this.responseMessage = null;

    // client can throw an error if the transport factory returns an error (e.g. no valid transport)
    // const grpcClient = client(methodDescriptor, {
    //   host: props.host,
    //   transport: props.transport,
    //   debug: props.debug,
    // });

    grpcClient.onHeaders((headers: Metadata) => {
      responseHeaders = headers;
    });
    grpcClient.onMessage((res: TResponse) => {
      responseMessage = res;
    });
    grpcClient.onEnd(
      (status: Code, statusMessage: string, trailers: Metadata) => {
        props.onEnd({
          status: status,
          statusMessage: statusMessage,
          headers: responseHeaders ? responseHeaders : new Metadata(),
          message: responseMessage,
          trailers: trailers,
        });
      }
    );

    grpcClient.start(props.metadata);
    grpcClient.send(props.request);
    grpcClient.finishSend();

    return {
      close: () => {
        grpcClient.close();
      },
    };

    // // END OF IMPROBABLE-ENG STUFF
    //
    // // TODO: this is filler, remove once actual logic is set
    //
    // const resp = new Response();
    //
    // // TODO: get headers
    // let header = new Headers();
    // if (resp.type.case === "headers") {
    //   const metadata = resp.type.value.metadata;
    //   if (metadata) {
    //     for (const [key, strings] of Object.entries(metadata.md)) {
    //       strings.values.forEach((value) => {
    //         header.append(key, value);
    //       });
    //     }
    //   }
    // }
    //
    // // TODO: get message
    // let message: O = new method.O();
    // if (resp.type.case === "message") {
    //   const packetMessage = resp.type.value.packetMessage;
    //   if (packetMessage) {
    //     message = method.O.fromBinary(packetMessage.data);
    //   }
    // }
    //
    // // TODO: get trailers
    // let trailer = new Headers();
    // if (resp.type.case === "headers") {
    //   const metadata = resp.type.value.metadata;
    //   if (metadata) {
    //     for (const [key, strings] of Object.entries(metadata.md)) {
    //       strings.values.forEach((value) => {
    //         trailer.append(key, value);
    //       });
    //     }
    //   }
    // }
    //
    // return <UnaryResponse<O>>{
    //   stream: resp.stream || false,
    //   service,
    //   method,
    //   // TODO: this might be wrong - what if this isn't a header message?
    //   header,
    //   // TODO: this might be wrong - what if this isn't a "body" message?
    //   message,
    //   // TODO: this might be wrong - what if this isn't a trailer message?
    //   trailer,
    // };
  }

  public async serverStream<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    service: ServiceType,
    method: MethodInfo<I, O>,
    _signal: AbortSignal | undefined,
    _timeoutMs: number | undefined,
    _header: Headers,
    _message: PartialMessage<I>
  ): Promise<StreamResponse<O>> {
    const read = () => new Promise((_resolve, _reject) => {});
    return <StreamResponse<O>>{
      stream: true,
      service,
      method,
      header: new Headers(),
      read,
      trailer: new Headers(),
    };
  }
}
