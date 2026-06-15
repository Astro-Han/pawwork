package pawwork

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/astro-han/pawwork/packages/remote-bridge/internal/bridge"
)

type fakeEventHandler struct {
	texts               []eventText
	textErr             error
	refreshes           int
	refreshErr          error
	permissions         []bridge.PendingPermission
	resolvedPermissions []bridge.PermissionResolution
	questions           []bridge.PendingQuestion
	resolvedQuestions   []bridge.QuestionResolution
	sessions            []bridge.Session
}

type streamReadyEventHandler struct {
	fakeEventHandler
	ready int
}

func (f *streamReadyEventHandler) HandleStreamReady(context.Context) error {
	f.ready++
	return nil
}

type eventText struct {
	sessionID string
	text      string
}

func (f *fakeEventHandler) HandleAssistantText(_ context.Context, sessionID string, text string) error {
	f.texts = append(f.texts, eventText{sessionID: sessionID, text: text})
	if f.textErr != nil {
		return f.textErr
	}
	return nil
}

func (f *fakeEventHandler) HandlePermission(_ context.Context, permission bridge.PendingPermission) error {
	f.permissions = append(f.permissions, permission)
	return nil
}

func (f *fakeEventHandler) HandlePermissionResolved(_ context.Context, resolution bridge.PermissionResolution) error {
	f.resolvedPermissions = append(f.resolvedPermissions, resolution)
	return nil
}

func (f *fakeEventHandler) HandleQuestion(_ context.Context, question bridge.PendingQuestion) error {
	f.questions = append(f.questions, question)
	return nil
}

func (f *fakeEventHandler) HandleQuestionResolved(_ context.Context, resolution bridge.QuestionResolution) error {
	f.resolvedQuestions = append(f.resolvedQuestions, resolution)
	return nil
}

func (f *fakeEventHandler) HandleSession(_ context.Context, session bridge.Session) error {
	f.sessions = append(f.sessions, session)
	return nil
}

func (f *fakeEventHandler) HandleReplayRefresh(_ context.Context) error {
	f.refreshes++
	return f.refreshErr
}

func TestDispatchEventRoutesAssistantText(t *testing.T) {
	handler := &fakeEventHandler{}
	err := DispatchEvent(t.Context(), []byte(`{
		"payload": {
			"type": "message.part.updated",
			"properties": {
				"part": {
					"type": "text",
					"sessionID": "ses_1",
					"messageID": "msg_1",
					"id": "prt_1",
					"text": "hello",
					"time": {"start": 1, "end": 2}
				}
			}
		}
	}`), handler)
	if err != nil {
		t.Fatal(err)
	}
	if len(handler.texts) != 1 || handler.texts[0] != (eventText{sessionID: "ses_1", text: "hello"}) {
		t.Fatalf("texts = %#v", handler.texts)
	}
}

func TestDispatchEventIgnoresStreamingDeltaAndReasoning(t *testing.T) {
	handler := &fakeEventHandler{}
	delta := []byte(`{
		"payload": {
			"type": "message.part.delta",
			"properties": {
				"sessionID": "ses_1",
				"messageID": "msg_1",
				"partID": "prt_1",
				"field": "text",
				"delta": " hello"
			}
		}
	}`)
	if err := DispatchEvent(t.Context(), delta, handler); err != nil {
		t.Fatal(err)
	}
	reasoning := []byte(`{
		"payload": {
			"type": "message.part.updated",
			"properties": {
				"part": {
					"type": "reasoning",
					"sessionID": "ses_1",
					"messageID": "msg_1",
					"id": "prt_reasoning",
					"text": "private reasoning",
					"time": {"start": 1, "end": 2}
				}
			}
		}
	}`)
	if err := DispatchEvent(t.Context(), reasoning, handler); err != nil {
		t.Fatal(err)
	}
	if len(handler.texts) != 0 {
		t.Fatalf("texts = %#v", handler.texts)
	}
}

