package pawwork

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/astro-han/pawwork/packages/remote-bridge/internal/bridge"
)

func TestClientUsesPawWorkSessionEndpoints(t *testing.T) {
	var promptBody map[string]any
	var promptDirectory string
	var abortDirectory string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/session":
			writeJSON(t, w, map[string]any{"id": "ses_new", "title": "Remote", "directory": "/default"})
		case r.Method == http.MethodGet && r.URL.Path == "/experimental/session":
			if r.URL.Query().Get("limit") != "5" || r.URL.Query().Get("sort") != "updated" {
				t.Fatalf("query = %s", r.URL.RawQuery)
			}
			writeJSON(t, w, []map[string]any{
				{"id": "ses_a", "title": "Plan", "directory": "/repo/a"},
				{"id": "ses_b", "parentID": "ses_a", "directory": "/repo/a"},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/session/ses_a/prompt_async":
			promptDirectory = r.Header.Get("x-opencode-directory")
			if err := json.NewDecoder(r.Body).Decode(&promptBody); err != nil {
				t.Fatal(err)
			}
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/session/ses_a/abort":
			abortDirectory = r.Header.Get("x-opencode-directory")
			writeJSON(t, w, true)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client := New(server.URL)
	sessionID, err := client.CreateSession(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if sessionID != "ses_new" {
		t.Fatalf("sessionID = %q", sessionID)
	}

	sessions, err := client.ListSessions(t.Context(), 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || sessions[0] != (bridge.Session{ID: "ses_a", Title: "Plan", Directory: "/repo/a"}) || sessions[1] != (bridge.Session{ID: "ses_b", ParentID: "ses_a", Directory: "/repo/a"}) {
		t.Fatalf("sessions = %#v", sessions)
	}

	if err := client.SendPrompt(t.Context(), "ses_a", "hello"); err != nil {
		t.Fatal(err)
	}
	if got := promptBody["parts"]; got == nil {
		t.Fatalf("prompt body = %#v", promptBody)
	}
	if promptDirectory != "/repo/a" {
		t.Fatalf("prompt directory = %q", promptDirectory)
	}

	aborted, err := client.AbortSession(t.Context(), "ses_a")
	if err != nil {
		t.Fatal(err)
	}
	if !aborted {
		t.Fatal("expected aborted run")
	}
	if abortDirectory != "/repo/a" {
		t.Fatalf("abort directory = %q", abortDirectory)
	}
}

func TestClientFetchesSessionDirectoryWhenMissing(t *testing.T) {
	var promptDirectory string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/session/ses_unknown":
			writeJSON(t, w, map[string]any{"id": "ses_unknown", "directory": "/repo/unknown"})
		case r.Method == http.MethodPost && r.URL.Path == "/session/ses_unknown/prompt_async":
			promptDirectory = r.Header.Get("x-opencode-directory")
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client := New(server.URL)
	if err := client.SendPrompt(t.Context(), "ses_unknown", "hello"); err != nil {
		t.Fatal(err)
	}
	if promptDirectory != "/repo/unknown" {
		t.Fatalf("prompt directory = %q", promptDirectory)
	}
}

func TestClientSendsBasicAuthWhenConfigured(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Basic UGF3V29yazpwYXNz" {
			t.Fatalf("authorization = %q", r.Header.Get("authorization"))
		}
		writeJSON(t, w, map[string]any{"id": "ses_new"})
	}))
	defer server.Close()

	client := NewWithAuth(server.URL, "PawWork", "pass")
	if _, err := client.CreateSession(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestClientRepliesToPermissionAndQuestion(t *testing.T) {
	var permissionBody map[string]any
	var questionBody map[string]any
	var permissionDirectory string
	var questionDirectory string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/permission/perm_1/reply":
			permissionDirectory = r.Header.Get("x-opencode-directory")
			if err := json.NewDecoder(r.Body).Decode(&permissionBody); err != nil {
				t.Fatal(err)
			}
			writeJSON(t, w, true)
		case r.Method == http.MethodPost && r.URL.Path == "/session/ses_1/tool/respond":
			questionDirectory = r.Header.Get("x-opencode-directory")
			if err := json.NewDecoder(r.Body).Decode(&questionBody); err != nil {
				t.Fatal(err)
			}
			writeJSON(t, w, map[string]any{"status": "ok"})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client := New(server.URL)
	err := client.ReplyPermission(t.Context(), bridge.PendingPermission{
		ID:        "perm_1",
		SessionID: "ses_1",
		Directory: "/repo/interactions",
	}, bridge.PermissionReply{Reply: "once", Message: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if permissionBody["reply"] != "once" || permissionBody["message"] != "go" {
		t.Fatalf("permission body = %#v", permissionBody)
	}
	if permissionDirectory != "/repo/interactions" {
		t.Fatalf("permission directory = %q", permissionDirectory)
	}

	pending := bridge.PendingQuestion{SessionID: "ses_1", MessageID: "msg_1", CallID: "call_1", Directory: "/repo/interactions"}
	if err := client.SubmitQuestion(t.Context(), pending, [][]string{{"A"}}); err != nil {
		t.Fatal(err)
	}
	if questionBody["kind"] != "submit" || questionBody["messageID"] != "msg_1" || questionBody["callID"] != "call_1" {
		t.Fatalf("question body = %#v", questionBody)
	}
	payload := questionBody["payload"].(map[string]any)
	if payload["answers"] == nil {
		t.Fatalf("question payload = %#v", payload)
	}
	if questionDirectory != "/repo/interactions" {
		t.Fatalf("question directory = %q", questionDirectory)
	}
}

func TestClientListsPendingInteractions(t *testing.T) {
	permissionDirectories := []string{}
	questionDirectories := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/experimental/session":
			writeJSON(t, w, []map[string]any{{"id": "ses_1", "directory": "/repo/a"}})
		case r.Method == http.MethodGet && r.URL.Path == "/permission":
			permissionDirectories = append(permissionDirectories, r.Header.Get("x-opencode-directory"))
			writeJSON(t, w, []map[string]any{{
				"id":         "perm_1",
				"sessionID":  "ses_1",
				"permission": "edit",
				"patterns":   []string{"/repo/app.ts"},
			}})
		case r.Method == http.MethodGet && r.URL.Path == "/external-result":
			questionDirectories = append(questionDirectories, r.Header.Get("x-opencode-directory"))
			writeJSON(t, w, []map[string]any{{
				"part": map[string]any{
					"type":      "tool",
					"sessionID": "ses_1",
					"messageID": "msg_1",
					"callID":    "call_1",
					"tool":      "question",
					"state": map[string]any{
						"status":   "running",
						"metadata": map[string]any{"externalResultReady": true},
						"input": map[string]any{
							"questions": []map[string]any{{
								"header":   "Approach",
								"question": "Pick one",
								"options":  []map[string]any{{"label": "A", "description": "Small"}, {"label": "B", "description": "Large"}},
							}},
						},
					},
				},
			}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client := New(server.URL)
	if _, err := client.ListSessions(t.Context(), 5); err != nil {
		t.Fatal(err)
	}
	permissions, err := client.ListPermissions(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(permissions) != 1 || permissions[0].ID != "perm_1" || permissions[0].Patterns[0] != "/repo/app.ts" || permissions[0].Directory != "/repo/a" {
		t.Fatalf("permissions = %#v", permissions)
	}
	if len(permissionDirectories) != 1 || permissionDirectories[0] != "/repo/a" {
		t.Fatalf("permission directories = %#v", permissionDirectories)
	}

	questions, err := client.ListQuestions(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(questions) != 1 || questions[0].CallID != "call_1" || questions[0].Questions[0].Options[1].Label != "B" || questions[0].Directory != "/repo/a" {
		t.Fatalf("questions = %#v", questions)
	}
	if len(questionDirectories) != 1 || questionDirectories[0] != "/repo/a" {
		t.Fatalf("question directories = %#v", questionDirectories)
	}
}

func TestClientListPermissionsSkipsFailingDirectory(t *testing.T) {
	permissionDirectories := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/experimental/session":
			writeJSON(t, w, []map[string]any{
				{"id": "ses_a", "directory": "/repo/a"},
				{"id": "ses_b", "directory": "/repo/b"},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/permission":
			directory := r.Header.Get("x-opencode-directory")
			permissionDirectories = append(permissionDirectories, directory)
			if directory == "/repo/a" {
				http.Error(w, "temporary failure", http.StatusBadGateway)
				return
			}
			writeJSON(t, w, []map[string]any{{
				"id":         "perm_b",
				"sessionID":  "ses_b",
				"permission": "edit",
			}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client := New(server.URL)
	if _, err := client.ListSessions(t.Context(), 5); err != nil {
		t.Fatal(err)
	}
	permissions, err := client.ListPermissions(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	if len(permissions) != 1 || permissions[0].ID != "perm_b" || permissions[0].Directory != "/repo/b" {
		t.Fatalf("permissions = %#v", permissions)
	}
	if len(permissionDirectories) != 2 || permissionDirectories[0] != "/repo/a" || permissionDirectories[1] != "/repo/b" {
		t.Fatalf("permission directories = %#v", permissionDirectories)
	}
}

func TestClientListPermissionsReturnsFatalDirectoryError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/experimental/session":
			writeJSON(t, w, []map[string]any{{"id": "ses_a", "directory": "/repo/a"}})
		case r.Method == http.MethodGet && r.URL.Path == "/permission":
			http.Error(w, "forbidden", http.StatusForbidden)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client := New(server.URL)
	if _, err := client.ListSessions(t.Context(), 5); err != nil {
		t.Fatal(err)
	}
	_, err := client.ListPermissions(t.Context())

	var status *HTTPStatusError
	if !errors.As(err, &status) || status.StatusCode != http.StatusForbidden {
		t.Fatalf("err = %#v", err)
	}
}

func TestClientListQuestionsSkipsFailingDirectory(t *testing.T) {
	questionDirectories := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/experimental/session":
			writeJSON(t, w, []map[string]any{
				{"id": "ses_a", "directory": "/repo/a"},
				{"id": "ses_b", "directory": "/repo/b"},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/external-result":
			directory := r.Header.Get("x-opencode-directory")
			questionDirectories = append(questionDirectories, directory)
			if directory == "/repo/a" {
				http.Error(w, "temporary failure", http.StatusBadGateway)
				return
			}
			writeJSON(t, w, []map[string]any{{
				"part": map[string]any{
					"type":      "tool",
					"sessionID": "ses_b",
					"messageID": "msg_b",
					"callID":    "call_b",
					"tool":      "question",
					"state": map[string]any{
						"status":   "running",
						"metadata": map[string]any{"externalResultReady": true},
						"input": map[string]any{
							"questions": []map[string]any{{"question": "Pick one"}},
						},
					},
				},
			}})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client := New(server.URL)
	if _, err := client.ListSessions(t.Context(), 5); err != nil {
		t.Fatal(err)
	}
	questions, err := client.ListQuestions(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	if len(questions) != 1 || questions[0].CallID != "call_b" || questions[0].Directory != "/repo/b" {
		t.Fatalf("questions = %#v", questions)
	}
	if len(questionDirectories) != 2 || questionDirectories[0] != "/repo/a" || questionDirectories[1] != "/repo/b" {
		t.Fatalf("question directories = %#v", questionDirectories)
	}
}

func TestClientListQuestionsReturnsFatalDirectoryError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/experimental/session":
			writeJSON(t, w, []map[string]any{{"id": "ses_a", "directory": "/repo/a"}})
		case r.Method == http.MethodGet && r.URL.Path == "/external-result":
			http.Error(w, "missing", http.StatusNotFound)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.String())
		}
	}))
	defer server.Close()

	client := New(server.URL)
	if _, err := client.ListSessions(t.Context(), 5); err != nil {
		t.Fatal(err)
	}
	_, err := client.ListQuestions(t.Context())

	var status *HTTPStatusError
	if !errors.As(err, &status) || status.StatusCode != http.StatusNotFound {
		t.Fatalf("err = %#v", err)
	}
}

func TestClientUsesLastEventIDOnReconnect(t *testing.T) {
	lastEventID := ""
	seen := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Last-Event-ID"))
		w.Header().Set("content-type", "text/event-stream")
		if len(seen) == 1 {
			_, _ = w.Write([]byte("id: cursor-1\ndata: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
			return
		}
		lastEventID = r.Header.Get("Last-Event-ID")
		_, _ = w.Write([]byte("data: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
	}))
	defer server.Close()

	client := New(server.URL)
	if err := client.StreamEvents(t.Context(), &fakeEventHandler{}); err != nil {
		t.Fatal(err)
	}
	if err := client.StreamEvents(t.Context(), &fakeEventHandler{}); err != nil {
		t.Fatal(err)
	}
	if lastEventID != "cursor-1" {
		t.Fatalf("last event id = %q; seen = %#v", lastEventID, seen)
	}
}

func TestClientPersistsLastEventIDAcrossRestarts(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "sessions.json")
	store, err := bridge.NewFileSessionPointers(statePath)
	if err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("content-type", "text/event-stream")
		switch requests {
		case 1:
			if got := r.Header.Get("Last-Event-ID"); got != "" {
				t.Fatalf("first Last-Event-ID = %q", got)
			}
			_, _ = w.Write([]byte("id: cursor-1\ndata: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
		case 2:
			if got := r.Header.Get("Last-Event-ID"); got != "cursor-1" {
				t.Fatalf("second Last-Event-ID = %q", got)
			}
			_, _ = w.Write([]byte("id: cursor-2\ndata: {\"payload\":{\"type\":\"message.part.updated\",\"properties\":{\"part\":{\"type\":\"text\",\"sessionID\":\"ses_1\",\"text\":\"done\",\"time\":{\"end\":2}}}}}\n\n"))
		case 3:
			if got := r.Header.Get("Last-Event-ID"); got != "cursor-2" {
				t.Fatalf("third Last-Event-ID = %q", got)
			}
			_, _ = w.Write([]byte("id: cursor-3\ndata: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
		default:
			t.Fatalf("unexpected stream request %d", requests)
		}
	}))
	defer server.Close()

	first := New(server.URL)
	first.SetEventCursorStore(store)
	if err := first.StreamEvents(t.Context(), &fakeEventHandler{}); err != nil {
		t.Fatal(err)
	}

	reloaded, err := bridge.NewFileSessionPointers(statePath)
	if err != nil {
		t.Fatal(err)
	}
	second := New(server.URL)
	second.SetEventCursorStore(reloaded)
	secondHandler := &fakeEventHandler{}
	if err := second.StreamEvents(t.Context(), secondHandler); err != nil {
		t.Fatal(err)
	}
	if len(secondHandler.texts) != 1 || secondHandler.texts[0] != (eventText{sessionID: "ses_1", text: "done"}) {
		t.Fatalf("second texts = %#v", secondHandler.texts)
	}

	reloaded, err = bridge.NewFileSessionPointers(statePath)
	if err != nil {
		t.Fatal(err)
	}
	third := New(server.URL)
	third.SetEventCursorStore(reloaded)
	thirdHandler := &fakeEventHandler{}
	if err := third.StreamEvents(t.Context(), thirdHandler); err != nil {
		t.Fatal(err)
	}
	if len(thirdHandler.texts) != 0 {
		t.Fatalf("third texts = %#v", thirdHandler.texts)
	}
}

func TestClientKeepsLastEventIDWhenReplayRefreshFails(t *testing.T) {
	seen := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get("Last-Event-ID"))
		w.Header().Set("content-type", "text/event-stream")
		switch len(seen) {
		case 1:
			_, _ = w.Write([]byte("id: cursor-1\ndata: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
		case 2:
			_, _ = w.Write([]byte("id: cursor-2\ndata: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
		default:
			_, _ = w.Write([]byte("data: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
		}
	}))
	defer server.Close()

	client := New(server.URL)
	if err := client.StreamEvents(t.Context(), &fakeEventHandler{}); err != nil {
		t.Fatal(err)
	}
	handler := &fakeEventHandler{refreshErr: errors.New("hydrate failed")}
	if err := client.StreamEvents(t.Context(), handler); err == nil {
		t.Fatal("expected replay refresh failure")
	}
	if err := client.StreamEvents(t.Context(), &fakeEventHandler{}); err != nil {
		t.Fatal(err)
	}

	if len(seen) != 3 || seen[1] != "cursor-1" || seen[2] != "cursor-1" {
		t.Fatalf("Last-Event-ID headers = %#v", seen)
	}
	if handler.refreshes != 1 {
		t.Fatalf("refreshes = %d", handler.refreshes)
	}
}

func TestClientEscapesDirectoryQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.RawQuery; got != "directory="+url.QueryEscape("/repo/space here")+"&sort=updated&limit=5" {
			t.Fatalf("query = %q", got)
		}
		writeJSON(t, w, []map[string]any{})
	}))
	defer server.Close()

	client := NewWithDirectory(server.URL, "/repo/space here")
	if _, err := client.ListSessions(t.Context(), 5); err != nil {
		t.Fatal(err)
	}
}

func writeJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("content-type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatal(err)
	}
}
