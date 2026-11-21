package ai

import "strconv"

// Each root owns a monotonic suffix sequence. Splitting a revision consumes one
// suffix per resulting diff; revising a child continues the same root sequence.
// Callers enforce the total reference bound and validate lineage before mutation.
func (s *Session) allocateProposal(root int) string {
	if s.proposalIndex == nil {
		s.proposalIndex = make(map[string]int)
	}
	if root == 0 {
		s.nextProposal++
		root = s.nextProposal
		label := "@" + strconv.Itoa(root)
		s.proposalIndex[label] = len(s.proposals)
		s.proposals = append(s.proposals, proposalRecord{status: "pending", root: root})
		return label
	}
	base := "@" + strconv.Itoa(root)
	record := &s.proposals[s.proposalIndex[base]]
	record.lastRevision++
	label := base + "." + strconv.Itoa(record.lastRevision)
	s.proposalIndex[label] = len(s.proposals)
	s.proposals = append(s.proposals, proposalRecord{status: "pending", root: root})
	return label
}