func TestDispatchEventRoutesPermissionAndQuestion(t *testing.T) {
	handler := &fakeEventHandler{}
	permission := []byte(`{
		"directory": "/repo/a",
		"payload": {
			"type": "permission.asked",
			"properties": {
				"id": "perm_1",
				"sessionID": "ses_1",
				"permission": "edit",
				"patterns": ["/repo/app.ts"]
			}
		}
	}`)
	if err := DispatchEvent(t.Context(), permission, handler); err != nil {
		t.Fatal(err)
	}
	if len(handler.permissions) != 1 || handler.permissions[0].ID != "perm_1" {
		t.Fatalf("permissions = %#v", handler.permissions)
	}
	if handler.permissions[0].Directory != "/repo/a" {
		t.Fatalf("permission directory = %q", handler.permissions[0].Directory)
	}

	question := []byte(`{
		"directory": "/repo/a",
		"payload": {
			"type": "message.part.updated",
			"properties": {
				"part": {
					"type": "tool",
					"sessionID": "ses_1",
					"messageID": "msg_1",
					"callID": "call_1",
					"tool": "question",
						"state": {
							"status": "running",
							"metadata": {"externalResultReady": true},
							"input": {
								"questions": [{
								"header": "Approach",
								"question": "Pick one",
								"multiple": false,
								"options": [
									{"label": "A", "description": "Small"},
									{"label": "B", "description": "Large"}
								]
							}]
						}
					}
				}
			}
		}
	}`)
	if err := DispatchEvent(t.Context(), question, handler); err != nil {
		t.Fatal(err)
	}
	if len(handler.questions) != 1 {
		t.Fatalf("questions = %#v", handler.questions)
	}
	got := handler.questions[0]
	if got.SessionID != "ses_1" || got.MessageID != "msg_1" || got.CallID != "call_1" {
		t.Fatalf("question = %#v", got)
	}
	if got.Directory != "/repo/a" {
		t.Fatalf("question directory = %q", got.Directory)
	}
	if got.Questions[0].Options[1].Label != "B" {
		t.Fatalf("question options = %#v", got.Questions[0].Options)
	}
}

func TestDispatchEventRoutesResolvedPermissionAndQuestion(t *testing.T) {
	handler := &fakeEventHandler{}
	permission := []byte(`{
		"directory": "/repo/a",
		"payload": {
			"type": "permission.replied",
			"properties": {
				"sessionID": "ses_1",
				"requestID": "perm_1",
				"reply": "once"
			}
		}
	}`)
	if err := DispatchEvent(t.Context(), permission, handler); err != nil {
		t.Fatal(err)
	}
	if len(handler.resolvedPermissions) != 1 || handler.resolvedPermissions[0] != (bridge.PermissionResolution{SessionID: "ses_1", RequestID: "perm_1", Directory: "/repo/a"}) {
		t.Fatalf("resolved permissions = %#v", handler.resolvedPermissions)
	}

	question := []byte(`{
		"directory": "/repo/a",
		"payload": {
			"type": "message.part.updated",
			"properties": {
				"part": {
					"type": "tool",
					"sessionID": "ses_1",
					"messageID": "msg_1",
					"callID": "call_1",
					"tool": "question",
					"state": {"status": "completed"}
				}
			}
		}
	}`)
	if err := DispatchEvent(t.Context(), question, handler); err != nil {
		t.Fatal(err)
	}
	if len(handler.resolvedQuestions) != 1 || handler.resolvedQuestions[0] != (bridge.QuestionResolution{SessionID: "ses_1", MessageID: "msg_1", CallID: "call_1", Directory: "/repo/a"}) {
		t.Fatalf("resolved questions = %#v", handler.resolvedQuestions)
	}
}

func TestDispatchEventRoutesSessionCreated(t *testing.T) {
	handler := &fakeEventHandler{}
	err := DispatchEvent(t.Context(), []byte(`{
		"directory": "/repo/a",
		"payload": {
			"type": "session.created",
			"properties": {
				"sessionID": "child_1",
				"info": {
					"id": "child_1",
					"title": "Child session",
					"parentID": "root_1"
				}
			}
		}
	}`), handler)
	if err != nil {
		t.Fatal(err)
	}
	if len(handler.sessions) != 1 || handler.sessions[0] != (bridge.Session{ID: "child_1", Title: "Child session", ParentID: "root_1", Directory: "/repo/a"}) {
		t.Fatalf("sessions = %#v", handler.sessions)
	}
}

func TestDispatchEventIgnoresQuestionBeforeExternalResultReady(t *testing.T) {
	handler := &fakeEventHandler{}
	err := DispatchEvent(t.Context(), []byte(`{
		"payload": {
			"type": "message.part.updated",
			"properties": {
				"part": {
					"type": "tool",
					"sessionID": "ses_1",
					"messageID": "msg_1",
					"callID": "call_1",
					"tool": "question",
					"state": {
						"status": "pending",
						"input": {
							"questions": [{"question": "Pick one"}]
						}
					}
				}
			}
		}
	}`), handler)
	if err != nil {
		t.Fatal(err)
	}
	if len(handler.questions) != 0 {
		t.Fatalf("questions = %#v", handler.questions)
	}
}

