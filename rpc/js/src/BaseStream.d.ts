import type { PacketMessage, Stream } from "./gen/proto/rpc/webrtc/v1/grpc_pb";
import type { GrpcWebTransportOptions } from "@bufbuild/connect-web";
import { Code } from "@bufbuild/connect-web";
export declare class BaseStream {
    protected readonly stream: Stream;
    private readonly onDone;
    protected readonly opts: GrpcWebTransportOptions;
    protected closed: boolean;
    private readonly packetBuf;
    private packetBufSize;
    private err?;
    protected completed: boolean;
    protected responseHeaders?: Headers;
    protected responseTrailers?: Headers;
    constructor(stream: Stream, onDone: (id: bigint) => void, opts: GrpcWebTransportOptions);
    waitUntilCompleteOrClosed(): void;
    closeWithRecvError(err?: Error): void;
    protected processPacketMessage(msg: PacketMessage): Uint8Array | undefined;
    onEnd(_err?: Error): void;
    rawOnEnd(_code: Code, _message: string, _trailers: Headers): void;
    rawOnError(_code: Code, _msg: string, _trailers?: Headers): void;
    protected getStatusFromHeaders(headers: Headers): Code | null;
    protected decodeGRPCStatus(src: string | undefined): string;
}
