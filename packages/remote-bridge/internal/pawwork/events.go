package pawwork

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"

	"github.com/astro-han/pawwork/packages/remote-bridge/internal/bridge"
)

type EventHandler interface {
	HandleAssistantText(context.Context, string, string) error
	HandlePermission(context.Context, bridge.PendingPermission) error
	HandlePermissionResolved(context.Context, bridge.PermissionResolution) error
	HandleQuestion(context.Context, bridge.PendingQuestion) error
	HandleQuestionResolved(context.Context, bridge.QuestionResolution) error
	HandleSession(context.Context, bridge.Session) error
}

type ReplayRefreshHandler interface {
	HandleReplayRefresh(context.Context) error
}

type StreamReadyHandler interface {
	HandleStreamReady(context.Context) error
}

type clientEventHandler struct {
	client       *Client
	next         EventHandler
	reconnecting bool
}

func (h clientEventHandler) HandleAssistantText(ctx context.Context, sessionID string, text string) error {
	return h.next.HandleAssistantText(ctx, sessionID, text)
}

func (h clientEventHandler) HandlePermission(ctx context.Context, permission bridge.PendingPermission) error {
	h.client.rememberSession(bridge.Session{ID: permission.SessionID, Directory: permission.Directory})
	return h.next.HandlePermission(ctx, permission)
}

func (h clientEventHandler) HandlePermissionResolved(ctx context.Context, resolution bridge.PermissionResolution) error {
	h.client.rememberSession(bridge.Session{ID: resolution.SessionID, Directory: resolution.Directory})
	return h.next.HandlePermissionResolved(ctx, resolution)
}

func (h clientEventHandler) HandleQuestion(ctx context.Context, question bridge.PendingQuestion) error {
	h.client.rememberSession(bridge.Session{ID: question.SessionID, Directory: question.Directory})
	return h.next.HandleQuestion(ctx, question)
}

func (h clientEventHandler) HandleQuestionResolved(ctx context.Context, resolution bridge.QuestionResolution) error {
	h.client.rememberSession(bridge.Session{ID: resolution.SessionID, Directory: resolution.Directory})
	return h.next.HandleQuestionResolved(ctx, resolution)
}

func (h clientEventHandler) HandleSession(ctx context.Context, session bridge.Session) error {
	h.client.rememberSession(session)
	return h.next.HandleSession(ctx, session)
}

func (h clientEventHandler) HandleReplayRefresh(ctx context.Context) error {
	if !h.reconnecting {
		return nil
	}
	next, ok := h.next.(ReplayRefreshHandler)
	if !ok {
		return nil
	}
	if err := next.HandleReplayRefresh(ctx); err != nil {
		return replayRefreshError{err: err}
	}
	return nil
}

type replayRefreshError struct {
	err error
}

func (e replayRefreshError) Error() string { return e.err.Error() }
func (e replayRefreshError) Unwrap() error { return e.err }

func (c *Client) StreamEvents(ctx context.Context, handler EventHandler) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/global/event", nil)
	if err != nil {
		return err
	}
	req.Header.Set("accept", "text/event-stream")
	lastEventID := c.lastEventIDValue()
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	c.authorize(req)
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return &HTTPStatusError{
			Method:     http.MethodGet,
			Path:       "/global/event",
			Status:     res.Status,
			StatusCode: res.StatusCode,
			Body:       strings.TrimSpace(string(data)),
		}
	}
	mediaType, _, err := mime.ParseMediaType(res.Header.Get("content-type"))
	if err != nil || !strings.EqualFold(mediaType, "text/event-stream") {
		return fmt.Errorf("GET /global/event failed: expected text/event-stream, got %q", res.Header.Get("content-type"))
	}
	if ready, ok := handler.(StreamReadyHandler); ok {
		if err := ready.HandleStreamReady(ctx); err != nil {
			return err
		}
	}
	return parseSSE(ctx, res.Body, clientEventHandler{client: c, next: handler, reconnecting: lastEventID != ""}, c.setLastEventID)
}

