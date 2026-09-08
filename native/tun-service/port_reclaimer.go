package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type listenerOwner struct {
	PID   int
	Ports []int
}

type listenerProcessAdapter interface {
	Inspect([]int) ([]listenerOwner, error)
	Terminate(int) error
}

func reclaimListenerPorts(ports []int, ownPID int, adapter listenerProcessAdapter) error {
	requested := uniqueListenerPorts(ports)
	if len(requested) == 0 {
		return nil
	}
	var lastTerminationError error
	for attempt := 0; attempt < 6; attempt++ {
		owners, err := adapter.Inspect(requested)
		if err != nil {
			return fmt.Errorf("inspect listener ports: %w", err)
		}
		remaining := make([]listenerOwner, 0, len(owners))
		for _, owner := range owners {
			if owner.PID != ownPID {
				remaining = append(remaining, owner)
			}
		}
		if len(remaining) == 0 {
			return nil
		}
		seen := make(map[int]bool)
		for _, owner := range remaining {
			if seen[owner.PID] {
				continue
			}
			seen[owner.PID] = true
			if err := adapter.Terminate(owner.PID); err != nil {
				lastTerminationError = err
			}
		}
		if attempt < 5 {
			time.Sleep(75 * time.Millisecond)
		}
	}
	owners, err := adapter.Inspect(requested)
	if err != nil {
		return fmt.Errorf("verify listener ports: %w", err)
	}
	var blockedPorts []string
	var blockedPIDs []string
	for _, owner := range owners {
		if owner.PID == ownPID {
			continue
		}
		blockedPIDs = append(blockedPIDs, strconv.Itoa(owner.PID))
		for _, port := range owner.Ports {
			blockedPorts = append(blockedPorts, strconv.Itoa(port))
		}
	}
	if len(blockedPIDs) == 0 {
		return nil
	}
	detail := ""
	if lastTerminationError != nil {
		detail = ": " + lastTerminationError.Error()
	}
	return fmt.Errorf("listener ports %s remain owned by process %s%s",
		strings.Join(uniqueStrings(blockedPorts), ","), strings.Join(uniqueStrings(blockedPIDs), ","), detail)
}

func uniqueListenerPorts(ports []int) []int {
	seen := make(map[int]bool)
	result := make([]int, 0, len(ports))
	for _, port := range ports {
		if port >= 1024 && port <= 65535 && !seen[port] {
			seen[port] = true
			result = append(result, port)
		}
	}
	return result
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func parseNetstatOwners(text string, ports []int) []listenerOwner {
	requested := make(map[int]bool)
	for _, port := range ports {
		requested[port] = true
	}
	grouped := make(map[int][]int)
	order := make([]int, 0)
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		protocol := strings.ToUpper(fields[0])
		if protocol != "TCP" && protocol != "UDP" {
			continue
		}
		if protocol == "TCP" && !strings.EqualFold(fields[len(fields)-2], "LISTENING") {
			continue
		}
		separator := strings.LastIndex(fields[1], ":")
		if separator < 0 {
			continue
		}
		port, portErr := strconv.Atoi(fields[1][separator+1:])
		pid, pidErr := strconv.Atoi(fields[len(fields)-1])
		if portErr != nil || pidErr != nil || pid <= 0 || !requested[port] {
			continue
		}
		if _, exists := grouped[pid]; !exists {
			order = append(order, pid)
		}
		already := false
		for _, existing := range grouped[pid] {
			already = already || existing == port
		}
		if !already {
			grouped[pid] = append(grouped[pid], port)
		}
	}
	result := make([]listenerOwner, 0, len(order))
	for _, pid := range order {
		result = append(result, listenerOwner{PID: pid, Ports: grouped[pid]})
	}
	return result
}
