import { grpc } from "@improbable-eng/grpc-web";
// import { Credentials, dialDirect, dialWebRTC } from "@viamrobotics/rpc";
import { Credentials, dialDirect, DialOptions } from "../../../../js/src/dial";
import { createPromiseClient, PromiseClient } from "@bufbuild/connect-web";
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
    accessToken?: string;
  }
}

async function getClients() {
  const webrtcHost = window.webrtcHost;
  const opts: DialOptions = {
    externalAuthAddress: window.externalAuthAddr,
    externalAuthToEntity: window.externalAuthToEntity,
    webrtcOptions: {
      disableTrickleICE: false,
    },
  };

  if (!window.accessToken) {
    opts.credentials = window.creds;
    opts.webrtcOptions!.signalingCredentials = window.creds;
  } else {
    opts.accessToken = window.accessToken;
  }

  if (opts.externalAuthAddress) {
    if (!window.accessToken) {
      // we are authenticating against the external address and then
      // we will authenticate for externalAuthToEntity.
      opts.authEntity = opts.externalAuthAddress.replace(/^(.*:\/\/)/, "");
    }

    // do similar for WebRTC
    opts.webrtcOptions!.signalingExternalAuthAddress = opts.externalAuthAddress;
    opts.webrtcOptions!.signalingExternalAuthToEntity =
      opts.externalAuthToEntity;
  }

  // console.log("WebRTC")
  // const webRTCConn = await dialWebRTC(thisHost, webrtcHost, opts);
  // const webrtcClient = new EchoServiceClient(webrtcHost, { transport: webRTCConn.transportFactory });
  // await doEchos(webrtcClient);

  console.log("Direct"); // bi-di may not work
  const directTransport = await dialDirect(thisHost, opts);
  const directClient = createPromiseClient(
    EchoService,
    directTransport({ baseUrl: thisHost })
  );
  await doEchos(directClient);
}
getClients().catch((e) => {
  console.error("error getting clients", e);
});

async function doEchos(client: PromiseClient<typeof EchoService>) {
  const echoRequest = new EchoRequest();
  echoRequest.message = "hello";

  const echoResponse = await client.echo(echoRequest);
  console.log(echoResponse.message);

  const echoMultipleRequest = new EchoMultipleRequest();
  echoMultipleRequest.message = "hello?";

  const multiStream = client.echoMultiple(echoMultipleRequest);
  for await (const echoMultipleResponse of multiStream) {
    console.log(echoMultipleResponse);
  }

  // const bidiStream = client.echoBiDi();
  //
  // let echoBiDiRequest = new EchoBiDiRequest();
  // echoBiDiRequest.setMessage("one");
  //
  // done = new Promise<any>((resolve, reject) => {
  // 	pResolve = resolve;
  // 	pReject = reject;
  // });
  //
  // let msgCount = 0;
  // bidiStream.on("data", (message: EchoMultipleResponse) => {
  // 	msgCount++
  // 	console.log(message.toObject());
  // 	if (msgCount == 3) {
  // 		pResolve(undefined);
  // 	}
  // });
  // bidiStream.on("end", ({ code, details }: { code: number, details: string, metadata: grpc.Metadata }) => {
  // 	if (code !== 0) {
  // 		console.log(code);
  // 		console.log(details);
  // 		pReject(code);
  // 		return;
  // 	}
  // });
  //
  // bidiStream.write(echoBiDiRequest);
  // await done;
  //
  // done = new Promise<any>((resolve, reject) => {
  // 	pResolve = resolve;
  // 	pReject = reject;
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
