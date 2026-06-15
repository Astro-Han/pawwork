package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type MemorySessionPointers struct {
	mu          sync.Mutex
	sessions    map[string]string
	parents     map[string]string
	eventCursor string
}

func NewMemorySessionPointers() *MemorySessionPointers {
	return &MemorySessionPointers{
		sessions: make(map[string]string),
		parents:  make(map[string]string),
	}
}

func (p *MemorySessionPointers) Get(remoteKey string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sessions[remoteKey]
}

func (p *MemorySessionPointers) Set(remoteKey string, sessionID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.hasRootConflictLocked(remoteKey, sessionID) {
		return fmt.Errorf("session root is already bound to another remote conversation")
	}
	p.sessions[remoteKey] = sessionID
	return nil
}

func (p *MemorySessionPointers) SetParent(sessionID string, parentID string) error {
	if sessionID == "" || parentID == "" {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if hasAnyRootConflict(p.sessions, withParent(p.parents, sessionID, parentID)) {
		return fmt.Errorf("session root is already bound to another remote conversation")
	}
	p.parents[sessionID] = parentID
	return nil
}

func (p *MemorySessionPointers) RemoteKeyForSession(sessionID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	keys := p.remoteKeysForRootLocked(p.rootLocked(sessionID))
	if len(keys) != 1 {
		return ""
	}
	return keys[0]
}

func (p *MemorySessionPointers) RootSession(sessionID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.rootLocked(sessionID)
}

func (p *MemorySessionPointers) EventCursor() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.eventCursor
}

func (p *MemorySessionPointers) SetEventCursor(cursor string) error {
	if cursor == "" {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.eventCursor = cursor
	return nil
}

func (p *MemorySessionPointers) rootLocked(sessionID string) string {
	return rootSession(p.parents, sessionID)
}

func (p *MemorySessionPointers) hasRootConflictLocked(remoteKey string, sessionID string) bool {
	return hasRootConflict(p.sessions, p.parents, remoteKey, sessionID)
}

func (p *MemorySessionPointers) remoteKeysForRootLocked(root string) []string {
	return remoteKeysForRoot(p.sessions, p.parents, root)
}

type FileSessionPointers struct {
	mu          sync.Mutex
	path        string
	sessions    map[string]string
	parents     map[string]string
	eventCursor string
}

func NewFileSessionPointers(path string) (*FileSessionPointers, error) {
	pointers := &FileSessionPointers{
		path:     path,
		sessions: make(map[string]string),
		parents:  make(map[string]string),
	}
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

func (p *FileSessionPointers) Get(remoteKey string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sessions[remoteKey]
}

func (p *FileSessionPointers) Set(remoteKey string, sessionID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.hasRootConflictLocked(remoteKey, sessionID) {
		return fmt.Errorf("session root is already bound to another remote conversation")
	}
	p.sessions[remoteKey] = sessionID
	return p.saveLocked()
}

func (p *FileSessionPointers) SetParent(sessionID string, parentID string) error {
	if sessionID == "" || parentID == "" {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if hasAnyRootConflict(p.sessions, withParent(p.parents, sessionID, parentID)) {
		return fmt.Errorf("session root is already bound to another remote conversation")
	}
	p.parents[sessionID] = parentID
	return p.saveLocked()
}

func (p *FileSessionPointers) RemoteKeyForSession(sessionID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	keys := p.remoteKeysForRootLocked(p.rootLocked(sessionID))
	if len(keys) != 1 {
		return ""
	}
	return keys[0]
}

func (p *FileSessionPointers) RootSession(sessionID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.rootLocked(sessionID)
}

func (p *FileSessionPointers) EventCursor() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.eventCursor
}

func (p *FileSessionPointers) SetEventCursor(cursor string) error {
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

func (p *FileSessionPointers) rootLocked(sessionID string) string {
	return rootSession(p.parents, sessionID)
}

func (p *FileSessionPointers) hasRootConflictLocked(remoteKey string, sessionID string) bool {
	return hasRootConflict(p.sessions, p.parents, remoteKey, sessionID)
}

func (p *FileSessionPointers) remoteKeysForRootLocked(root string) []string {
	return remoteKeysForRoot(p.sessions, p.parents, root)
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

func (p *FileSessionPointers) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
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
	tempPath := p.path + ".tmp"
	if err := os.WriteFile(tempPath, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tempPath, p.path)
}
