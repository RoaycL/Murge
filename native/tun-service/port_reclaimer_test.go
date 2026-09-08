package main

import (
	"errors"
	"reflect"
	"testing"
)

type scriptedListenerAdapter struct {
	inspections [][]listenerOwner
	terminated  []int
	err         error
}

func (adapter *scriptedListenerAdapter) Inspect(_ []int) ([]listenerOwner, error) {
	if len(adapter.inspections) == 0 {
		return nil, nil
	}
	result := adapter.inspections[0]
	adapter.inspections = adapter.inspections[1:]
	return result, nil
}

func (adapter *scriptedListenerAdapter) Terminate(pid int) error {
	adapter.terminated = append(adapter.terminated, pid)
	return adapter.err
}

func TestParseNetstatOwnersIncludesOnlyListenersAndUDP(t *testing.T) {
	owners := parseNetstatOwners("TCP 127.0.0.1:7890 0.0.0.0:0 LISTENING 1200\r\n"+
		"TCP 127.0.0.1:7891 1.1.1.1:443 ESTABLISHED 1300\r\n"+
		"UDP [::]:7892 *:* 1200\r\n", []int{7890, 7891, 7892})
	expected := []listenerOwner{{PID: 1200, Ports: []int{7890, 7892}}}
	if !reflect.DeepEqual(owners, expected) {
		t.Fatalf("unexpected owners: %+v", owners)
	}
}

func TestReclaimListenerPortsTerminatesOnlyListenerAndVerifiesRelease(t *testing.T) {
	adapter := &scriptedListenerAdapter{inspections: [][]listenerOwner{
		{{PID: 1200, Ports: []int{7890, 7892}}},
		{},
	}}
	if err := reclaimListenerPorts([]int{7890, 7892}, 99, adapter); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(adapter.terminated, []int{1200}) {
		t.Fatalf("unexpected terminated processes: %v", adapter.terminated)
	}
}

func TestReclaimListenerPortsReportsSurvivingElevatedOwner(t *testing.T) {
	owner := []listenerOwner{{PID: 1200, Ports: []int{7890}}}
	inspections := make([][]listenerOwner, 7)
	for index := range inspections {
		inspections[index] = owner
	}
	adapter := &scriptedListenerAdapter{inspections: inspections, err: errors.New("access denied")}
	if err := reclaimListenerPorts([]int{7890}, 99, adapter); err == nil {
		t.Fatal("expected surviving owner failure")
	}
}
