package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// SessionPointersStore maps remote conversations to PawWork sessions and tracks
// the event cursor. With a non-empty path it persists to disk; an empty path
// keeps everything in memory.
type SessionPointersStore struct {
	mu          sync.Mutex
	path        string
	sessions    map[string]string
	parents     map[string]string
	eventCursor string
}

func NewMemorySessionPointers() *SessionPointersStore {
	return newSessionPointers("")
}

func NewFileSessionPointers(path string) (*SessionPointersStore, error) {
	pointers := newSessionPointers(path)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return pointers, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return pointers, nil
	}
	var state struct {
		Sessions    map[string]string `json:"sessions"`
		Parents     map[string]string `json:"parents"`
		EventCursor string            `json:"eventCursor"`
	}
	if err := json.Unmarshal(data, &state); err == nil && (state.Sessions != nil || state.Parents != nil || state.EventCursor != "") {
		if state.Sessions != nil {
			pointers.sessions = state.Sessions
		}
		if state.Parents != nil {
			pointers.parents = state.Parents
		}
		pointers.eventCursor = state.EventCursor
		return pointers, nil
	}
	if err := json.Unmarshal(data, &pointers.sessions); err != nil {
		return nil, err
	}
	return pointers, nil
}

func newSessionPointers(path string) *SessionPointersStore {
	return &SessionPointersStore{
		path:     path,
		sessions: make(map[string]string),
		parents:  make(map[string]string),
	}
}

func (p *SessionPointersStore) Get(remoteKey string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sessions[remoteKey]
}

func (p *SessionPointersStore) Set(remoteKey string, sessionID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if hasRootConflict(p.sessions, p.parents, remoteKey, sessionID) {
		return fmt.Errorf("session root is already bound to another remote conversation")
	}
	p.sessions[remoteKey] = sessionID
	return p.saveLocked()
}

func (p *SessionPointersStore) SetParent(sessionID string, parentID string) error {
	if sessionID == "" || parentID == "" {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if parentChainReaches(p.parents, parentID, sessionID) {
		return fmt.Errorf("session parent would create a cycle")
	}
	if hasAnyRootConflict(p.sessions, withParent(p.parents, sessionID, parentID)) {
		return fmt.Errorf("session root is already bound to another remote conversation")
	}
	p.parents[sessionID] = parentID
	return p.saveLocked()
}

func (p *SessionPointersStore) RemoteKeyForSession(sessionID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	keys := remoteKeysForRoot(p.sessions, p.parents, rootSession(p.parents, sessionID))
	if len(keys) != 1 {
		return ""
	}
	return keys[0]
}

func (p *SessionPointersStore) RootSession(sessionID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return rootSession(p.parents, sessionID)
}

func (p *SessionPointersStore) EventCursor() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.eventCursor
}

func (p *SessionPointersStore) SetEventCursor(cursor string) error {
	if cursor == "" {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.eventCursor == cursor {
		return nil
	}
	p.eventCursor = cursor
	return p.saveLocked()
}

func (p *SessionPointersStore) saveLocked() error {
	if p.path == "" {
		return nil
	}
	dir := filepath.Dir(p.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(struct {
		Sessions    map[string]string `json:"sessions"`
		Parents     map[string]string `json:"parents"`
		EventCursor string            `json:"eventCursor,omitempty"`
	}{
		Sessions:    p.sessions,
		Parents:     p.parents,
		EventCursor: p.eventCursor,
	}, "", "  ")
	if err != nil {
		return err
	}
	// Write through a unique temp file so a second process sharing this path
	// cannot clobber a fixed <path>.tmp mid-write. Each writer renames its own
	// complete snapshot into place; the deferred remove cleans up on error and
	// is a no-op once the rename succeeds.
	temp, err := os.CreateTemp(dir, filepath.Base(p.path)+".*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, p.path)
}

func rootSession(parents map[string]string, sessionID string) string {
	if sessionID == "" {
		return ""
	}
	seen := map[string]bool{}
	current := sessionID
	for current != "" && !seen[current] {
		seen[current] = true
		parent := parents[current]
		if parent == "" {
			return current
		}
		current = parent
	}
	return sessionID
}

// parentChainReaches reports whether walking the parent chain from start ever
// lands on target. SetParent uses it to reject a parentID whose ancestry
// already contains the child, which would otherwise form a cycle.
func parentChainReaches(parents map[string]string, start string, target string) bool {
	seen := map[string]bool{}
	for current := start; current != "" && !seen[current]; current = parents[current] {
		if current == target {
			return true
		}
		seen[current] = true
	}
	return false
}

func hasRootConflict(sessions map[string]string, parents map[string]string, remoteKey string, sessionID string) bool {
	root := rootSession(parents, sessionID)
	if root == "" {
		return false
	}
	for currentKey, currentSession := range sessions {
		if currentKey != remoteKey && rootSession(parents, currentSession) == root {
			return true
		}
	}
	return false
}

func hasAnyRootConflict(sessions map[string]string, parents map[string]string) bool {
	seen := map[string]string{}
	for remoteKey, sessionID := range sessions {
		root := rootSession(parents, sessionID)
		if root == "" {
			continue
		}
		if current := seen[root]; current != "" && current != remoteKey {
			return true
		}
		seen[root] = remoteKey
	}
	return false
}

func withParent(parents map[string]string, sessionID string, parentID string) map[string]string {
	next := make(map[string]string, len(parents)+1)
	for key, value := range parents {
		next[key] = value
	}
	next[sessionID] = parentID
	return next
}

func remoteKeysForRoot(sessions map[string]string, parents map[string]string, root string) []string {
	if root == "" {
		return nil
	}
	var keys []string
	for remoteKey, current := range sessions {
		if rootSession(parents, current) == root {
			keys = append(keys, remoteKey)
		}
	}
	return keys
}
