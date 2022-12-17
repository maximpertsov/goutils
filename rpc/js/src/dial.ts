import { grpc } from "@improbable-eng/grpc-web";
import {
  createPromiseClient,
  createGrpcWebTransport,
  encodeBinaryHeader,
  ConnectError,
} from "@bufbuild/connect-web";
import { ClientChannel } from "./ClientChannel";
import { ConnectionClosedError } from "./errors";
import { Code } from "./gen/google/rpc/code_pb";
import { Status } from "./gen/google/rpc/status_pb";
import {
  AuthenticateRequest,
  AuthenticateToRequest,
  Credentials as PBCredentials,
} from "./gen/proto/rpc/v1/auth_pb";
import {
  AuthService,
  ExternalAuthService,
} from "./gen/proto/rpc/v1/auth_connectweb";
import {
  CallRequest,
  CallUpdateRequest,
  ICECandidate,
} from "./gen/proto/rpc/webrtc/v1/signaling_pb";
import { SignalingService } from "./gen/proto/rpc/webrtc/v1/signaling_connectweb";
import { newPeerConnectionForClient } from "./peer";

export interface DialOptions {
  authEntity?: string;
  credentials?: Credentials;
  webrtcOptions?: DialWebRTCOptions;
  externalAuthAddress?: string;
  externalAuthToEntity?: string;

  // `accessToken` allows a pre-authenticated client to dial with
  // an authorization header. Direct dial will have the access token
  // appended to the "Authorization: Bearer" header. WebRTC dial will
  // appened it to the signaling server communication
  //
  // If enabled, other auth options have no affect. Eg. authEntity, credentials,
  // externalAuthAddress, externalAuthToEntity, webrtcOptions.signalingAccessToken
  accessToken?: string;
}

export interface DialWebRTCOptions {
  disableTrickleICE: boolean;
  rtcConfig?: RTCConfiguration;

  // signalingAuthEntity is the entity to authenticate as to the signaler.
  signalingAuthEntity?: string;

  // signalingExternalAuthAddress is the address to perform external auth yet.
  // This is unlikely to be needed since the signaler is typically in the same
  // place where authentication happens.
  signalingExternalAuthAddress?: string;

  // signalingExternalAuthToEntity is the entity to authenticate for after
  // externally authenticating.
  // This is unlikely to be needed since the signaler is typically in the same
  // place where authentication happens.
  signalingExternalAuthToEntity?: string;

  // signalingCredentials are used to authenticate the request to the signaling server.
  signalingCredentials?: Credentials;

  // `signalingAccessToken` allows a pre-authenticated client to dial with
  // an authorization header to the signaling server. This skips the Authenticate()
  // request to the singaling server or external auth but does not skip the
  // AuthenticateTo() request to retrieve the credentials at the external auth
  // endpoint.
  //
  // If enabled, other auth options have no affect. Eg. authEntity, credentials, signalingAuthEntity, signalingCredentials.
  signalingAccessToken?: string;
}

export interface Credentials {
  type: string;
  payload: string;
}

export async function dialDirect(
  address: string,
  opts?: DialOptions
): Promise<grpc.TransportFactory> {
  validateDialOptions(opts);

  const defaultFactory = (opts: grpc.TransportOptions): grpc.Transport => {
    return grpc.CrossBrowserHttpTransport({ withCredentials: false })(opts);
  };

  // Client already has access token with no external auth, skip Authenticate process.
  if (
    opts?.accessToken &&
    !(opts?.externalAuthAddress && opts?.externalAuthToEntity)
  ) {
    const md = new grpc.Metadata();
    md.set("authorization", `Bearer ${opts.accessToken}`);
    return (opts: grpc.TransportOptions): grpc.Transport => {
      return new authenticatedTransport(opts, defaultFactory, md);
    };
  }

  if (!opts?.credentials) {
    return defaultFactory;
  }

  return makeAuthenticatedTransportFactory(address, defaultFactory, opts);
}

