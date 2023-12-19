package rpc

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/edaniels/golog"
	"github.com/golang-jwt/jwt/v4"
	"github.com/pion/webrtc/v3"
	"go.uber.org/multierr"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

// DefaultWebRTCMaxGRPCCalls is the maximum number of concurrent gRPC calls to allow
// for a server.
var DefaultWebRTCMaxGRPCCalls = 256

// A webrtcServer translates gRPC frames over WebRTC data channels into gRPC calls.
type webrtcServer struct {
	mu       sync.Mutex
	ctx      context.Context
	cancel   context.CancelFunc
	handlers map[string]handlerFunc
	services map[string]*serviceInfo
	logger   golog.Logger

	peerConns               map[*webrtc.PeerConnection]struct{}
	activeBackgroundWorkers sync.WaitGroup
	callTickets             chan struct{}

	unaryInt          grpc.UnaryServerInterceptor
	streamInt         grpc.StreamServerInterceptor
	unknownStreamDesc *grpc.StreamDesc

	onPeerAdded   func(pc *webrtc.PeerConnection)
	onPeerRemoved func(pc *webrtc.PeerConnection)

	// exempt methods do not perform any auth
	exemptMethods map[string]bool
	// public methods attempt, but do not require, authentication
	publicMethods map[string]bool

	// auth

	internalUUID         string
	internalCreds        Credentials
	tlsAuthHandler       func(ctx context.Context, entities ...string) error
	authRSAPrivKey       *rsa.PrivateKey
	authRSAPrivKeyKID    string
	authHandlersForCreds map[CredentialsType]credAuthHandlers
	authToHandler        AuthenticateToHandler

	// authAudience is the JWT audience (aud) that will be used/expected
	// for our service.
	authAudience []string

	// authIssuer is the JWT issuer (iss) that will be used for our service.
	authIssuer string
}

// from grpc.
type serviceInfo struct {
	methods  map[string]*grpc.MethodDesc
	streams  map[string]*grpc.StreamDesc
	metadata interface{}
}

// newWebRTCServer makes a new server with no registered services.
func newWebRTCServer(logger golog.Logger) *webrtcServer {
	// TODO: add auth interceptors
	return newWebRTCServerWithInterceptors(logger, nil, nil)
}

func (srv *webrtcServer) isPublicMethod(
	fullMethod string,
) bool {
	return srv.publicMethods[fullMethod]
}

// tryAuth is called for public methods where auth is not required but preferable.
func (srv *webrtcServer) tryAuth(ctx context.Context) (context.Context, error) {
	nextCtx, err := srv.ensureAuthed(ctx)
	if err != nil {
		if status, _ := status.FromError(err); status.Code() != codes.Unauthenticated {
			return nil, err
		}
		return ctx, nil
	}
	return nextCtx, nil
}

func (srv *webrtcServer) authHandlers(forType CredentialsType) (credAuthHandlers, error) {
	handler, ok := srv.authHandlersForCreds[forType]
	if !ok {
		return credAuthHandlers{}, status.Errorf(codes.InvalidArgument, "do not know how to handle credential type %q", forType)
	}
	return handler, nil
}

