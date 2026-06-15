package gateway

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/astro-han/pawwork/packages/remote-bridge/internal/bridge"
	"github.com/chenhg5/cc-connect/core"
)

func TestLoadConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{
		"pawWorkBaseURL": "http://127.0.0.1:4090",
		"statePath": "/tmp/pawwork-remote-sessions.json",
		"platforms": [{
			"name": "runtime-test",
			"enabled": true,
			"options": {"token": "secret"}
		}]
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	config, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if config.PawWorkBaseURL != "http://127.0.0.1:4090" || len(config.Platforms) != 1 {
		t.Fatalf("config = %#v", config)
	}
	if config.Platforms[0].Options["token"] != "secret" {
		t.Fatalf("platform options = %#v", config.Platforms[0].Options)
	}
}

func TestNewCreatesOnlyEnabledPlatforms(t *testing.T) {
	fakePlatforms := 0
	core.RegisterPlatform("runtime-test-enabled", func(opts map[string]any) (core.Platform, error) {
		fakePlatforms++
		if opts["token"] != "enabled" {
			t.Fatalf("opts = %#v", opts)
		}
		return &fakePlatform{name: "runtime-test-enabled"}, nil
	})
	core.RegisterPlatform("runtime-test-disabled", func(opts map[string]any) (core.Platform, error) {
		fakePlatforms++
		return &fakePlatform{name: "runtime-test-disabled"}, nil
	})

	app, err := New(Config{
		PawWorkBaseURL: "http://127.0.0.1:4090",
		StatePath:      filepath.Join(t.TempDir(), "sessions.json"),
		Platforms: []PlatformConfig{
			{Name: "runtime-test-enabled", Enabled: true, Options: map[string]any{"token": "enabled", "allow_from": "U123"}},
			{Name: "runtime-test-disabled", Enabled: false},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if fakePlatforms != 1 {
		t.Fatalf("created platforms = %d", fakePlatforms)
	}
	if got := app.PlatformNames(); len(got) != 1 || got[0] != "runtime-test-enabled" {
		t.Fatalf("platforms = %#v", got)
	}
}

func TestNewRejectsWildcardRemoteAudience(t *testing.T) {
	fakePlatforms := 0
	core.RegisterPlatform("runtime-test-wildcard", func(map[string]any) (core.Platform, error) {
		fakePlatforms++
		return &fakePlatform{name: "runtime-test-wildcard"}, nil
	})

	_, err := New(Config{
		PawWorkBaseURL: "http://127.0.0.1:4090",
		StatePath:      filepath.Join(t.TempDir(), "sessions.json"),
		Platforms: []PlatformConfig{{
			Name:    "runtime-test-wildcard",
			Enabled: true,
			Options: map[string]any{"allow_from": "*"},
		}},
	})

	if err == nil || !strings.Contains(err.Error(), "specific allow_from") {
		t.Fatalf("err = %v", err)
	}
	if fakePlatforms != 0 {
		t.Fatalf("created platforms = %d", fakePlatforms)
	}
}

func TestRemoteAudienceRejectsWildcardFeishuChat(t *testing.T) {
	if hasRemoteAudience("feishu", map[string]any{"allow_chat": "*", "group_only": true}) {
		t.Fatal("wildcard Feishu chat audience should not be accepted")
	}
}

func TestHydrateResurfacesPendingInteractions(t *testing.T) {
	platform := &fakePlatform{name: "runtime-test-hydrate"}
	core.RegisterPlatform("runtime-test-hydrate", func(map[string]any) (core.Platform, error) {
		return platform, nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/experimental/session":
			_, _ = w.Write([]byte(`[
				{"id": "ses_root", "title": "Root"},
				{"id": "ses_child", "title": "Child", "parentID": "ses_root"}
			]`))
		case "/permission":
			_, _ = w.Write([]byte(`[{
				"id": "perm_1",
				"sessionID": "ses_child",
				"permission": "edit",
				"patterns": ["/repo/app.ts"]
			}]`))
		case "/external-result":
			_, _ = w.Write([]byte(`[{
					"part": {
						"type": "tool",
						"sessionID": "ses_child",
						"messageID": "msg_1",
						"callID": "call_1",
					"tool": "question",
					"state": {
						"status": "running",
						"metadata": {"externalResultReady": true},
						"input": {
							"questions": [{"question": "Pick one"}]
						}
					}
				}
			}]`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	statePath := filepath.Join(t.TempDir(), "sessions.json")
	if err := os.WriteFile(statePath, []byte(`{"runtime-test-hydrate:room:alice":"ses_root"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := New(Config{
		PawWorkBaseURL: server.URL,
		StatePath:      statePath,
		Platforms: []PlatformConfig{{
			Name:    "runtime-test-hydrate",
			Enabled: true,
			Options: map[string]any{"allow_from": "U123"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := app.hydrate(t.Context()); err != nil {
		t.Fatal(err)
	}

	if platform.reconstructKey != "runtime-test-hydrate:room:alice" {
		t.Fatalf("reconstruct key = %q", platform.reconstructKey)
	}
	if len(platform.sends) != 2 {
		t.Fatalf("sends = %#v", platform.sends)
	}
	if !strings.Contains(platform.sends[0], "PawWork asks permission: edit") {
		t.Fatalf("permission send = %q", platform.sends[0])
	}
	if !strings.Contains(platform.sends[1], "Pick one") {
		t.Fatalf("question send = %q", platform.sends[1])
	}
}

func TestRunStartsEventStreamBeforePlatforms(t *testing.T) {
	platform := &fakePlatform{name: "runtime-test-stream-before-platform"}
	core.RegisterPlatform("runtime-test-stream-before-platform", func(map[string]any) (core.Platform, error) {
		return platform, nil
	})
	var streamReady atomic.Bool
	streamStarted := make(chan struct{})
	platform.started = make(chan struct{})
	platform.streamReady = &streamReady
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/experimental/session", "/permission", "/external-result":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`[]`))
		case "/global/event":
			streamReady.Store(true)
			close(streamStarted)
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			<-r.Context().Done()
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	app, err := New(Config{
		PawWorkBaseURL: server.URL,
		StatePath:      filepath.Join(t.TempDir(), "sessions.json"),
		Platforms: []PlatformConfig{{
			Name:    "runtime-test-stream-before-platform",
			Enabled: true,
			Options: map[string]any{"allow_from": "U123"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- app.Run(ctx)
	}()
	defer func() {
		cancel()
		if err := <-errCh; err != nil {
			t.Fatal(err)
		}
	}()

	select {
	case <-streamStarted:
	case <-time.After(time.Second):
		t.Fatal("event stream did not start")
	}
	select {
	case <-platform.started:
	case <-time.After(time.Second):
		t.Fatal("platform did not start")
	}
	if !platform.startedAfterStream {
		t.Fatal("platform started before the event stream was connected")
	}
}

func TestRunStartsEventStreamBeforeInitialHydrate(t *testing.T) {
	platform := &fakePlatform{name: "runtime-test-stream-before-hydrate"}
	core.RegisterPlatform("runtime-test-stream-before-hydrate", func(map[string]any) (core.Platform, error) {
		return platform, nil
	})
	platform.started = make(chan struct{})
	var mu sync.Mutex
	order := []string{}
	record := func(name string) {
		mu.Lock()
		defer mu.Unlock()
		order = append(order, name)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/experimental/session":
			record("hydrate")
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`[]`))
		case "/permission", "/external-result":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`[]`))
		case "/global/event":
			record("stream")
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			<-r.Context().Done()
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	app, err := New(Config{
		PawWorkBaseURL: server.URL,
		StatePath:      filepath.Join(t.TempDir(), "sessions.json"),
		Platforms: []PlatformConfig{{
			Name:    "runtime-test-stream-before-hydrate",
			Enabled: true,
			Options: map[string]any{"allow_from": "U123"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	errCh := make(chan error, 1)
	go func() {
		errCh <- app.Run(ctx)
	}()
	defer func() {
		cancel()
		if err := <-errCh; err != nil {
			t.Fatal(err)
		}
	}()

	select {
	case <-platform.started:
	case <-time.After(time.Second):
		t.Fatal("platform did not start")
	}

	mu.Lock()
	got := append([]string(nil), order...)
	mu.Unlock()
	if len(got) < 2 || got[0] != "stream" || got[1] != "hydrate" {
		t.Fatalf("request order = %#v", got)
	}
}

func TestHydrateContinuesWhenPendingDeliveryFails(t *testing.T) {
	platform := &fakePlatform{name: "runtime-test-hydrate-send-failure", sendErr: errors.New("chat unavailable")}
	core.RegisterPlatform("runtime-test-hydrate-send-failure", func(map[string]any) (core.Platform, error) {
		return platform, nil
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch r.URL.Path {
		case "/experimental/session":
			_, _ = w.Write([]byte(`[
				{"id": "ses_root", "title": "Root"},
				{"id": "ses_child", "title": "Child", "parentID": "ses_root"}
			]`))
		case "/permission":
			_, _ = w.Write([]byte(`[{
				"id": "perm_1",
				"sessionID": "ses_child",
				"permission": "edit",
				"patterns": ["/repo/app.ts"]
			}]`))
		case "/external-result":
			_, _ = w.Write([]byte(`[]`))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	statePath := filepath.Join(t.TempDir(), "sessions.json")
	if err := os.WriteFile(statePath, []byte(`{"runtime-test-hydrate-send-failure:room:alice":"ses_root"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := New(Config{
		PawWorkBaseURL: server.URL,
		StatePath:      statePath,
		Platforms: []PlatformConfig{{
			Name:    "runtime-test-hydrate-send-failure",
			Enabled: true,
			Options: map[string]any{"allow_from": "U123"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := app.hydrate(t.Context()); err != nil {
		t.Fatalf("hydrate should keep running after a single pending delivery fails: %v", err)
	}
	if len(platform.sends) != 1 {
		t.Fatalf("sends = %#v", platform.sends)
	}
}

func TestRunRetriesTransientEventStreamErrors(t *testing.T) {
	platformName := "runtime-test-event-retry"
	core.RegisterPlatform(platformName, func(map[string]any) (core.Platform, error) {
		return &fakePlatform{name: platformName}, nil
	})
	eventRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/experimental/session", "/permission", "/external-result":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`[]`))
		case "/global/event":
			eventRequests++
			if eventRequests == 1 {
				http.Error(w, "temporary", http.StatusInternalServerError)
				return
			}
			w.Header().Set("content-type", "text/event-stream")
			_, _ = w.Write([]byte("data: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	app, err := New(Config{
		PawWorkBaseURL: server.URL,
		StatePath:      filepath.Join(t.TempDir(), "sessions.json"),
		Platforms: []PlatformConfig{{
			Name:    platformName,
			Enabled: true,
			Options: map[string]any{"allow_from": "U123"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	app.eventRetryDelay = time.Millisecond
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()

	if err := app.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if eventRequests < 2 {
		t.Fatalf("event requests = %d", eventRequests)
	}
}

func TestRunHydratesAfterReplayGapSignal(t *testing.T) {
	platformName := "runtime-test-event-gap"
	core.RegisterPlatform(platformName, func(map[string]any) (core.Platform, error) {
		return &fakePlatform{name: platformName}, nil
	})
	eventRequests := 0
	permissionRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/experimental/session", "/external-result":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`[]`))
		case "/permission":
			permissionRequests++
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`[]`))
		case "/global/event":
			eventRequests++
			w.Header().Set("content-type", "text/event-stream")
			if eventRequests == 1 {
				_, _ = w.Write([]byte("id: cursor-1\ndata: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
				return
			}
			if r.Header.Get("Last-Event-ID") == "" {
				t.Fatal("expected reconnect to carry Last-Event-ID")
			}
			_, _ = w.Write([]byte("id: cursor-2\ndata: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n"))
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	app, err := New(Config{
		PawWorkBaseURL: server.URL,
		StatePath:      filepath.Join(t.TempDir(), "sessions.json"),
		Platforms: []PlatformConfig{{
			Name:    platformName,
			Enabled: true,
			Options: map[string]any{"allow_from": "U123"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	app.eventRetryDelay = time.Millisecond
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()

	if err := app.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if permissionRequests < 2 {
		t.Fatalf("permission requests = %d", permissionRequests)
	}
}

func TestMessageHandlerLogsEngineFailures(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)

	app := &App{engine: bridge.New(failingSidecar{})}
	app.messageHandler(t.Context())(&fakePlatform{name: "runtime-test-message-log"}, &core.Message{
		SessionKey: "runtime-test-message-log:dm:alice",
		Content:    "start",
	})

	if !strings.Contains(logs.String(), "remote bridge failed to handle inbound message") {
		t.Fatalf("logs = %q", logs.String())
	}
}

type failingSidecar struct{}

func (failingSidecar) CreateSession(context.Context) (string, error) {
	return "", errors.New("sidecar unavailable")
}
func (failingSidecar) SendPrompt(context.Context, string, string) error {
	return errors.New("sidecar unavailable")
}
func (failingSidecar) ListSessions(context.Context, int) ([]bridge.Session, error) {
	return nil, errors.New("sidecar unavailable")
}
func (failingSidecar) AbortSession(context.Context, string) (bool, error) {
	return false, errors.New("sidecar unavailable")
}
func (failingSidecar) ReplyPermission(context.Context, bridge.PendingPermission, bridge.PermissionReply) error {
	return errors.New("sidecar unavailable")
}
func (failingSidecar) SubmitQuestion(context.Context, bridge.PendingQuestion, [][]string) error {
	return errors.New("sidecar unavailable")
}

type fakePlatform struct {
	name               string
	reconstructKey     string
	sends              []string
	sendErr            error
	started            chan struct{}
	streamReady        *atomic.Bool
	startedAfterStream bool
}

func (f *fakePlatform) Name() string { return f.name }
func (f *fakePlatform) Start(core.MessageHandler) error {
	if f.started != nil {
		f.startedAfterStream = f.streamReady != nil && f.streamReady.Load()
		close(f.started)
	}
	<-context.Background().Done()
	return nil
}
func (f *fakePlatform) Reply(context.Context, any, string) error { return nil }
func (f *fakePlatform) Send(_ context.Context, _ any, content string) error {
	f.sends = append(f.sends, content)
	return f.sendErr
}
func (f *fakePlatform) ReconstructReplyCtx(sessionKey string) (any, error) {
	f.reconstructKey = sessionKey
	return "restored-reply-context", nil
}
func (f *fakePlatform) Stop() error { return nil }
