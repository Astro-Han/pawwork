package bridge

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMemorySessionPointersRejectDuplicateRootBindings(t *testing.T) {
	pointers := NewMemorySessionPointers()
	if err := pointers.Set("slack:dm:alice", "ses_root"); err != nil {
		t.Fatal(err)
	}

	if err := pointers.Set("feishu:chat:ops", "ses_root"); err == nil {
		t.Fatal("expected duplicate root binding to fail")
	}
}

func TestMemorySessionPointersRejectParentThatCreatesDuplicateRoot(t *testing.T) {
	pointers := NewMemorySessionPointers()
	if err := pointers.Set("slack:dm:alice", "ses_root"); err != nil {
		t.Fatal(err)
	}
	if err := pointers.Set("feishu:chat:ops", "ses_child"); err != nil {
		t.Fatal(err)
	}

	if err := pointers.SetParent("ses_child", "ses_root"); err == nil {
		t.Fatal("expected parent binding to reject a duplicate root")
	}
}

func TestMemorySessionPointersRejectParentCycle(t *testing.T) {
	pointers := NewMemorySessionPointers()
	if err := pointers.SetParent("ses_1", "ses_2"); err != nil {
		t.Fatal(err)
	}

	if err := pointers.SetParent("ses_2", "ses_1"); err == nil {
		t.Fatal("expected parent binding to reject a cycle")
	}

	if got := pointers.RootSession("ses_1"); got != "ses_2" {
		t.Fatalf("root after rejected cycle = %q, want ses_2", got)
	}
	if got := pointers.RootSession("ses_2"); got != "ses_2" {
		t.Fatalf("ses_2 should remain its own root, got %q", got)
	}
}

func TestFileSessionPointersDoNotRestoreAmbiguousRootBindings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")
	if err := os.WriteFile(path, []byte(`{
  "sessions": {
    "slack:dm:alice": "ses_root",
    "feishu:chat:ops": "ses_child"
  },
  "parents": {
    "ses_child": "ses_root"
  }
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	pointers, err := NewFileSessionPointers(path)
	if err != nil {
		t.Fatal(err)
	}

	if got := pointers.RemoteKeyForSession("ses_child"); got != "" {
		t.Fatalf("remote key for ambiguous root = %q", got)
	}
}

func TestFileSessionPointersPersistEventCursorWithSessions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")
	pointers, err := NewFileSessionPointers(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := pointers.Set("feishu:dm:alice", "ses_1"); err != nil {
		t.Fatal(err)
	}
	if err := pointers.SetEventCursor("cursor-2"); err != nil {
		t.Fatal(err)
	}

	reloaded, err := NewFileSessionPointers(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Get("feishu:dm:alice"); got != "ses_1" {
		t.Fatalf("session = %q", got)
	}
	if got := reloaded.EventCursor(); got != "cursor-2" {
		t.Fatalf("event cursor = %q", got)
	}
}
