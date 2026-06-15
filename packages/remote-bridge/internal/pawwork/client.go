package pawwork

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/astro-han/pawwork/packages/remote-bridge/internal/bridge"
)

type HTTPStatusError struct {
	Method     string
	Path       string
	Status     string
	StatusCode int
	Body       string
}

func (e *HTTPStatusError) Error() string {
	return fmt.Sprintf("%s %s failed: %s %s", e.Method, e.Path, e.Status, e.Body)
}

// StreamProtocolError marks an event stream that connected (2xx) but did not
// speak text/event-stream. Retrying cannot fix a protocol mismatch, so it is
// fatal and must stop the reconnect loop rather than spin forever.
type StreamProtocolError struct {
	ContentType string
}

func (e *StreamProtocolError) Error() string {
	return fmt.Sprintf("GET /global/event failed: expected text/event-stream, got %q", e.ContentType)
}

func IsFatalStreamError(err error) bool {
	var proto *StreamProtocolError
	if errors.As(err, &proto) {
		return true
	}
	var status *HTTPStatusError
	if !errors.As(err, &status) {
		return false
	}
	return status.StatusCode == http.StatusUnauthorized ||
		status.StatusCode == http.StatusForbidden ||
		status.StatusCode == http.StatusNotFound
}

type Client struct {
	baseURL            string
	http               *http.Client
	username           string
	password           string
	defaultDirectory   string
	jsonTimeout        time.Duration
	lastEventID        string
	eventCursorStore   bridge.EventCursorStore
	mu                 sync.Mutex
	sessionDirectories map[string]string
}

func New(baseURL string) *Client {
	return NewWithAuth(baseURL, "", "")
}

func NewWithAuth(baseURL string, username string, password string) *Client {
	return NewWithDirectoryAndAuth(baseURL, "", username, password)
}

func NewWithDirectory(baseURL string, directory string) *Client {
	return NewWithDirectoryAndAuth(baseURL, directory, "", "")
}

func NewWithDirectoryAndAuth(baseURL string, directory string, username string, password string) *Client {
	return &Client{
		baseURL:            strings.TrimRight(baseURL, "/"),
		http:               http.DefaultClient,
		username:           username,
		password:           password,
		defaultDirectory:   directory,
		jsonTimeout:        30 * time.Second,
		sessionDirectories: make(map[string]string),
	}
}

func (c *Client) SetEventCursorStore(store bridge.EventCursorStore) {
	cursor := ""
	if store != nil {
		cursor = store.EventCursor()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.eventCursorStore = store
	if c.lastEventID == "" {
		c.lastEventID = cursor
	}
}

func (c *Client) CreateSession(ctx context.Context) (string, error) {
	var session struct {
		ID        string `json:"id"`
		Directory string `json:"directory"`
	}
	if err := c.doJSONWithDirectory(ctx, c.defaultDirectory, http.MethodPost, "/session", map[string]any{}, &session); err != nil {
		return "", err
	}
	directory := session.Directory
	if directory == "" {
		directory = c.defaultDirectory
	}
	c.rememberSession(bridge.Session{ID: session.ID, Directory: directory})
	return session.ID, nil
}

func (c *Client) SendPrompt(ctx context.Context, sessionID string, text string) error {
	body := map[string]any{
		"parts": []map[string]string{{
			"type": "text",
			"text": text,
		}},
	}
	return c.doSessionJSON(ctx, sessionID, http.MethodPost, "/session/"+url.PathEscape(sessionID)+"/prompt_async", body, nil)
}

func (c *Client) ListSessions(ctx context.Context, limit int) ([]bridge.Session, error) {
	if limit < 0 {
		limit = 5
	}
	var raw []struct {
		ID        string `json:"id"`
		Title     string `json:"title"`
		ParentID  string `json:"parentID"`
		Directory string `json:"directory"`
	}
	path := "/experimental/session?sort=updated"
	if c.defaultDirectory != "" {
		path = "/experimental/session?directory=" + url.QueryEscape(c.defaultDirectory) + "&sort=updated"
	}
	if limit > 0 {
		path = fmt.Sprintf("%s&limit=%d", path, limit)
	}
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &raw); err != nil {
		return nil, err
	}
	sessions := make([]bridge.Session, 0, len(raw))
	for _, item := range raw {
		if item.Directory == "" {
			item.Directory = c.defaultDirectory
		}
		session := bridge.Session{ID: item.ID, Title: item.Title, ParentID: item.ParentID, Directory: item.Directory}
		c.rememberSession(session)
		sessions = append(sessions, session)
	}
	return sessions, nil
}

