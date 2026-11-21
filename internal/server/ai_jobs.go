package server

import (
	"context"
	"errors"
	"time"

	"vylk/internal/ai"
	"vylk/internal/store"
)

func (a *app) aiSectionCall(ctx context.Context, c ai.Configuration, messages []ai.Message, noteID, sessionID, turnID string) (ai.Reply, error) {
	return a.aiRecordedCall(ctx, c, messages, noteID, sessionID, turnID, "section")
}

func (a *app) aiRecordedCall(ctx context.Context, c ai.Configuration, messages []ai.Message, noteID, sessionID, turnID, kind string) (ai.Reply, error) {
	if err := ctx.Err(); err != nil {
		return ai.Reply{}, aiCallError(ctx, err)
	}
	m, err := a.aiManager()
	if err != nil {
		return ai.Reply{}, err
	}
	usageID := ai.ID()
	if err := store.StartAIUsage(a.db, usageID, c, noteID, sessionID, turnID, kind); err != nil {
		return ai.Reply{}, errors.New("could not record usage; no request was sent")
	}
	started := time.Now()
	reply, _, usage, err := m.Provider.Complete(ctx, c, messages, 0)
	err = aiCallError(ctx, err)
	finish := func(result error) error {
		if accountingErr := store.FinishAIUsage(a.db, usageID, aiCallOutcome(aiCallError(ctx, result)), time.Since(started), usage); accountingErr != nil {
			return errors.New("could not finish usage accounting")
		}
		return nil
	}
	if err != nil {
		if accountingErr := finish(err); accountingErr != nil {
			return ai.Reply{}, accountingErr
		}
		return reply, err
	}
	return reply.WithUsageFinalizer(finish), nil
}
