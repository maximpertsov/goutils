import { ClientChannel } from "./ClientChannel";
import { ConnectionClosedError } from "./errors";
import { Code } from "./gen/google/rpc/code_pb";
import { Status } from "./gen/google/rpc/status_pb";
import type {
  GrpcWebTransportOptions,
  StreamResponse,
  Transport,
  UnaryResponse,
} from "@bufbuild/connect-web";
import {
  createPromiseClient,
  createGrpcWebTransport,
  ConnectError,
} from "@bufbuild/connect-web";
import type {
  AnyMessage,
  Message,
  ServiceType,
  MethodInfo,
  PartialMessage,
} from "@bufbuild/protobuf";
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

type TransportFactory = (opts: GrpcWebTransportOptions) => Transport;

export async function dialDirect(
  address: string,
  opts?: DialOptions
): Promise<TransportFactory> {
  validateDialOptions(opts);

  const defaultFactory = (opts: GrpcWebTransportOptions): Transport => {
    return createGrpcWebTransport({ ...opts, credentials: "omit" });
  };

  // Client already has access token with no external auth, skip Authenticate process.
  if (
    opts?.accessToken &&
    !(opts?.externalAuthAddress && opts?.externalAuthToEntity)
  ) {
    const md = new Headers();
    md.set("authorization", `Bearer ${opts.accessToken}`);
    return (opts: GrpcWebTransportOptions): Transport => {
      return new AuthenticatedTransport(opts, defaultFactory, md);
    };
  }

  if (!opts || (!opts?.credentials && !opts?.accessToken)) {
    return defaultFactory;
  }

  return makeAuthenticatedTransportFactory(address, defaultFactory, opts);
}

async function makeAuthenticatedTransportFactory(
  address: string,
  defaultFactory: TransportFactory,
  opts: DialOptions
): Promise<TransportFactory> {
  let accessToken = "";
  const getExtraMetadata = async (): Promise<Headers> => {
    // TODO(GOUT-10): handle expiration
    if (accessToken == "") {
      let thisAccessToken = "";

      if (!opts.accessToken || opts.accessToken === "") {
        const request = new AuthenticateRequest();
        request.entity = opts.authEntity
          ? opts.authEntity
          : address.replace(/^(.*:\/\/)/, "");
        const creds = new PBCredentials();
        creds.type = opts.credentials?.type!;
        creds.payload = opts.credentials?.payload!;
        request.credentials = creds;

        const authClient = createPromiseClient(
          AuthService,
          defaultFactory({
            baseUrl: opts.externalAuthAddress
              ? opts.externalAuthAddress
              : address,
          })
        );

        const response = await authClient.authenticate(request);
        thisAccessToken = response.accessToken;
      } else {
        thisAccessToken = opts.accessToken;
      }

      accessToken = thisAccessToken;

      if (opts.externalAuthAddress && opts.externalAuthToEntity) {
        const headers = new Headers();
        headers.set("authorization", `Bearer ${accessToken}`);
        thisAccessToken = "";

        const authToRequest = new AuthenticateToRequest();
        authToRequest.entity = opts.externalAuthToEntity;

        const externalAuthClient = createPromiseClient(
          ExternalAuthService,
          defaultFactory({ baseUrl: opts.externalAuthAddress! })
        );
        const authToResponse = await externalAuthClient.authenticateTo(
          authToRequest,
          { headers }
        );
        thisAccessToken = authToResponse.accessToken;
        accessToken = thisAccessToken;
      }
    }
    const md = new Headers();
    md.set("authorization", `Bearer ${accessToken}`);
    return md;
  };
  const extraMd = await getExtraMetadata();
  return (opts: GrpcWebTransportOptions): Transport => {
    return new AuthenticatedTransport(opts, defaultFactory, extraMd);
  };
}

class AuthenticatedTransport implements Transport {
  protected readonly opts: GrpcWebTransportOptions;
  protected readonly transport: Transport;
  protected readonly extraMetadata: Headers;

  constructor(
    opts: GrpcWebTransportOptions,
    defaultFactory: TransportFactory,
    extraMetadata: Headers
  ) {
    this.opts = opts;
    this.transport = defaultFactory(opts);
    this.extraMetadata = extraMetadata;
  }

  public async unary<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    service: ServiceType,
    method: MethodInfo<I, O>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    header: Headers,
    message: PartialMessage<I>
  ): Promise<UnaryResponse<O>> {
    let headerWithExtra = new Headers(header);
    this.extraMetadata.forEach((value, key) => {
      headerWithExtra.set(key, value);
    });
    return this.transport.unary(
      service,
      method,
      signal,
      timeoutMs,
      headerWithExtra,
      message
    );
  }

  public async serverStream<
    I extends Message<I> = AnyMessage,
    O extends Message<O> = AnyMessage
  >(
    service: ServiceType,
    method: MethodInfo<I, O>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    header: Headers,
    message: PartialMessage<I>
  ): Promise<StreamResponse<O>> {
    let headerWithExtra = new Headers(header);
    this.extraMetadata.forEach((value, key) => {
      headerWithExtra.set(key, value);
    });
    return this.transport.serverStream(
      service,
      method,
      signal,
      timeoutMs,
      headerWithExtra,
      message
    );
  }
}

