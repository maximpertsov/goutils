import { BaseChannel } from "./BaseChannel";
import { RequestHeaders, RequestMessage, Stream } from "./gen/proto/rpc/webrtc/v1/grpc_pb";
import type { GrpcWebTransportOptions, Transport } from "@bufbuild/connect-web";
declare type TransportFactory = (opts: GrpcWebTransportOptions) => Transport;
export declare class ClientChannel extends BaseChannel {
    private streamIDCounter;
    private readonly streams;
    constructor(pc: RTCPeerConnection, dc: RTCDataChannel);
    transportFactory(): TransportFactory;
    private onConnectionTerminated;
    private onChannelMessage;
    private nextStreamID;
    private newStream;
    private removeStreamByID;
    writeHeaders(stream: Stream, headers: RequestHeaders): void;
    writeMessage(stream: Stream, msg: RequestMessage): void;
    writeReset(stream: Stream): void;
}
export {};