async function makeAuthenticatedTransportFactory(
  address: string,
  defaultFactory: grpc.TransportFactory,
  opts?: DialOptions
): Promise<grpc.TransportFactory> {
  let accessToken = "";
  const getExtraMetadata = async (): Promise<grpc.Metadata> => {
    // TODO(GOUT-10): handle expiration
    if (accessToken == "") {
      let thisAccessToken = "";

      if (opts?.accessToken != "") {
        const request = new AuthenticateRequest();
        request.entity = opts?.authEntity
          ? opts.authEntity
          : address.replace(/^(.*:\/\/)/, "");
        const creds = new PBCredentials();
        creds.type = opts?.credentials?.type!;
        creds.payload = opts?.credentials?.payload!;
        request.credentials = creds;

        const response = await createPromiseClient(
          AuthService,
          // TODO: use default transport?
          createGrpcWebTransport({
            baseUrl: opts?.externalAuthAddress
              ? opts.externalAuthAddress
              : address,
          })
        ).authenticate(request);
        thisAccessToken = response.accessToken;
      } else {
        thisAccessToken = opts.accessToken;
      }

      accessToken = thisAccessToken;

      if (opts?.externalAuthAddress && opts?.externalAuthToEntity) {
        const md = new Headers();
        md.set("authorization", encodeBinaryHeader(`Bearer ${accessToken}`));

        thisAccessToken = "";

        const request = new AuthenticateToRequest();
        request.entity = opts.externalAuthToEntity;

        const response = await createPromiseClient(
          ExternalAuthService,
          // TODO: use default transport?
          createGrpcWebTransport({
            baseUrl: opts.externalAuthAddress!,
          })
        ).authenticateTo(request, { headers: md });
        thisAccessToken = response.accessToken;
        accessToken = thisAccessToken;
      }
    }
    const md = new grpc.Metadata();
    md.set("authorization", `Bearer ${accessToken}`);
    return md;
  };
  const extraMd = await getExtraMetadata();
  return (opts: grpc.TransportOptions): grpc.Transport => {
    return new authenticatedTransport(opts, defaultFactory, extraMd);
  };
}

class authenticatedTransport implements grpc.Transport {
  protected readonly opts: grpc.TransportOptions;
  protected readonly transport: grpc.Transport;
  protected readonly extraMetadata: grpc.Metadata;

  constructor(
    opts: grpc.TransportOptions,
    defaultFactory: grpc.TransportFactory,
    extraMetadata: grpc.Metadata
  ) {
    this.opts = opts;
    this.extraMetadata = extraMetadata;
    this.transport = defaultFactory(opts);
  }

  public start(metadata: grpc.Metadata) {
    this.extraMetadata.forEach((key: string, values: string | string[]) => {
      metadata.set(key, values);
    });
    this.transport.start(metadata);
  }

  public sendMessage(msgBytes: Uint8Array) {
    this.transport.sendMessage(msgBytes);
  }

  public finishSend() {
    this.transport.finishSend();
  }

  public cancel() {
    this.transport.cancel();
  }
}

interface WebRTCConnection {
  transportFactory: grpc.TransportFactory;
  peerConnection: RTCPeerConnection;
}