interface WebRTCConnection {
  transportFactory: TransportFactory;
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
        optsCopy.accessToken = opts?.webrtcOptions?.signalingAccessToken;
      }

      optsCopy.externalAuthAddress =
        opts?.webrtcOptions?.signalingExternalAuthAddress;
      optsCopy.externalAuthToEntity =
        opts?.webrtcOptions?.signalingExternalAuthToEntity;
    }

    const directTransport = await dialDirect(signalingAddress, optsCopy);
    const signalingClient = createPromiseClient(
      SignalingService,
      directTransport({
        baseUrl: signalingAddress,
      })
    );

    let uuid = "";
    // only send once since exchange may end or ICE may end
    let sentDoneOrErrorOnce = false;
    const sendError = async (err: string) => {
      if (sentDoneOrErrorOnce) {
        return;
      }
      sentDoneOrErrorOnce = true;
      const callRequestUpdate = new CallUpdateRequest({
        uuid,
        update: {
          case: "error",
          value: new Status({ code: Code.UNKNOWN, message: err }),
        },
      });

      try {
        await signalingClient.callUpdate(callRequestUpdate, {
          headers: {
            "rpc-host": host,
          },
        });
      } catch (err) {
        if (err instanceof ConnectError) {
          console.error(err.message);
        } else {
          throw err;
        }
      }
    };

    const sendDone = async () => {
      if (sentDoneOrErrorOnce) {
        return;
      }
      sentDoneOrErrorOnce = true;
      const callRequestUpdate = new CallUpdateRequest({
        uuid,
        update: { case: "done", value: true },
      });
      try {
        await signalingClient.callUpdate(callRequestUpdate, {
          headers: {
            "rpc-host": host,
          },
        });
      } catch (err) {
        if (err instanceof ConnectError) {
          console.error(err.message);
        } else {
          throw err;
        }
      }
    };

    // let pResolve: (value: unknown) => void;
    let remoteDescSet = new Promise<unknown>((_resolve) => {
      // pResolve = resolve;
    });
    let exchangeDone = false;
    if (!webrtcOpts?.disableTrickleICE) {
      // set up offer
      const offerDesc = await pc.createOffer();

      let iceComplete = false;
      pc.onicecandidate = async (event) => {
        await remoteDescSet;
        if (exchangeDone) {
          return;
        }

        if (event.candidate === null) {
          iceComplete = true;
          await sendDone();
          return;
        }

        const iProto = iceCandidateToProto(event.candidate);
        const callRequestUpdate = new CallUpdateRequest({
          uuid,
          update: { case: "candidate", value: iProto },
        });

        try {
          await signalingClient.callUpdate(callRequestUpdate, {
            headers: { "rpc-host": host },
          });
          if (exchangeDone || iceComplete) {
            return;
          }
          // TODO: status message?
          console.error("error sending candidate");
        } catch (err) {
          if (err instanceof ConnectError) {
            console.error(err.message);
          } else {
            throw err;
          }
        }
      };

      await pc.setLocalDescription(offerDesc);
    }

    const cc = new ClientChannel(pc, dc);
    await cc.ready;

    let haveInit = false;
    const callRequest = new CallRequest({
      sdp: btoa(JSON.stringify(pc.localDescription)),
      disableTrickle: webrtcOpts?.disableTrickleICE,
    });
    try {
      for await (const response of signalingClient.call(callRequest, {
        headers: { "rpc-host": host },
      })) {
        switch (response.stage.case) {
          case "init":
            if (haveInit) {
              sendError("got init stage more than once");
              break;
            }
            haveInit = true;
            uuid = response.uuid;

            const remoteSDP = new RTCSessionDescription(
              JSON.parse(atob(response.stage.value.sdp))
            );
            pc.setRemoteDescription(remoteSDP);

            // TODO: what's this for?
            // pResolve(true);

            if (webrtcOpts?.disableTrickleICE) {
              exchangeDone = true;
              await sendDone();
            }
            break;
          case "update":
            if (!haveInit) {
              sendError("got update stage before init stage");
              break;
            }
            if (response.uuid !== uuid) {
              sendError(`uuid mismatch; have=${response.uuid} want=${uuid}`);
              break;
            }

            const update = response.stage.value;
            const cand = iceCandidateFromProto(update.candidate!);
            try {
              await pc.addIceCandidate(cand);
            } catch (error) {
              sendError(JSON.stringify(error));
            }
            break;
        }
      }
    } catch (err) {
      if (err instanceof ConnectError) {
        if (err.message === "Response closed without headers") {
          throw new ConnectionClosedError("failed to dial");
        } else {
          console.error(err.message);
        }
      } else {
        throw err;
      }
    }

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
  candidate.sdpMid = i.sdpMid ?? null;
  candidate.sdpMLineIndex = i.sdpmLineIndex ?? null;
  candidate.usernameFragment = i.usernameFragment ?? null;
  return candidate;
}

function iceCandidateToProto(i: RTCIceCandidateInit): ICECandidate {
  let candidate = new ICECandidate();
  candidate.candidate = i.candidate!;
  candidate.sdpMid = i.sdpMid ?? undefined;
  candidate.sdpmLineIndex = i.sdpMLineIndex ?? undefined;
  candidate.usernameFragment = i.usernameFragment ?? undefined;
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