func (c *Client) AbortSession(ctx context.Context, sessionID string) (bool, error) {
	var aborted bool
	err := c.doSessionJSON(ctx, sessionID, http.MethodPost, "/session/"+url.PathEscape(sessionID)+"/abort", nil, &aborted)
	return aborted, err
}

func (c *Client) ReplyPermission(ctx context.Context, permission bridge.PendingPermission, reply bridge.PermissionReply) error {
	body := map[string]any{"reply": reply.Reply}
	if reply.Message != "" {
		body["message"] = reply.Message
	}
	directory := permission.Directory
	if directory == "" {
		var err error
		directory, err = c.directoryForSession(ctx, permission.SessionID)
		if err != nil {
			return err
		}
	}
	return c.doJSONWithDirectory(ctx, directory, http.MethodPost, "/permission/"+url.PathEscape(permission.ID)+"/reply", body, nil)
}

func (c *Client) SubmitQuestion(ctx context.Context, pending bridge.PendingQuestion, answers [][]string) error {
	body := map[string]any{
		"kind":      "submit",
		"messageID": pending.MessageID,
		"callID":    pending.CallID,
		"payload": map[string]any{
			"answers": answers,
		},
	}
	directory := pending.Directory
	if directory == "" {
		var err error
		directory, err = c.directoryForSession(ctx, pending.SessionID)
		if err != nil {
			return err
		}
	}
	return c.doJSONWithDirectory(ctx, directory, http.MethodPost, "/session/"+url.PathEscape(pending.SessionID)+"/tool/respond", body, nil)
}

func (c *Client) ListPermissions(ctx context.Context) ([]bridge.PendingPermission, error) {
	permissions := []bridge.PendingPermission{}
	for _, directory := range c.knownDirectories() {
		var raw []struct {
			ID         string   `json:"id"`
			SessionID  string   `json:"sessionID"`
			Permission string   `json:"permission"`
			Patterns   []string `json:"patterns"`
		}
		if err := c.doJSONWithDirectory(ctx, directory, http.MethodGet, "/permission", nil, &raw); err != nil {
			if !canSkipHydrationDirectoryError(ctx, err) {
				return nil, err
			}
			slog.Warn("remote bridge could not list permissions", "directory", directory, "error", err)
			continue
		}
		for _, item := range raw {
			permissions = append(permissions, bridge.PendingPermission{
				ID:         item.ID,
				SessionID:  item.SessionID,
				Permission: item.Permission,
				Patterns:   item.Patterns,
				Directory:  directory,
			})
		}
	}
	return permissions, nil
}

func (c *Client) ListQuestions(ctx context.Context) ([]bridge.PendingQuestion, error) {
	questions := []bridge.PendingQuestion{}
	for _, directory := range c.knownDirectories() {
		var raw []json.RawMessage
		if err := c.doJSONWithDirectory(ctx, directory, http.MethodGet, "/external-result", nil, &raw); err != nil {
			if !canSkipHydrationDirectoryError(ctx, err) {
				return nil, err
			}
			slog.Warn("remote bridge could not list questions", "directory", directory, "error", err)
			continue
		}
		for _, data := range raw {
			question, ok, _, _, err := questionUpdateFromEvent(data, directory)
			if err != nil {
				return nil, err
			}
			if ok {
				questions = append(questions, question)
			}
		}
	}
	return questions, nil
}

