import type { GrpcWebTransportOptions } from "@bufbuild/connect-web";
import type { PacketMessage, Stream } from "./gen/proto/rpc/webrtc/v1/grpc_pb";

// MaxMessageSize is the maximum size a gRPC message can be.
let MaxMessageSize = 1 << 25;

export class BaseStream {
  protected readonly stream: Stream;
  private readonly onDone: (id: bigint) => void;
  private readonly onEnd: (err?: Error) => void;
  protected readonly opts: GrpcWebTransportOptions;
  protected closed: boolean = false;
  private readonly packetBuf: Array<Uint8Array> = [];
  private packetBufSize = 0;
  // @ts-ignore
  private err?: Error;

  constructor(
    stream: Stream,
    onDone: (id: bigint) => void,
    onEnd: (err?: Error) => void,
    opts: GrpcWebTransportOptions
  ) {
    this.stream = stream;
    this.onDone = onDone;
    this.onEnd = onEnd;
    this.opts = opts;
  }

  public closeWithRecvError(err?: Error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.err = err;
    this.onDone(this.stream.id);
    // pretty sure passing the error does nothing.
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
}