// dialWebRTC makes a connection to given host by signaling with the address provided. A Promise is returned
// upon successful connection that contains a transport factory to use with gRPC client as well as the WebRTC
// PeerConnection itself. Care should be taken with the PeerConnection and is currently returned for experimental
// use.
// TODO(GOUT-7): figure out decent way to handle reconnect on connection termination
export async function dialWebRTC(
  signalingAddress: string,
  host: string,
  opts?: DialOptions
): Promise<WebRTCConnection> {
  validateDialOptions(opts);

  const webrtcOpts = opts?.webrtcOptions;
  const { pc, dc } = await newPeerConnectionForClient(
    webrtcOpts !== undefined && webrtcOpts.disableTrickleICE,
    webrtcOpts?.rtcConfig
  );
  let successful = false;

  try {
    // replace auth entity and creds
    let optsCopy = opts;
    if (opts) {
      optsCopy = { ...opts } as DialOptions;

      if (!opts.accessToken) {
        optsCopy.authEntity = opts?.webrtcOptions?.signalingAuthEntity;
        if (!optsCopy.authEntity) {
          if (optsCopy.externalAuthAddress) {
            optsCopy.authEntity = opts.externalAuthAddress?.replace(
              /^(.*:\/\/)/,
              ""
            );
          } else {
            optsCopy.authEntity = signalingAddress.replace(/^(.*:\/\/)/, "");
          }
        }
        optsCopy.credentials = opts?.webrtcOptions?.signalingCredentials;
        optsCopy.externalAuthAddress =
          opts?.webrtcOptions?.signalingExternalAuthAddress;
        optsCopy.externalAuthToEntity =
          opts?.webrtcOptions?.signalingExternalAuthToEntity;
        optsCopy.accessToken = opts?.webrtcOptions?.signalingAccessToken;
      }
    }

    // TODO: use this instead re-instantiating the transport over and over
    // const directTransport = await dialDirect(signalingAddress, optsCopy);

    let uuid = "";
    // only send once since exchange may end or ICE may end
    let sentDoneOrErrorOnce = false;
    const sendError = async (err: string) => {
      if (sentDoneOrErrorOnce) {
        return;
      }
      sentDoneOrErrorOnce = true;
      const callRequestUpdate = new CallUpdateRequest();
      callRequestUpdate.uuid = uuid;
      const status = new Status();
      status.code = Code.UNKNOWN;
      status.message = err;
      callRequestUpdate.update = { case: "error", value: status };

      try {
        const md = new Headers();
        md.set("rpc-host", encodeBinaryHeader(host));
        const response = await createPromiseClient(
          SignalingService,
          // TODO: use directTransport
          createGrpcWebTransport({ baseUrl: signalingAddress })
        ).callUpdate(callRequestUpdate, { headers: md });
        // TODO: is this required?
        if (!response.toBinary) {
          console.error("empty message");
        }
      } catch (error) {
        if (error instanceof ConnectError) {
          console.error(error.message);
        }
      }
    };
    const sendDone = async () => {
      if (sentDoneOrErrorOnce) {
        return;
      }
      sentDoneOrErrorOnce = true;
      const callRequestUpdate = new CallUpdateRequest();
      callRequestUpdate.uuid = uuid;
      callRequestUpdate.update = { case: "done", value: true };

      const md = new Headers();
      md.set("rpc-host", encodeBinaryHeader(host));
      try {
        const response = await createPromiseClient(
          SignalingService,
          createGrpcWebTransport({ baseUrl: signalingAddress })
        ).callUpdate(callRequestUpdate, { headers: md });
        // TODO: is this required?
        if (!response.toBinary) {
          console.error("empty message");
        }
      } catch (error) {
        if (error instanceof ConnectError) {
          console.error(error.message);
        }
      }
    };

    // let pResolve: (value: unknown) => void;
    // let remoteDescSet = new Promise<unknown>((resolve) => {
    //   pResolve = resolve;
    // });
    let exchangeDone = false;
    if (!webrtcOpts?.disableTrickleICE) {
      // set up offer
      const offerDesc = await pc.createOffer();

      let iceComplete = false;
      pc.onicecandidate = async (event) => {
        // TODO: why is this necessary?
        // await remoteDescSet;
        if (exchangeDone) {
          return;
        }

        if (event.candidate === null) {
          iceComplete = true;
          await sendDone();
          return;
        }

        const iProto = iceCandidateToProto(event.candidate);
        const callRequestUpdate = new CallUpdateRequest();
        callRequestUpdate.uuid = uuid;
        callRequestUpdate.update = { case: "candidate", value: iProto };

        const md = new Headers();
        md.set("rpc-host", encodeBinaryHeader(host));
        try {
          const response = await createPromiseClient(
            SignalingService,
            createGrpcWebTransport({ baseUrl: signalingAddress })
          ).callUpdate(callRequestUpdate, { headers: md });
          if (!response.toBinary && !exchangeDone && !iceComplete) {
            console.error("error sending candidate");
          }
        } catch (error) {
          if (error instanceof ConnectError && !exchangeDone && !iceComplete) {
            console.error("error sending candidate", error.message);
          }
        }
      };

      await pc.setLocalDescription(offerDesc);
    }

    // this client is only for the `call` service
    const client = createPromiseClient(
      SignalingService,
      // use dialdirect / direct transport
      createGrpcWebTransport({ baseUrl: signalingAddress })
    );

    let haveInit = false;
    // TS says that CallResponse isn't a valid type here. More investigation required.
    // client.onMessage(async (message: ProtobufMessage) => {
    //   const response = message as CallResponse;

    // switch (response.stage.case) {
    //   case "init":
    //     if (haveInit) {
    //       await sendError("got init stage more than once");
    //       return;
    //     }
    //     const init = response.stage.value!;
    //     haveInit = true;
    //     uuid = response.uuid;
    //
    //     const remoteSDP = new RTCSessionDescription(
    //       JSON.parse(atob(init.sdp))
    //     );
    //     pc.setRemoteDescription(remoteSDP);
    //
    //     pResolve(true);
    //
    //     if (webrtcOpts?.disableTrickleICE) {
    //       exchangeDone = true;
    //       await sendDone();
    //       return;
    //     }
    //     break;
    //   case "update":
    //     if (!haveInit) {
    //       await sendError("got update stage before init stage");
    //       return;
    //     }
    //     if (response.uuid !== uuid) {
    //       await sendError(
    //         `uuid mismatch; have=${response.uuid} want=${uuid}`
    //       );
    //       return;
    //     }
    //     const update = response.stage.value!;
    //     const cand = iceCandidateFromProto(update.candidate!);
    //     try {
    //       await pc.addIceCandidate(cand);
    //     } catch (error) {
    //       await sendError(JSON.stringify(error));
    //       return;
    //     }
    //     break;
    //   default:
    //     await sendError("unknown CallResponse stage");
    //     return;
    // }
    // });

    let clientEndResolve: () => void;
    let clientEndReject: (reason?: unknown) => void;
    let clientEnd = new Promise<void>((resolve, reject) => {
      clientEndResolve = resolve;
      clientEndReject = reject;
    });
    // client.onEnd(
    //   (status: grpc.Code, statusMessage: string, _trailers: grpc.Metadata) => {
    //     if (status === grpc.Code.OK) {
    //       clientEndResolve();
    //       return;
    //     }
    //     if (statusMessage === "Response closed without headers") {
    //       clientEndReject(new ConnectionClosedError("failed to dial"));
    //       return;
    //     }
    //     console.error(statusMessage);
    //     clientEndReject(statusMessage);
    //   }
    // );
    // client.start({ "rpc-host": host });

    const callRequest = new CallRequest();
    const encodedSDP = btoa(JSON.stringify(pc.localDescription));
    callRequest.sdp = encodedSDP;
    if (webrtcOpts && webrtcOpts.disableTrickleICE) {
      callRequest.disableTrickle = webrtcOpts.disableTrickleICE;
    }

    const md = new Headers();
    md.set("rpc-host", encodeBinaryHeader(host));
    try {
      for await (const response of client.call(callRequest)) {
        // on message
        switch (response.stage.case) {
          case "init":
            if (haveInit) {
              await sendError("got init stage more than once");
              break;
            }
            const init = response.stage.value!;
            haveInit = true;
            uuid = response.uuid;

            const remoteSDP = new RTCSessionDescription(
              JSON.parse(atob(init.sdp))
            );
            pc.setRemoteDescription(remoteSDP);

            // TODO: why is this necessary?
            // pResolve(true);

            if (webrtcOpts?.disableTrickleICE) {
              exchangeDone = true;
              await sendDone();
              break;
            }
            break;
          case "update":
            if (!haveInit) {
              await sendError("got update stage before init stage");
              break;
            }
            if (response.uuid !== uuid) {
              await sendError(
                `uuid mismatch; have=${response.uuid} want=${uuid}`
              );
              break;
            }
            const update = response.stage.value!;
            const cand = iceCandidateFromProto(update.candidate!);
            try {
              await pc.addIceCandidate(cand);
            } catch (error) {
              await sendError(JSON.stringify(error));
              break;
            }
            break;
          default:
            await sendError("unknown CallResponse stage");
        }
      }
    } catch (error) {
      if (error instanceof ConnectError) {
        if (error.message === "Response closed without headers") {
          throw new ConnectionClosedError("failed to dial");
        }
        console.error(error.message);
      }
    }

    // client.send(callRequest);

    const cc = new ClientChannel(pc, dc);
    cc.ready
      .then(() => clientEndResolve())
      .catch((err) => clientEndReject(err));
    await clientEnd;
    await cc.ready;
    exchangeDone = true;
    await sendDone();

    if (opts?.externalAuthAddress) {
      // TODO(GOUT-11): prepare AuthenticateTo here
      // for client channel.
    } else if (opts?.credentials?.type) {
      // TODO(GOUT-11): prepare Authenticate here
      // for client channel
    }

    successful = true;
    return { transportFactory: cc.transportFactory(), peerConnection: pc };
  } finally {
    if (!successful) {
      pc.close();
    }
  }
}

