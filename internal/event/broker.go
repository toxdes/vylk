// Package event provides bounded, best-effort change notifications. Durable
// synchronization remains authoritative, so slow subscribers may miss hints.
package event

import "sync"

type Change struct {
	Type     string `json:"type"`
	Sequence int64  `json:"sequence,omitempty"`
	Revision int64  `json:"revision,omitempty"`
}

type Broker struct {
	mu          sync.Mutex
	subscribers map[chan Change]struct{}
}

func NewBroker() *Broker {
	return &Broker{subscribers: make(map[chan Change]struct{})}
}

func (b *Broker) Subscribe() chan Change {
	ch := make(chan Change, 4)
	b.mu.Lock()
	b.subscribers[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *Broker) Unsubscribe(ch chan Change) {
	b.mu.Lock()
	delete(b.subscribers, ch)
	b.mu.Unlock()
}

func (b *Broker) Publish(change Change) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subscribers {
		pending := make([]Change, 0, cap(ch))
		for {
			select {
			case existing := <-ch:
				pending = append(pending, existing)
			default:
				goto drained
			}
		}
	drained:
		replaced := false
		for i := range pending {
			if pending[i].Type == change.Type {
				pending[i] = change
				replaced = true
				break
			}
		}
		if !replaced {
			pending = append(pending, change)
		}
		for _, next := range pending {
			select {
			case ch <- next:
			default:
			}
		}
	}
}