// canSkipHydrationDirectoryError reports whether a per-directory hydration
// failure is transient enough to skip and continue. Only explicitly transient
// signals qualify — request timeouts, rate limits, 5xx, and network/deadline
// timeouts. Anything else (JSON decode, schema/protocol errors) surfaces, since
// silently dropping it would hide pending permissions or questions. If the
// caller's own context is already done, that is a whole-operation cancel/
// deadline, not a per-directory blip — surface it instead of returning a
// partial-success hydration.
func canSkipHydrationDirectoryError(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	var status *HTTPStatusError
	if errors.As(err, &status) {
		return status.StatusCode == http.StatusRequestTimeout ||
			status.StatusCode == http.StatusTooManyRequests ||
			status.StatusCode >= 500
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func (c *Client) doJSON(ctx context.Context, method string, path string, input any, output any) error {
	return c.doJSONWithDirectory(ctx, "", method, path, input, output)
}

func (c *Client) doSessionJSON(ctx context.Context, sessionID string, method string, path string, input any, output any) error {
	directory, err := c.directoryForSession(ctx, sessionID)
	if err != nil {
		return err
	}
	return c.doJSONWithDirectory(ctx, directory, method, path, input, output)
}

func (c *Client) doJSONWithDirectory(ctx context.Context, directory string, method string, path string, input any, output any) error {
	// Bound every JSON request so a stalled sidecar cannot hang startup/hydration.
	// The SSE stream (StreamEvents) builds its own request and is intentionally exempt.
	if c.jsonTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.jsonTimeout)
		defer cancel()
	}
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	if input != nil {
		req.Header.Set("content-type", "application/json")
	}
	if directory != "" {
		req.Header.Set("x-opencode-directory", directory)
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
			Method:     method,
			Path:       path,
			Status:     res.Status,
			StatusCode: res.StatusCode,
			Body:       strings.TrimSpace(string(data)),
		}
	}
	if output == nil {
		io.Copy(io.Discard, res.Body)
		return nil
	}
	return json.NewDecoder(res.Body).Decode(output)
}

func (c *Client) directoryForSession(ctx context.Context, sessionID string) (string, error) {
	if sessionID == "" {
		return c.defaultDirectory, nil
	}
	c.mu.Lock()
	directory := c.sessionDirectories[sessionID]
	c.mu.Unlock()
	if directory != "" {
		return directory, nil
	}
	var session struct {
		ID        string `json:"id"`
		Directory string `json:"directory"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/session/"+url.PathEscape(sessionID), nil, &session); err != nil {
		return "", err
	}
	c.rememberSession(bridge.Session{ID: session.ID, Directory: session.Directory})
	if session.Directory != "" {
		return session.Directory, nil
	}
	return c.defaultDirectory, nil
}

func (c *Client) rememberSession(session bridge.Session) {
	if session.ID == "" || session.Directory == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sessionDirectories[session.ID] = session.Directory
}

func (c *Client) knownDirectories() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	seen := make(map[string]bool, len(c.sessionDirectories)+1)
	directories := []string{}
	if c.defaultDirectory != "" {
		seen[c.defaultDirectory] = true
		directories = append(directories, c.defaultDirectory)
	}
	// Sort the map-derived directories so hydration visits them in a stable
	// order; ranging a map directly is randomized and makes ordering flaky.
	extra := []string{}
	for _, directory := range c.sessionDirectories {
		if directory == "" || seen[directory] {
			continue
		}
		seen[directory] = true
		extra = append(extra, directory)
	}
	slices.Sort(extra)
	directories = append(directories, extra...)
	if len(directories) == 0 {
		return []string{""}
	}
	return directories
}

func (c *Client) authorize(req *http.Request) {
	if c.username == "" && c.password == "" {
		return
	}
	username := c.username
	if username == "" {
		username = "opencode"
	}
	req.SetBasicAuth(username, c.password)
}