function iceCandidateFromProto(i: ICECandidate): RTCIceCandidateInit {
  let candidate: RTCIceCandidateInit = {
    candidate: i.candidate,
  };
  if (i.sdpMid !== null) {
    candidate.sdpMid = i.sdpMid;
  }
  if (i.sdpmLineIndex !== null) {
    candidate.sdpMLineIndex = i.sdpmLineIndex;
  }
  if (i.usernameFragment !== null) {
    candidate.usernameFragment = i.usernameFragment;
  }
  return candidate;
}

function iceCandidateToProto(i: RTCIceCandidateInit): ICECandidate {
  let candidate = new ICECandidate();
  candidate.candidate = i.candidate!;
  if (i.sdpMid) {
    candidate.sdpMid = i.sdpMid;
  }
  if (i.sdpMLineIndex) {
    candidate.sdpmLineIndex = i.sdpMLineIndex;
  }
  if (i.usernameFragment) {
    candidate.usernameFragment = i.usernameFragment;
  }
  return candidate;
}

function validateDialOptions(opts?: DialOptions) {
  if (!opts) {
    return;
  }

  if (opts.accessToken && opts.accessToken.length > 0) {
    if (opts.authEntity) {
      throw new Error("cannot set authEntity with accessToken");
    }

    if (opts.credentials) {
      throw new Error("cannot set credentials with accessToken");
    }

    if (opts.externalAuthAddress) {
      throw new Error("cannot set externalAuthAddress with accessToken");
    }

    if (opts.externalAuthToEntity) {
      throw new Error("cannot set externalAuthToEntity with accessToken");
    }

    if (opts.webrtcOptions) {
      if (opts.webrtcOptions.signalingAccessToken) {
        throw new Error(
          "cannot set webrtcOptions.signalingAccessToken with accessToken"
        );
      }
      if (opts.webrtcOptions.signalingAuthEntity) {
        throw new Error(
          "cannot set webrtcOptions.signalingAuthEntity with accessToken"
        );
      }
      if (opts.webrtcOptions.signalingCredentials) {
        throw new Error(
          "cannot set webrtcOptions.signalingCredentials with accessToken"
        );
      }
      if (opts.webrtcOptions.signalingExternalAuthAddress) {
        throw new Error(
          "cannot set webrtcOptions.signalingExternalAuthAddress with accessToken"
        );
      }
      if (opts.webrtcOptions.signalingExternalAuthToEntity) {
        throw new Error(
          "cannot set webrtcOptions.signalingExternalAuthToEntity with accessToken"
        );
      }
    }
  }

  if (
    opts?.webrtcOptions?.signalingAccessToken &&
    opts.webrtcOptions.signalingAccessToken.length > 0
  ) {
    if (opts.webrtcOptions.signalingAuthEntity) {
      throw new Error(
        "cannot set webrtcOptions.signalingAuthEntity with webrtcOptions.signalingAccessToken"
      );
    }
    if (opts.webrtcOptions.signalingCredentials) {
      throw new Error(
        "cannot set webrtcOptions.signalingCredentials with webrtcOptions.signalingAccessToken"
      );
    }
  }
}
