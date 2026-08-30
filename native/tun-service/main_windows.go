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
	return nil
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
