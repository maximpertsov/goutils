import { grpc } from "@improbable-eng/grpc-web";
import {
  PromiseClient,
  createPromiseClient,
  createGrpcWebTransport,
  ConnectError,
} from "@bufbuild/connect-web";
// import { Credentials, dialDirect, dialWebRTC } from "@viamrobotics/rpc";
import { Credentials } from "@viamrobotics/rpc";
// import { DialOptions } from "@viamrobotics/rpc/src/dial";
import {
  EchoBiDiRequest,
  EchoMultipleRequest,
  EchoMultipleResponse,
  EchoRequest,
  EchoResponse,
} from "./gen/proto/rpc/examples/echo/v1/echo_pb";
import { EchoService } from "./gen/proto/rpc/examples/echo/v1/echo_connectweb";

const thisHost = `${window.location.protocol}//${window.location.host}`;

declare global {
  interface Window {
    webrtcHost: string;
    creds?: Credentials;
    externalAuthAddr?: string;
    externalAuthToEntity?: string;
  }
}

async function getClients() {
  const webrtcHost = window.webrtcHost;
  // const opts: DialOptions = {
  //   credentials: window.creds,
  //   externalAuthAddress: window.externalAuthAddr,
  //   externalAuthToEntity: window.externalAuthToEntity,
  //   webrtcOptions: {
  //     disableTrickleICE: false,
  //     signalingCredentials: window.creds,
  //   },
  // };
  // if (opts.externalAuthAddress) {
  //   // we are authenticating against the external address and then
  //   // we will authenticate for externalAuthToEntity.
  //   opts.authEntity = opts.externalAuthAddress.replace(/^(.*:\/\/)/, "");
  //
  //   // do similar for WebRTC
  //   opts.webrtcOptions!.signalingExternalAuthAddress = opts.externalAuthAddress;
  //   opts.webrtcOptions!.signalingExternalAuthToEntity =
  //     opts.externalAuthToEntity;
  // }
  // console.log("WebRTC");
  // const webRTCConn = await dialWebRTC(thisHost, webrtcHost, opts);
  // const webrtcClient = new EchoService(webrtcHost, {
  //   transport: webRTCConn.transportFactory,
  // });
  // await doEchos(webrtcClient);

  console.log("Direct"); // bi-di may not work
  // const directTransport = await dialDirect(thisHost, opts);
  // TODO: remove and implement in dialDirect
  const tranport = createGrpcWebTransport({ baseUrl: thisHost });
  const directClient = createPromiseClient(EchoService, tranport);
  await doEchos(directClient);
}

getClients();

// getClients().catch((e) => {
//   console.error("error getting clients", e);
// });

async function doEchos(client: PromiseClient<typeof EchoService>) {
  const echoRequest = new EchoRequest({ message: "hello" });

  try {
    const resp = await client.echo(echoRequest);
    console.log(resp.toJsonString());
  } catch (err) {
    console.error(err);
  }

  const echoMultipleRequest = new EchoMultipleRequest({ message: "hello?" });
  for await (const message of client.echoMultiple(echoMultipleRequest)) {
    console.log(message.toJsonString());
  }
  // multiStream.on(
  //   "end",
  //   ({
  //     code,
  //     details,
  //   }: {
  //     code: number;
  //     details: string;
  //     metadata: grpc.Metadata;
  //   }) => {
  //     if (code !== 0) {
  //       console.log(code);
  //       console.log(details);
  //       pReject(code);
  //       return;
  //     }
  //     pResolve(undefined);
  //   }
  // );
  // await done;
  //
  // const bidiStream = client.echoBiDi();
  //
  // let echoBiDiRequest = new EchoBiDiRequest();
  // echoBiDiRequest.setMessage("one");
  //
  // done = new Promise<any>((resolve, reject) => {
  //   pResolve = resolve;
  //   pReject = reject;
  // });
  //
  // let msgCount = 0;
  // bidiStream.on("data", (message: EchoMultipleResponse) => {
  //   msgCount++;
  //   console.log(message.toObject());
  //   if (msgCount == 3) {
  //     pResolve(undefined);
  //   }
  // });
  // bidiStream.on(
  //   "end",
  //   ({
  //     code,
  //     details,
  //   }: {
  //     code: number;
  //     details: string;
  //     metadata: grpc.Metadata;
  //   }) => {
  //     if (code !== 0) {
  //       console.log(code);
  //       console.log(details);
  //       pReject(code);
  //       return;
  //     }
  //   }
  // );
  //
  // bidiStream.write(echoBiDiRequest);
  // await done;
  //
  // done = new Promise<any>((resolve, reject) => {
  //   pResolve = resolve;
  //   pReject = reject;
  // });
  // msgCount = 0;
  //
  // echoBiDiRequest = new EchoBiDiRequest();
  // echoBiDiRequest.setMessage("two");
  // bidiStream.write(echoBiDiRequest);
  //
  // await done;
  // bidiStream.end();
}
