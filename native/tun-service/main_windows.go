//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

type windowsService struct {
	config    serviceConfig
	manager   *sessionManager
	listener  net.Listener
	closeOnce sync.Once
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		panic(err)
	}
	bootstrapDirectory := filepath.Dir(executable)
	if len(os.Args) == 2 && (os.Args[1] == "--install" || os.Args[1] == "--uninstall") {
		if err := runInstallerCommand(os.Args[1], bootstrapDirectory); err != nil {
			panic(err)
		}
		return
	}
	configPath := filepath.Join(bootstrapDirectory, "service-config.json")
	config, err := loadServiceConfig(configPath)
	if err != nil {
		panic(err)
	}
	isService, err := svc.IsWindowsService()
	if err != nil {
		panic(err)
	}
	service := &windowsService{config: config}
	if isService {
		if err := svc.Run(config.ServiceName, service); err != nil {
			panic(err)
		}
		return
	}
	if len(os.Args) != 2 || os.Args[1] != "--console" {
		panic("refusing interactive execution without --console")
	}
	if err := service.runConsole(); err != nil {
		panic(err)
	}
}

func (service *windowsService) initialize() error {
	clientDigest, err := hashFile(service.config.AllowedClientPath)
	if err != nil || clientDigest != service.config.AllowedClientSHA256 {
		return errors.New("installed GUI integrity check failed")
	}
	runtime, err := newWindowsRuntime(service.config)
	if err != nil {
		return err
	}
	service.manager = newSessionManager(runtime, ownershipStoreFor(service.config.StateDirectory))
	service.manager.Handle(serviceRequest{ProtocolVersion: 2, RequestID: "1", Operation: "reconcile"})
	pipePath := `\\.\pipe\` + service.config.PipeName
	listener, err := winio.ListenPipe(pipePath, &winio.PipeConfig{
		SecurityDescriptor: fmt.Sprintf("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;%s)", service.config.AllowedSID),
		MessageMode:        false,
		InputBufferSize:    maxProfileBytes + 4096,
		OutputBufferSize:   4096,
	})
	if err != nil {
		return err
	}
	service.listener = listener
	return nil
}

func (service *windowsService) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	if err := service.initialize(); err != nil {
		return true, 1
	}
	go service.serve()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for request := range requests {
		switch request.Cmd {
		case svc.Interrogate:
			status <- request.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			service.shutdown()
			status <- svc.Status{State: svc.Stopped}
			return false, 0
		}
	}
	service.shutdown()
	return false, 0
}

func (service *windowsService) runConsole() error {
	if err := service.initialize(); err != nil {
		return err
	}
	defer service.shutdown()
	service.serve()
	return nil
}

func (service *windowsService) serve() {
	for {
		connection, err := service.listener.Accept()
		if err != nil {
			return
		}
		go service.handleConnection(connection)
	}
}

func (service *windowsService) handleConnection(connection net.Conn) {
	defer connection.Close()
	if err := service.verifyClient(connection); err != nil {
		return
	}
	reader := bufio.NewReaderSize(io.LimitReader(connection, maxProfileBytes+4097), maxProfileBytes+4097)
	data, err := reader.ReadBytes('\n')
	if err != nil || len(data) == 0 || len(data) > maxProfileBytes+4096 {
		return
	}
	request, err := decodeRequest(data[:len(data)-1])
	if err != nil {
		return
	}
	response := service.manager.Handle(request)
	encoder := json.NewEncoder(connection)
	_ = encoder.Encode(response)
}

// clientIdentityCache pins the verified digest of the allowed client to the
// exact file identity it was computed from. Re-hashing a ~150MB Electron
// executable on EVERY pipe request (including the 5s liveness reconcile while
// TUN is active) would burn sustained disk reads for no security gain: the
// client executable lives in an administrator-owned install directory, and a
// replaced file necessarily changes size and/or modification time, which
// invalidates the cache and forces a fresh hash+compare on the next request.
var clientIdentityCache struct {
	sync.Mutex
	known *clientIdentity
}

type clientIdentity struct {
	size    int64
	modTime time.Time
}

// verifyAllowedClientDigest re-verifies the pinned client digest unless the
// executable's file identity is unchanged since the last verified hash. A
// digest mismatch or an unreadable file is always a rejection (fail closed);
// only the steady-state re-hash is skipped.
func verifyAllowedClientDigest(config serviceConfig) error {
	info, err := os.Stat(config.AllowedClientPath)
	if err != nil {
		return fmt.Errorf("pipe client executable unreadable: %w", err)
	}
	clientIdentityCache.Lock()
	defer clientIdentityCache.Unlock()
	if cache := clientIdentityCache.known; cache != nil && cache.size == info.Size() && cache.modTime.Equal(info.ModTime()) {
		return nil
	}
	digest, err := hashFile(config.AllowedClientPath)
	if err != nil {
		return fmt.Errorf("pipe client executable unreadable: %w", err)
	}
	if digest != config.AllowedClientSHA256 {
		return errors.New("pipe client executable digest mismatch")
	}
	clientIdentityCache.known = &clientIdentity{size: info.Size(), modTime: info.ModTime()}
	return nil
}

// verifyClient authenticates the pipe client on EVERY connection: the client
// process image must match the pinned AllowedClientPath AND its digest must
// still equal the pinned AllowedClientSHA256 (verified per file identity — see
// verifyAllowedClientDigest). The initialize-time digest check alone would
// leave a window where an updated/tampered GUI binary could connect (or a
// stale binary be trusted after the file was replaced); checking at use time
// keeps the pinned identity true at the moment of use, matching the threat
// model's C3 control (path + digest on every call).
func (service *windowsService) verifyClient(connection net.Conn) error {
	fdConnection, ok := connection.(interface{ Fd() uintptr })
	if !ok {
		return errors.New("pipe handle is unavailable")
	}
	var pid uint32
	if err := windows.GetNamedPipeClientProcessId(windows.Handle(fdConnection.Fd()), &pid); err != nil {
		return err
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return err
	}
	observed := windows.UTF16ToString(buffer[:size])
	if !strings.EqualFold(filepath.Clean(observed), filepath.Clean(service.config.AllowedClientPath)) {
		return errors.New("pipe client executable mismatch")
	}
	return verifyAllowedClientDigest(service.config)
}

func (service *windowsService) shutdown() {
	service.closeOnce.Do(func() {
		if service.listener != nil {
			_ = service.listener.Close()
		}
		if service.manager == nil {
			return
		}
		status := service.manager.Handle(serviceRequest{ProtocolVersion: protocolVersion, RequestID: "18446744073709551614", Operation: "status"})
		if status.SessionID != nil {
			service.manager.Handle(serviceRequest{
				ProtocolVersion: protocolVersion,
				RequestID:       "18446744073709551615",
				Operation:       "stop",
				SessionID:       *status.SessionID,
			})
		}
	})
}

var _ svc.Handler = (*windowsService)(nil)