func DispatchEvent(ctx context.Context, data []byte, handler EventHandler) error {
	var envelope struct {
		Directory string `json:"directory"`
		Payload   struct {
			Type       string          `json:"type"`
			Properties json.RawMessage `json:"properties"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return err
	}
	switch envelope.Payload.Type {
	case "server.connected":
		refresh, ok := handler.(ReplayRefreshHandler)
		if !ok {
			return nil
		}
		return refresh.HandleReplayRefresh(ctx)
	case "message.part.delta":
		return nil
	case "permission.asked":
		var permission bridge.PendingPermission
		if err := json.Unmarshal(envelope.Payload.Properties, &permission); err != nil {
			return err
		}
		if permission.ID == "" || permission.SessionID == "" {
			return nil
		}
		permission.Directory = envelope.Directory
		return handler.HandlePermission(ctx, permission)
	case "permission.replied":
		resolution, ok, err := permissionResolutionFromEvent(envelope.Payload.Properties)
		if err != nil || !ok {
			return err
		}
		if resolution.Directory == "" {
			resolution.Directory = envelope.Directory
		}
		return handler.HandlePermissionResolved(ctx, resolution)
	case "session.created":
		session, ok, err := sessionFromEvent(envelope.Payload.Properties, envelope.Directory)
		if err != nil || !ok {
			return err
		}
		return handler.HandleSession(ctx, session)
	case "message.part.updated":
		question, questionPending, resolution, questionResolved, err := questionUpdateFromEvent(envelope.Payload.Properties, envelope.Directory)
		if err != nil {
			return err
		}
		if questionPending {
			return handler.HandleQuestion(ctx, question)
		}
		if questionResolved {
			return handler.HandleQuestionResolved(ctx, resolution)
		}
		text, ok, err := assistantTextFromEvent(envelope.Payload.Properties)
		if err != nil || !ok {
			return err
		}
		return handler.HandleAssistantText(ctx, text.sessionID, text.text)
	default:
		return nil
	}
}

func parseSSE(ctx context.Context, reader io.Reader, handler EventHandler, setLastEventID func(string) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var data strings.Builder
	var eventID string
	flush := func() error {
		if data.Len() > 0 {
			if err := DispatchEvent(ctx, []byte(data.String()), handler); err != nil {
				var refresh replayRefreshError
				if errors.As(err, &refresh) {
					return err
				}
				slog.Warn("remote bridge ignored event", "error", err)
			}
			data.Reset()
		}
		if eventID != "" {
			if err := setLastEventID(eventID); err != nil {
				return err
			}
			eventID = ""
		}
		return nil
	}
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := scanner.Text()
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, "id:") {
			value := strings.TrimPrefix(line, "id:")
			eventID = strings.TrimSpace(value)
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		if data.Len() > 0 {
			data.WriteByte('\n')
		}
		value := strings.TrimPrefix(line, "data:")
		data.WriteString(strings.TrimPrefix(value, " "))
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}

type assistantText struct {
	sessionID string
	text      string
}

func assistantTextFromEvent(data json.RawMessage) (assistantText, bool, error) {
	var props struct {
		Part struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionID"`
			Text      string `json:"text"`
			Ignored   bool   `json:"ignored"`
			Time      struct {
				End *float64 `json:"end"`
			} `json:"time"`
		} `json:"part"`
	}
	if err := json.Unmarshal(data, &props); err != nil {
		return assistantText{}, false, err
	}
	part := props.Part
	if part.Type != "text" || part.Ignored || part.Time.End == nil || part.SessionID == "" || part.Text == "" {
		return assistantText{}, false, nil
	}
	return assistantText{sessionID: part.SessionID, text: part.Text}, true, nil
}

func permissionResolutionFromEvent(data json.RawMessage) (bridge.PermissionResolution, bool, error) {
	var resolution bridge.PermissionResolution
	if err := json.Unmarshal(data, &resolution); err != nil {
		return bridge.PermissionResolution{}, false, err
	}
	if resolution.SessionID == "" && resolution.RequestID == "" {
		return bridge.PermissionResolution{}, false, nil
	}
	return resolution, true, nil
}

func sessionFromEvent(data json.RawMessage, directory string) (bridge.Session, bool, error) {
	var props struct {
		Info struct {
			ID        string `json:"id"`
			Title     string `json:"title"`
			ParentID  string `json:"parentID"`
			Directory string `json:"directory"`
		} `json:"info"`
	}
	if err := json.Unmarshal(data, &props); err != nil {
		return bridge.Session{}, false, err
	}
	if props.Info.ID == "" {
		return bridge.Session{}, false, nil
	}
	if props.Info.Directory != "" {
		directory = props.Info.Directory
	}
	return bridge.Session{ID: props.Info.ID, Title: props.Info.Title, ParentID: props.Info.ParentID, Directory: directory}, true, nil
}

func questionUpdateFromEvent(data json.RawMessage, directory string) (
	bridge.PendingQuestion,
	bool,
	bridge.QuestionResolution,
	bool,
	error,
) {
	var props struct {
		Part struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionID"`
			MessageID string `json:"messageID"`
			CallID    string `json:"callID"`
			Tool      string `json:"tool"`
			State     struct {
				Status   string `json:"status"`
				Metadata struct {
					ExternalResultReady bool `json:"externalResultReady"`
				} `json:"metadata"`
				Input struct {
					Questions []bridge.Question `json:"questions"`
				} `json:"input"`
			} `json:"state"`
		} `json:"part"`
	}
	if err := json.Unmarshal(data, &props); err != nil {
		return bridge.PendingQuestion{}, false, bridge.QuestionResolution{}, false, err
	}
	part := props.Part
	if part.Type != "tool" || part.Tool != "question" {
		return bridge.PendingQuestion{}, false, bridge.QuestionResolution{}, false, nil
	}
	if part.SessionID == "" || part.MessageID == "" || part.CallID == "" {
		return bridge.PendingQuestion{}, false, bridge.QuestionResolution{}, false, nil
	}
	resolution := bridge.QuestionResolution{
		SessionID: part.SessionID,
		MessageID: part.MessageID,
		CallID:    part.CallID,
		Directory: directory,
	}
	if part.State.Status != "running" {
		if part.State.Status == "" || part.State.Status == "pending" {
			return bridge.PendingQuestion{}, false, bridge.QuestionResolution{}, false, nil
		}
		return bridge.PendingQuestion{}, false, resolution, true, nil
	}
	if !part.State.Metadata.ExternalResultReady {
		return bridge.PendingQuestion{}, false, bridge.QuestionResolution{}, false, nil
	}
	return bridge.PendingQuestion{
		SessionID: part.SessionID,
		MessageID: part.MessageID,
		CallID:    part.CallID,
		Questions: part.State.Input.Questions,
		Directory: directory,
	}, true, bridge.QuestionResolution{}, false, nil
}

func (c *Client) lastEventIDValue() string {
	c.mu.Lock()
	lastEventID := c.lastEventID
	store := c.eventCursorStore
	c.mu.Unlock()
	if lastEventID != "" {
		return lastEventID
	}
	if store == nil {
		return ""
	}
	return store.EventCursor()
}

func (c *Client) setLastEventID(id string) error {
	if id == "" {
		return nil
	}
	c.mu.Lock()
	store := c.eventCursorStore
	c.mu.Unlock()
	if store != nil {
		if err := store.SetEventCursor(id); err != nil {
			return err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastEventID = id
	return nil
}
