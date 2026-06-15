package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/astro-han/pawwork/packages/remote-bridge/internal/bridge"
	"github.com/astro-han/pawwork/packages/remote-bridge/internal/pawwork"
	_ "github.com/astro-han/pawwork/packages/remote-bridge/internal/platforms"
	"github.com/chenhg5/cc-connect/core"
)

type Config struct {
	PawWorkBaseURL  string           `json:"pawWorkBaseURL"`
	PawWorkUsername string           `json:"pawWorkUsername,omitempty"`
	PawWorkPassword string           `json:"pawWorkPassword,omitempty"`
	StatePath       string           `json:"statePath"`
	Platforms       []PlatformConfig `json:"platforms"`
}

type PlatformConfig struct {
	Name    string         `json:"name"`
	Enabled bool           `json:"enabled"`
	Options map[string]any `json:"options"`
}

type App struct {
	client          *pawwork.Client
	engine          *bridge.Engine
	platforms       []core.Platform
	eventRetryDelay time.Duration
}

func LoadConfig(path string) (Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return Config{}, err
	}
	defer file.Close()
	return DecodeConfig(file)
}

func DecodeConfig(reader io.Reader) (Config, error) {
	var config Config
	if err := json.NewDecoder(reader).Decode(&config); err != nil {
		return Config{}, err
	}
	return config, nil
}

func New(config Config) (*App, error) {
	if config.PawWorkBaseURL == "" {
		return nil, errors.New("pawWorkBaseURL is required")
	}
	if config.StatePath == "" {
		return nil, errors.New("statePath is required")
	}
	pointers, err := bridge.NewFileSessionPointers(config.StatePath)
	if err != nil {
		return nil, err
	}
	client := pawwork.NewWithAuth(config.PawWorkBaseURL, config.PawWorkUsername, config.PawWorkPassword)
	client.SetEventCursorStore(pointers)
	app := &App{
		client:          client,
		engine:          bridge.NewWithSessionPointers(client, pointers),
		eventRetryDelay: time.Second,
	}
	for _, item := range config.Platforms {
		if !item.Enabled {
			continue
		}
		if item.Name == "" {
			return nil, errors.New("enabled platform name is required")
		}
		options := item.Options
		if options == nil {
			options = map[string]any{}
		}
		if !hasRemoteAudience(item.Name, options) {
			return nil, fmt.Errorf("%s platform requires a specific allow_from or Feishu/Lark allow_chat with group_only", item.Name)
		}
		platform, err := core.CreatePlatform(item.Name, options)
		if err != nil {
			return nil, err
		}
		app.engine.RegisterPlatform(platform)
		app.platforms = append(app.platforms, platform)
	}
	if len(app.platforms) == 0 {
		return nil, errors.New("at least one platform must be enabled")
	}
	return app, nil
}

func hasRemoteAudience(platform string, options map[string]any) bool {
	if allowFrom, ok := options["allow_from"].(string); ok && isSpecificAudience(allowFrom) {
		return true
	}
	if platform != "feishu" && platform != "lark" {
		return false
	}
	allowChat, ok := options["allow_chat"].(string)
	return ok && isSpecificAudience(allowChat) && options["group_only"] == true
}

func isSpecificAudience(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && value != "*"
}

func Run(ctx context.Context, config Config) error {
	app, err := New(config)
	if err != nil {
		return err
	}
	return app.Run(ctx)
}

func (a *App) PlatformNames() []string {
	names := make([]string, 0, len(a.platforms))
	for _, platform := range a.platforms {
		names = append(names, platform.Name())
	}
	return names
}

func (a *App) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer a.stopPlatforms()
	defer cancel()
	errCh := make(chan error, len(a.platforms)+1)
	streamReady := make(chan struct{})
	var streamReadyOnce sync.Once
	go func() {
		handler := replayRefreshHandler{
			EventHandler: a.engine,
			hydrate:      a.hydrate,
			streamReady:  func() { streamReadyOnce.Do(func() { close(streamReady) }) },
		}
		for ctx.Err() == nil {
			if err := a.client.StreamEvents(ctx, handler); err != nil && ctx.Err() == nil {
				if pawwork.IsFatalStreamError(err) {
					errCh <- err
					return
				}
				slog.Warn("remote bridge event stream disconnected", "error", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(a.eventRetryDelay):
			}
		}
	}()
	select {
	case <-streamReady:
	case <-ctx.Done():
		return nil
	case err := <-errCh:
		return err
	}
	if err := a.hydrate(ctx); err != nil {
		return err
	}
	for _, platform := range a.platforms {
		platform := platform
		go func() {
			if err := platform.Start(a.messageHandler(ctx)); err != nil && ctx.Err() == nil {
				errCh <- fmt.Errorf("%s platform failed: %w", platform.Name(), err)
			}
		}()
	}

	select {
	case <-ctx.Done():
		return nil
	case err := <-errCh:
		return err
	}
}

func (a *App) messageHandler(ctx context.Context) core.MessageHandler {
	return func(platform core.Platform, msg *core.Message) {
		if err := a.engine.HandleMessage(ctx, platform, msg); err != nil {
			slog.Warn("remote bridge failed to handle inbound message", "platform", platform.Name(), "sessionKey", msg.SessionKey, "error", err)
		}
	}
}

type replayRefreshHandler struct {
	pawwork.EventHandler
	hydrate     func(context.Context) error
	streamReady func()
}

func (h replayRefreshHandler) HandleReplayRefresh(ctx context.Context) error {
	return h.hydrate(ctx)
}

func (h replayRefreshHandler) HandleStreamReady(context.Context) error {
	if h.streamReady != nil {
		h.streamReady()
	}
	return nil
}

func (a *App) hydrate(ctx context.Context) error {
	sessions, err := a.client.ListSessions(ctx, 0)
	if err != nil {
		return err
	}
	for _, session := range sessions {
		if err := a.engine.HandleSession(ctx, session); err != nil {
			return err
		}
	}
	permissions, err := a.client.ListPermissions(ctx)
	if err != nil {
		return err
	}
	for _, permission := range permissions {
		if err := a.engine.HandlePermission(ctx, permission); err != nil {
			slog.Warn("remote bridge could not resurface pending permission", "session", permission.SessionID, "permission", permission.ID, "error", err)
		}
	}
	questions, err := a.client.ListQuestions(ctx)
	if err != nil {
		return err
	}
	for _, question := range questions {
		if err := a.engine.HandleQuestion(ctx, question); err != nil {
			slog.Warn("remote bridge could not resurface pending question", "session", question.SessionID, "message", question.MessageID, "error", err)
		}
	}
	return nil
}

func (a *App) stopPlatforms() {
	for _, platform := range a.platforms {
		_ = platform.Stop()
	}
}