func (srv *webrtcServer) ensureAuthed(ctx context.Context) (context.Context, error) {
	tokenString, err := tokenFromContext(ctx)
	if err != nil {
		// check TLS state
		if srv.tlsAuthHandler == nil {
			return nil, err
		}
		var verifiedCert *x509.Certificate
		if p, ok := peer.FromContext(ctx); ok && p.AuthInfo != nil {
			if authInfo, ok := p.AuthInfo.(credentials.TLSInfo); ok {
				verifiedChains := authInfo.State.VerifiedChains
				if len(verifiedChains) != 0 && len(verifiedChains[0]) != 0 {
					verifiedCert = verifiedChains[0][0]
				}
			}
		}
		if verifiedCert == nil {
			return nil, err
		}
		if tlsErr := srv.tlsAuthHandler(ctx, verifiedCert.DNSNames...); tlsErr == nil {
			// mTLS based authentication contexts do not really have a sense of a unique identifier
			// when considering multiple clients using the certificate. We deem this okay but it does
			// mean that if the identifier is used to bind to the concept of a unique session, it is
			// not sufficient without another piece of information (like an address and port).
			// Furthermore, if TLS certificate verification is disabled, this trust is lost.
			// Our best chance at uniqueness with a compliant CA is to use the issuer DN (Distinguished Name)
			// along with the serial number; compliancy hinges on issuing unique serial numbers and if this
			// is an intermediate CA, their parent issuing unique DNs.
			nextCtx := ContextWithAuthEntity(ctx, EntityInfo{
				Entity: verifiedCert.Issuer.String() + ":" + verifiedCert.SerialNumber.String(),
			})
			return nextCtx, nil
		} else if !errors.Is(tlsErr, errNotTLSAuthed) {
			return nil, multierr.Combine(err, tlsErr)
		}
		return nil, err
	}

	var claims JWTClaims
	var handlers credAuthHandlers
	if _, err := jwt.ParseWithClaims(
		tokenString,
		&claims,
		func(token *jwt.Token) (interface{}, error) {
			var err error
			handlers, err = srv.authHandlers(claims.CredentialsType())
			if err != nil {
				return nil, err
			}

			if handlers.TokenVerificationKeyProvider != nil {
				return handlers.TokenVerificationKeyProvider.TokenVerificationKey(ctx, token)
			}

			// signed internally
			if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
				return nil, fmt.Errorf("unexpected signing method %q", token.Method.Alg())
			}

			return &srv.authRSAPrivKey.PublicKey, nil
		},
		jwt.WithValidMethods(validSigningMethods),
	); err != nil {
		return nil, status.Errorf(codes.Unauthenticated, "unauthenticated: %s", err)
	}

	// Audience verification is critical for security. Without it, we have a higher chance
	// of validating a JWT is valid, but not that it is intended for us. Of course, that means
	// we trust whomever owns the private keys to signing access tokens.
	audVerified := false
	for _, allowdAud := range srv.authAudience {
		if claims.RegisteredClaims.VerifyAudience(allowdAud, true) {
			audVerified = true
			break
		}
	}
	if !audVerified {
		return nil, status.Error(codes.Unauthenticated, "invalid audience")
	}

	// Note(erd): may want to verify issuers in the future where the claims/scope are
	// treated differently if it comes down to permissions encoded in a JWT.

	err = claims.Valid()
	if err != nil {
		srv.logger.Info("invalid claims!!!")
		return nil, status.Errorf(codes.Unauthenticated, "unauthenticated: %s", err)
	}
	srv.logger.Info("claims are still valid")

	claimsEntity := claims.Entity()
	if claimsEntity == "" {
		return nil, status.Errorf(codes.Unauthenticated, "expected entity (sub) in claims")
	}

	var entityData interface{}
	if handlers.EntityDataLoader != nil {
		data, err := handlers.EntityDataLoader.EntityData(ctx, claims)
		if err != nil {
			if _, ok := status.FromError(err); ok {
				return nil, err
			}
			return nil, status.Errorf(codes.Internal, "failed to load entity data: %s", err)
		}
		entityData = data
	}

	return ContextWithAuthEntity(ctx, EntityInfo{claimsEntity, entityData}), nil
}

func (srv *webrtcServer) authUnaryInterceptor(
	ctx context.Context,
	req interface{},
	info *grpc.UnaryServerInfo,
	handler grpc.UnaryHandler,
) (interface{}, error) {
	// no auth
	if srv.exemptMethods[info.FullMethod] {
		return handler(ctx, req)
	}

	// optional auth
	if srv.isPublicMethod(info.FullMethod) {
		nextCtx, err := srv.tryAuth(ctx)
		if err != nil {
			return nil, err
		}
		return handler(nextCtx, req)
	}

	// private auth
	nextCtx, err := srv.ensureAuthed(ctx)
	if err != nil {
		return nil, err
	}

	return handler(nextCtx, req)
}

// newWebRTCServerWithInterceptors makes a new server with no registered services that will
// use the given interceptors.
func newWebRTCServerWithInterceptors(
	logger golog.Logger,
	unaryInt grpc.UnaryServerInterceptor,
	streamInt grpc.StreamServerInterceptor,
) *webrtcServer {
	return newWebRTCServerWithInterceptorsAndUnknownStreamHandler(logger, unaryInt, streamInt, nil)
}

// newWebRTCServerWithInterceptorsAndUnknownStreamHandler makes a new server with no registered services that will
// use the given interceptors and unknown stream handler.
func newWebRTCServerWithInterceptorsAndUnknownStreamHandler(
	logger golog.Logger,
	unaryInt grpc.UnaryServerInterceptor,
	streamInt grpc.StreamServerInterceptor,
	unknownStreamDesc *grpc.StreamDesc,
) *webrtcServer {
	srv := &webrtcServer{
		handlers:          map[string]handlerFunc{},
		services:          map[string]*serviceInfo{},
		logger:            logger,
		peerConns:         map[*webrtc.PeerConnection]struct{}{},
		callTickets:       make(chan struct{}, DefaultWebRTCMaxGRPCCalls),
		unaryInt:          unaryInt,
		streamInt:         streamInt,
		unknownStreamDesc: unknownStreamDesc,
	}
	srv.ctx, srv.cancel = context.WithCancel(context.Background())
	return srv
}

// Stop instructs the server and all handlers to stop. It returns when all handlers
// are done executing.
func (srv *webrtcServer) Stop() {
	srv.cancel()
	srv.logger.Info("waiting for handlers to complete")
	srv.activeBackgroundWorkers.Wait()
	srv.logger.Info("handlers complete")
	srv.mu.Lock()
	srv.logger.Info("closing lingering peer connections")
	for pc := range srv.peerConns {
		if err := pc.Close(); err != nil {
			srv.logger.Errorw("error closing peer connection", "error", err)
		}
	}
	srv.logger.Info("lingering peer connections closed")
	srv.mu.Unlock()
}