func TestClientStreamsGlobalEvents(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/global/event" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"payload\":{\"type\":\"message.part.updated\",\"properties\":{\"part\":{\"type\":\"text\",\"sessionID\":\"ses_1\",\"messageID\":\"msg_1\",\"id\":\"prt_1\",\"text\":\"hi\",\"time\":{\"start\":1,\"end\":2}}}}}\n\n"))
	}))
	defer server.Close()

	handler := &fakeEventHandler{}
	if err := New(server.URL).StreamEvents(t.Context(), handler); err != nil {
		t.Fatal(err)
	}
	if len(handler.texts) != 1 || handler.texts[0].text != "hi" {
		t.Fatalf("texts = %#v", handler.texts)
	}
}

func TestClientRejectsNonSSEEventStreamBeforeReady(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/global/event" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	handler := &streamReadyEventHandler{}
	err := New(server.URL).StreamEvents(t.Context(), handler)
	if err == nil {
		t.Fatal("expected non-SSE stream response to fail")
	}
	// Must be fatal so the gateway fails fast instead of reconnecting forever.
	if !IsFatalStreamError(err) {
		t.Fatalf("non-SSE stream error should be fatal, got %v", err)
	}
	if handler.ready != 0 {
		t.Fatalf("ready calls = %d", handler.ready)
	}
}

func TestClientContinuesAfterEventHandlerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"payload\":{\"type\":\"message.part.updated\",\"properties\":{\"part\":{\"type\":\"text\",\"sessionID\":\"ses_1\",\"text\":\"first\",\"time\":{\"end\":1}}}}}\n\n"))
		_, _ = w.Write([]byte("data: {\"payload\":{\"type\":\"message.part.updated\",\"properties\":{\"part\":{\"type\":\"text\",\"sessionID\":\"ses_1\",\"text\":\"second\",\"time\":{\"end\":2}}}}}\n\n"))
	}))
	defer server.Close()

	handler := &fakeEventHandler{textErr: errors.New("send failed")}
	if err := New(server.URL).StreamEvents(t.Context(), handler); err != nil {
		t.Fatal(err)
	}
	if len(handler.texts) != 2 {
		t.Fatalf("texts = %#v", handler.texts)
	}
}

func TestClientStreamsLongCompletedText(t *testing.T) {
	longText := strings.Repeat("x", 70*1024)
	envelope := map[string]any{
		"payload": map[string]any{
			"type": "message.part.updated",
			"properties": map[string]any{
				"part": map[string]any{
					"type":      "text",
					"sessionID": "ses_1",
					"messageID": "msg_1",
					"id":        "prt_1",
					"text":      longText,
					"time":      map[string]any{"start": 1, "end": 2},
				},
			},
		},
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("data: "))
		_, _ = w.Write(data)
		_, _ = w.Write([]byte("\n\n"))
	}))
	defer server.Close()

	handler := &fakeEventHandler{}
	if err := New(server.URL).StreamEvents(t.Context(), handler); err != nil {
		t.Fatal(err)
	}
	if len(handler.texts) != 1 || handler.texts[0].text != longText {
		t.Fatalf("texts = %#v", handler.texts)
	}
}

func TestClientReconcilesAfterUndecodableCriticalEvent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		// permission.asked whose patterns is a string, not an array: the critical
		// event fails to decode and must be reconciled, not silently skipped.
		_, _ = w.Write([]byte("id: evt-7\ndata: {\"payload\":{\"type\":\"permission.asked\",\"properties\":{\"id\":\"perm_1\",\"sessionID\":\"ses_1\",\"patterns\":\"oops\"}}}\n\n"))
	}))
	defer server.Close()

	handler := &fakeEventHandler{}
	client := New(server.URL)
	if err := client.StreamEvents(t.Context(), handler); err != nil {
		t.Fatal(err)
	}
	if len(handler.permissions) != 0 {
		t.Fatalf("undecodable permission must not be surfaced: %#v", handler.permissions)
	}
	// The cursor advances past the bad event so a reconnect can never replay it
	// and wedge the global stream.
	if got := client.lastEventIDValue(); got != "evt-7" {
		t.Fatalf("cursor should advance past the skipped event, got %q", got)
	}
	// State is reconciled immediately via hydrate, even on a live (non-
	// reconnecting) stream, instead of waiting for the next reconnect.
	if handler.refreshes != 1 {
		t.Fatalf("expected one reconcile after the undecodable event, got %d", handler.refreshes)
	}
}
