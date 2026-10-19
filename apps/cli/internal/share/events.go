package share

import "slices"

// Event contains only operational metadata, never credentials or user content.
type Event struct {
	Event    string `json:"event"`
	Resource string `json:"resource,omitempty"`
	Code     string `json:"code,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"`
}

func (h *Host) Events() <-chan Event { return h.events }
func (h *Host) emit(event Event) {
	select {
	case h.events <- event:
	default:
	}
}

type MemberSummary struct {
	Slot                            int
	Approved, Connected, Controller bool
}

func (h *Host) Members() []MemberSummary {
	h.mu.Lock()
	defer h.mu.Unlock()
	result := make([]MemberSummary, 0, len(h.members))
	for _, m := range h.members {
		result = append(result, MemberSummary{m.slot, m.approved, m.control != nil, h.controller == m.id})
	}
	slices.SortFunc(result, func(a, b MemberSummary) int { return a.Slot - b.Slot })
	return result
}

func (h *Host) ApproveMember(slot int) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, m := range h.members {
		if m.slot == slot && !m.approved && h.liveLocked() {
			m.approved = true
			if h.controller == "" && h.remoteAllowed && !h.options.ReadOnly {
				h.controller = m.id
			}
			close(m.approval)
			return true
		}
	}
	return false
}

func (h *Host) GrantMember(slot int) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.options.ReadOnly || !h.liveLocked() {
		return false
	}
	for _, m := range h.members {
		if m.slot == slot && m.approved && m.control != nil {
			h.remoteAllowed = true
			h.controller = m.id
			return true
		}
	}
	return false
}

func (h *Host) RevokeMember(slot int) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, m := range h.members {
		if m.slot == slot {
			h.removeMemberLocked(id)
			return true
		}
	}
	return false
}