// RegisterService registers the given implementation of a service to be handled via
// WebRTC data channels. It extracts the unary and stream methods from a service description
// and calls the methods on the implementation when requested via a data channel.
func (srv *webrtcServer) RegisterService(sd *grpc.ServiceDesc, ss interface{}) {
	info := &serviceInfo{
		methods:  make(map[string]*grpc.MethodDesc, len(sd.Methods)),
		streams:  make(map[string]*grpc.StreamDesc, len(sd.Streams)),
		metadata: sd.Metadata,
	}
	for i := range sd.Methods {
		d := &sd.Methods[i]
		info.methods[d.MethodName] = d
	}
	for i := range sd.Streams {
		d := &sd.Streams[i]
		info.streams[d.StreamName] = d
	}

	for i := range sd.Methods {
		desc := &sd.Methods[i]
		info.methods[desc.MethodName] = desc
		path := fmt.Sprintf("/%v/%v", sd.ServiceName, desc.MethodName)
		srv.handlers[path] = srv.unaryHandler(ss, methodHandler(desc.Handler))
	}
	for i := range sd.Streams {
		desc := &sd.Streams[i]
		info.streams[desc.StreamName] = desc
		path := fmt.Sprintf("/%v/%v", sd.ServiceName, desc.StreamName)
		srv.handlers[path] = srv.streamHandler(ss, path, *desc)
	}

	srv.services[sd.ServiceName] = info
}

func (srv *webrtcServer) GetServiceInfo() map[string]grpc.ServiceInfo {
	info := make(map[string]grpc.ServiceInfo, len(srv.services))
	for name, svcInfo := range srv.services {
		methods := make([]grpc.MethodInfo, 0, len(svcInfo.methods)+len(svcInfo.streams))
		for m := range svcInfo.methods {
			methods = append(methods, grpc.MethodInfo{
				Name:           m,
				IsClientStream: false,
				IsServerStream: false,
			})
		}
		for m, d := range svcInfo.streams {
			methods = append(methods, grpc.MethodInfo{
				Name:           m,
				IsClientStream: d.ClientStreams,
				IsServerStream: d.ServerStreams,
			})
		}

		info[name] = grpc.ServiceInfo{
			Methods:  methods,
			Metadata: svcInfo.metadata,
		}
	}
	return info
}

func (srv *webrtcServer) handler(path string) (handlerFunc, bool) {
	h, ok := srv.handlers[path]
	return h, ok
}

// NewChannel binds the given data channel to be serviced as the server end of a gRPC
// connection.
func (srv *webrtcServer) NewChannel(
	peerConn *webrtc.PeerConnection,
	dataChannel *webrtc.DataChannel,
	authAudience []string,
) *webrtcServerChannel {
	serverCh := newWebRTCServerChannel(srv, peerConn, dataChannel, authAudience, srv.logger)
	srv.mu.Lock()
	srv.peerConns[peerConn] = struct{}{}
	srv.mu.Unlock()
	if srv.onPeerAdded != nil {
		srv.onPeerAdded(peerConn)
	}
	return serverCh
}

func (srv *webrtcServer) removePeer(peerConn *webrtc.PeerConnection) {
	srv.mu.Lock()
	defer srv.mu.Unlock()
	delete(srv.peerConns, peerConn)
	if srv.onPeerRemoved != nil {
		srv.onPeerRemoved(peerConn)
	}
	if err := peerConn.Close(); err != nil {
		srv.logger.Errorw("error closing peer connection on removal", "error", err)
	}
}

type (
	handlerFunc   func(s *webrtcServerStream) error
	methodHandler func(
		srv interface{},
		ctx context.Context,
		dec func(interface{}) error,
		interceptor grpc.UnaryServerInterceptor,
	) (interface{}, error)
)

func (srv *webrtcServer) unaryHandler(ss interface{}, handler methodHandler) handlerFunc {
	return func(s *webrtcServerStream) error {
		ctx := grpc.NewContextWithServerTransportStream(s.webrtcBaseStream.Context(), serverTransportStream{s})

		response, err := handler(ss, ctx, s.webrtcBaseStream.RecvMsg, srv.unaryInt)
		if err != nil {
			return s.closeWithSendError(err)
		}

		err = s.SendMsg(response)
		if err != nil {
			// `ServerStream.SendMsg` closes itself on error.
			return err
		}

		return s.closeWithSendError(nil)
	}
}

func (srv *webrtcServer) streamHandler(ss interface{}, method string, desc grpc.StreamDesc) handlerFunc {
	return func(s *webrtcServerStream) error {
		ctx := grpc.NewContextWithServerTransportStream(s.webrtcBaseStream.Context(), serverTransportStream{s})
		wrappedStream := ctxWrappedServerStream{s, ctx}

		var err error
		if srv.streamInt == nil {
			err = desc.Handler(ss, wrappedStream)
		} else {
			info := &grpc.StreamServerInfo{
				FullMethod:     method,
				IsClientStream: desc.ClientStreams,
				IsServerStream: desc.ServerStreams,
			}
			err = srv.streamInt(ss, wrappedStream, info, desc.Handler)
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		return s.closeWithSendError(err)
	}
}
