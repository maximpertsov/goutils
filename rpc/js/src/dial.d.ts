import type { GrpcWebTransportOptions, Transport } from "@bufbuild/connect-web";
export interface DialOptions {
    authEntity?: string;
    credentials?: Credentials;
    webrtcOptions?: DialWebRTCOptions;
    externalAuthAddress?: string;
    externalAuthToEntity?: string;
    accessToken?: string;
}
export interface DialWebRTCOptions {
    disableTrickleICE: boolean;
    rtcConfig?: RTCConfiguration;
    signalingAuthEntity?: string;
    signalingExternalAuthAddress?: string;
    signalingExternalAuthToEntity?: string;
    signalingCredentials?: Credentials;
    signalingAccessToken?: string;
}
export interface Credentials {
    type: string;
    payload: string;
}
declare type TransportFactory = (opts: GrpcWebTransportOptions) => Transport;
export declare function dialDirect(address: string, opts?: DialOptions): Promise<TransportFactory>;
export {};
