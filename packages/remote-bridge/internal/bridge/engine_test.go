package bridge

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/chenhg5/cc-connect/core"
)

type fakeSidecar struct {
	created           []string
	prompts           []sentPrompt
	sessions          []Session
	permissionReplies []permissionReply
	questionReplies   []questionReply
	aborted           bool
}

type sentPrompt struct {
	sessionID string
	text      string
}

type permissionReply struct {
	pending PendingPermission
	reply   PermissionReply
}

type questionReply struct {
	pending PendingQuestion
	answers [][]string
}

func (f *fakeSidecar) CreateSession(context.Context) (string, error) {
	id := "ses_new"
	if len(f.created) > 0 {
		id = "ses_new_2"
	}
	f.created = append(f.created, id)
	return id, nil
}

func (f *fakeSidecar) SendPrompt(_ context.Context, sessionID string, text string) error {
	f.prompts = append(f.prompts, sentPrompt{sessionID: sessionID, text: text})
	return nil
}

func (f *fakeSidecar) ListSessions(context.Context, int) ([]Session, error) {
	return f.sessions, nil
}

func (f *fakeSidecar) AbortSession(context.Context, string) (bool, error) {
	return f.aborted, nil
}

func (f *fakeSidecar) ReplyPermission(_ context.Context, pending PendingPermission, reply PermissionReply) error {
	f.permissionReplies = append(f.permissionReplies, permissionReply{pending: pending, reply: reply})
	return nil
}

func (f *fakeSidecar) SubmitQuestion(_ context.Context, pending PendingQuestion, answers [][]string) error {
	f.questionReplies = append(f.questionReplies, questionReply{pending: pending, answers: answers})
	return nil
}

type fakePlatform struct {
	name           string
	replies        []string
	sends          []string
	reconstructKey string
	replyFailures  int
	replyCalls     int
}

func (f *fakePlatform) Name() string {
	if f.name != "" {
		return f.name
	}
	return "chat"
}
func (f *fakePlatform) Start(core.MessageHandler) error { return nil }
func (f *fakePlatform) Reply(_ context.Context, _ any, content string) error {
	f.replyCalls++
	if f.replyFailures > 0 {
		f.replyFailures--
		return errors.New("transient delivery failure")
	}
	f.replies = append(f.replies, content)
	return nil
}
func (f *fakePlatform) Send(_ context.Context, _ any, content string) error {
	f.sends = append(f.sends, content)
	return nil
}
func (f *fakePlatform) ReconstructReplyCtx(sessionKey string) (any, error) {
	f.reconstructKey = sessionKey
	return "restored-reply-context", nil
}
func (f *fakePlatform) Stop() error { return nil }

func TestEngineStartsAndContinuesCurrentSession(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)

	msg := &core.Message{SessionKey: "feishu:chat:alice", Content: "/new"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if len(sidecar.created) != 1 {
		t.Fatalf("created sessions = %#v", sidecar.created)
	}

	msg.Content = "continue this"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if len(sidecar.prompts) != 1 {
		t.Fatalf("prompts = %#v", sidecar.prompts)
	}
	if sidecar.prompts[0] != (sentPrompt{sessionID: "ses_new", text: "continue this"}) {
		t.Fatalf("prompt = %#v", sidecar.prompts[0])
	}
}

func TestEngineRepliesToNewSessionCommandEvents(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "feishu:chat:alice", Content: "/new", ReplyCtx: "reply-ctx"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if err := engine.HandleAssistantText(context.Background(), "ses_new", "new session is ready"); err != nil {
		t.Fatal(err)
	}

	if got := platform.replies[len(platform.replies)-1]; got != "new session is ready" {
		t.Fatalf("reply = %q, replies = %#v", got, platform.replies)
	}
}

func TestEngineSendsUnknownSlashTextAsPrompt(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "/src/main.go"}

	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if len(sidecar.prompts) != 1 || sidecar.prompts[0] != (sentPrompt{sessionID: "ses_new", text: "/src/main.go"}) {
		t.Fatalf("prompts = %#v", sidecar.prompts)
	}
	if len(platform.replies) != 0 {
		t.Fatalf("unknown slash text was treated as command: %#v", platform.replies)
	}
}

func TestEngineListsAndSwitchesRecentSessions(t *testing.T) {
	sidecar := &fakeSidecar{
		sessions: []Session{
			{ID: "ses_a", Title: "Plan launch"},
			{ID: "ses_b", Title: "Fix importer"},
		},
	}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:bob", Content: "/sessions"}

	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if len(platform.replies) != 1 || platform.replies[0] != "Recent PawWork sessions:\n1. Plan launch\n2. Fix importer\n\nSwitch with /sessions 2." {
		t.Fatalf("list reply = %#v", platform.replies)
	}

	msg.Content = "/sessions 2"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if got := engine.CurrentSession("slack:dm:bob"); got != "ses_b" {
		t.Fatalf("current session = %q", got)
	}

	msg.Content = "use this session"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if sidecar.prompts[0] != (sentPrompt{sessionID: "ses_b", text: "use this session"}) {
		t.Fatalf("prompt = %#v", sidecar.prompts[0])
	}
}

func TestEngineRejectsSwitchingToChildOfAnotherRemoteRoot(t *testing.T) {
	sidecar := &fakeSidecar{
		sessions: []Session{
			{ID: "ses_root", Title: "Root"},
			{ID: "ses_child", Title: "Child", ParentID: "ses_root"},
		},
	}
	engine := New(sidecar)
	slack := &fakePlatform{name: "slack"}
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "/sessions"}
	if err := engine.HandleMessage(context.Background(), slack, msg); err != nil {
		t.Fatal(err)
	}
	msg.Content = "/sessions 1"
	if err := engine.HandleMessage(context.Background(), slack, msg); err != nil {
		t.Fatal(err)
	}

	feishu := &fakePlatform{name: "feishu"}
	msg = &core.Message{SessionKey: "feishu:chat:ops", Content: "/sessions"}
	if err := engine.HandleMessage(context.Background(), feishu, msg); err != nil {
		t.Fatal(err)
	}
	msg.Content = "/sessions 2"
	if err := engine.HandleMessage(context.Background(), feishu, msg); err == nil {
		t.Fatal("expected switching to a child of another remote root to fail")
	}

	if got := engine.CurrentSession("feishu:chat:ops"); got != "" {
		t.Fatalf("feishu current session = %q", got)
	}
	if got := feishu.replies[len(feishu.replies)-1]; got != "PawWork could not remember the session: session root is already bound to another remote conversation" {
		t.Fatalf("reply = %q", got)
	}
}

func TestEngineRepliesToSwitchedSessionEvents(t *testing.T) {
	sidecar := &fakeSidecar{
		sessions: []Session{
			{ID: "ses_a", Title: "Plan launch"},
			{ID: "ses_b", Title: "Fix importer"},
		},
	}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:bob", Content: "/sessions"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	msg.Content = "/sessions 2"
	msg.ReplyCtx = "switch-reply-ctx"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if err := engine.HandleAssistantText(context.Background(), "ses_b", "switched session completed"); err != nil {
		t.Fatal(err)
	}

	if got := platform.replies[len(platform.replies)-1]; got != "switched session completed" {
		t.Fatalf("reply = %q, replies = %#v", got, platform.replies)
	}
}

func TestEngineRoutesPendingPermissionRepliesBeforePrompts(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "weixin:user:alice", Content: "/new"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	engine.SetPendingPermission(PendingPermission{
		ID:         "perm_1",
		SessionID:  "ses_new",
		Permission: "edit",
		Patterns:   []string{"/repo/app.ts"},
	})

	msg.Content = "yes"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if len(sidecar.permissionReplies) != 1 {
		t.Fatalf("permission replies = %#v", sidecar.permissionReplies)
	}
	gotPermission := sidecar.permissionReplies[0]
	if gotPermission.pending.ID != "perm_1" ||
		gotPermission.pending.SessionID != "ses_new" ||
		gotPermission.pending.Permission != "edit" ||
		len(gotPermission.pending.Patterns) != 1 ||
		gotPermission.pending.Patterns[0] != "/repo/app.ts" ||
		gotPermission.reply != (PermissionReply{Reply: "once"}) {
		t.Fatalf("permission reply = %#v", sidecar.permissionReplies[0])
	}
	if len(sidecar.prompts) != 0 {
		t.Fatalf("permission answer became prompt: %#v", sidecar.prompts)
	}
}

func TestEngineRoutesPendingQuestionAnswersBeforePrompts(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "/new"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	pending := PendingQuestion{
		SessionID: "ses_new",
		MessageID: "msg_1",
		CallID:    "call_1",
		Questions: []Question{{
			Question: "Pick one",
			Options:  []QuestionOption{{Label: "A"}, {Label: "B"}},
		}},
	}
	engine.SetPendingQuestion(pending)

	msg.Content = "2"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if len(sidecar.questionReplies) != 1 {
		t.Fatalf("question replies = %#v", sidecar.questionReplies)
	}
	if sidecar.questionReplies[0].pending.SessionID != pending.SessionID ||
		sidecar.questionReplies[0].pending.MessageID != pending.MessageID ||
		sidecar.questionReplies[0].pending.CallID != pending.CallID {
		t.Fatalf("pending = %#v", sidecar.questionReplies[0].pending)
	}
	if got := sidecar.questionReplies[0].answers; len(got) != 1 || len(got[0]) != 1 || got[0][0] != "B" {
		t.Fatalf("answers = %#v", got)
	}
	if len(sidecar.prompts) != 0 {
		t.Fatalf("question answer became prompt: %#v", sidecar.prompts)
	}
}

func TestEngineStopsCurrentRun(t *testing.T) {
	sidecar := &fakeSidecar{aborted: true}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "telegram:alice", Content: "/new"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	msg.Content = "/stop"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if got := platform.replies[len(platform.replies)-1]; got != "Stopped the current PawWork run." {
		t.Fatalf("stop reply = %q", got)
	}
}

func TestEnginePersistsCurrentSessionPointer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")
	store, err := NewFileSessionPointers(path)
	if err != nil {
		t.Fatal(err)
	}

	platform := &fakePlatform{}
	engine := NewWithSessionPointers(&fakeSidecar{}, store)
	msg := &core.Message{SessionKey: "feishu:chat:alice", Content: "/new"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	reloaded, err := NewFileSessionPointers(path)
	if err != nil {
		t.Fatal(err)
	}
	sidecar := &fakeSidecar{}
	engine = NewWithSessionPointers(sidecar, reloaded)
	msg.Content = "continue here"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if len(sidecar.created) != 0 {
		t.Fatalf("created sessions = %#v", sidecar.created)
	}
	if len(sidecar.prompts) != 1 || sidecar.prompts[0] != (sentPrompt{sessionID: "ses_new", text: "continue here"}) {
		t.Fatalf("prompts = %#v", sidecar.prompts)
	}
}

func TestEngineRepliesToActiveConversationEvents(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "what changed?"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if err := engine.HandleAssistantText(context.Background(), "ses_new", "A small fix landed."); err != nil {
		t.Fatal(err)
	}

	if got := platform.replies[len(platform.replies)-1]; got != "A small fix landed." {
		t.Fatalf("reply = %q", got)
	}
}

func TestEngineRestoresReplyTargetAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")
	store, err := NewFileSessionPointers(path)
	if err != nil {
		t.Fatal(err)
	}

	firstPlatform := &fakePlatform{name: "slack"}
	firstEngine := NewWithSessionPointers(&fakeSidecar{}, store)
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "start work"}
	if err := firstEngine.HandleMessage(context.Background(), firstPlatform, msg); err != nil {
		t.Fatal(err)
	}

	reloaded, err := NewFileSessionPointers(path)
	if err != nil {
		t.Fatal(err)
	}
	secondPlatform := &fakePlatform{name: "slack"}
	secondEngine := NewWithSessionPointers(&fakeSidecar{}, reloaded)
	secondEngine.RegisterPlatform(secondPlatform)
	if err := secondEngine.HandleAssistantText(context.Background(), "ses_new", "finished after restart"); err != nil {
		t.Fatal(err)
	}

	if secondPlatform.reconstructKey != "slack:dm:alice" {
		t.Fatalf("reconstruct key = %q", secondPlatform.reconstructKey)
	}
	if len(secondPlatform.sends) != 1 || secondPlatform.sends[0] != "finished after restart" {
		t.Fatalf("sends = %#v", secondPlatform.sends)
	}
	if len(secondPlatform.replies) != 0 {
		t.Fatalf("restored target used Reply: %#v", secondPlatform.replies)
	}
}

func TestEngineSurfacesPendingPermissionEvents(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "weixin:user:alice", Content: "edit the file"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if err := engine.HandlePermission(context.Background(), PendingPermission{
		ID:         "perm_1",
		SessionID:  "ses_new",
		Permission: "edit",
		Patterns:   []string{"/repo/app.ts"},
	}); err != nil {
		t.Fatal(err)
	}

	if got := platform.replies[len(platform.replies)-1]; got != "PawWork asks permission: edit\n/repo/app.ts\n\nReply yes, always, or no." {
		t.Fatalf("permission prompt = %q", got)
	}

	msg.Content = "always"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if sidecar.permissionReplies[0].reply.Reply != "always" {
		t.Fatalf("permission reply = %#v", sidecar.permissionReplies)
	}
}

func TestEngineRoutesChildSessionPermissionThroughRootConversation(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "delegate this"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if err := engine.RegisterSession(Session{ID: "child_1", ParentID: "ses_new"}); err != nil {
		t.Fatal(err)
	}

	if err := engine.HandlePermission(context.Background(), PendingPermission{
		ID:         "perm_child",
		SessionID:  "child_1",
		Permission: "edit",
		Patterns:   []string{"/repo/child.ts"},
	}); err != nil {
		t.Fatal(err)
	}

	if got := platform.replies[len(platform.replies)-1]; got != "PawWork asks permission: edit\n/repo/child.ts\n\nReply yes, always, or no." {
		t.Fatalf("permission prompt = %q", got)
	}

	msg.Content = "yes"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if len(sidecar.permissionReplies) != 1 || sidecar.permissionReplies[0].pending.ID != "perm_child" {
		t.Fatalf("permission replies = %#v", sidecar.permissionReplies)
	}
	if len(sidecar.prompts) != 1 {
		t.Fatalf("permission answer became prompt: %#v", sidecar.prompts)
	}

	msg.Content = "continue after permission"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if len(sidecar.prompts) != 2 || sidecar.prompts[1] != (sentPrompt{sessionID: "ses_new", text: "continue after permission"}) {
		t.Fatalf("next prompt after permission = %#v", sidecar.prompts)
	}
}

func TestEngineAnswersPendingPermissionsInArrivalOrder(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "start"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	for _, permission := range []PendingPermission{
		{ID: "perm_first", SessionID: "ses_new", Permission: "edit", Patterns: []string{"/repo/a.ts"}},
		{ID: "perm_second", SessionID: "ses_new", Permission: "edit", Patterns: []string{"/repo/b.ts"}},
	} {
		if err := engine.HandlePermission(context.Background(), permission); err != nil {
			t.Fatal(err)
		}
	}

	msg.Content = "yes"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	msg.Content = "no"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if len(sidecar.permissionReplies) != 2 {
		t.Fatalf("permission replies = %#v", sidecar.permissionReplies)
	}
	if sidecar.permissionReplies[0].pending.ID != "perm_first" || sidecar.permissionReplies[1].pending.ID != "perm_second" {
		t.Fatalf("permission reply order = %#v", sidecar.permissionReplies)
	}
}

func TestEngineRestoresChildSessionDeliveryAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")
	store, err := NewFileSessionPointers(path)
	if err != nil {
		t.Fatal(err)
	}
	firstEngine := NewWithSessionPointers(&fakeSidecar{}, store)
	if err := firstEngine.setCurrent("slack:dm:alice", "ses_root"); err != nil {
		t.Fatal(err)
	}
	if err := firstEngine.RegisterSession(Session{ID: "ses_child", ParentID: "ses_root"}); err != nil {
		t.Fatal(err)
	}

	reloaded, err := NewFileSessionPointers(path)
	if err != nil {
		t.Fatal(err)
	}
	platform := &fakePlatform{name: "slack"}
	secondEngine := NewWithSessionPointers(&fakeSidecar{}, reloaded)
	secondEngine.RegisterPlatform(platform)
	if err := secondEngine.HandleAssistantText(context.Background(), "ses_child", "child completed"); err != nil {
		t.Fatal(err)
	}

	if platform.reconstructKey != "slack:dm:alice" {
		t.Fatalf("reconstruct key = %q", platform.reconstructKey)
	}
	if len(platform.sends) != 1 || platform.sends[0] != "child completed" {
		t.Fatalf("sends = %#v", platform.sends)
	}
}

func TestEngineSurfacesPendingQuestionEvents(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "feishu:chat:alice", Content: "plan it"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	pending := PendingQuestion{
		SessionID: "ses_new",
		MessageID: "msg_1",
		CallID:    "call_1",
		Questions: []Question{{
			Header:   "Approach",
			Question: "Which path should I take?",
			Options: []QuestionOption{
				{Label: "A", Description: "Small change"},
				{Label: "B", Description: "Larger cleanup"},
			},
		}},
	}
	if err := engine.HandleQuestion(context.Background(), pending); err != nil {
		t.Fatal(err)
	}

	if got := platform.replies[len(platform.replies)-1]; got != "Approach\nWhich path should I take?\n1. A - Small change\n2. B - Larger cleanup\n\nReply with a number or answer text." {
		t.Fatalf("question prompt = %q", got)
	}
}

func TestEngineMapsMultiSelectNumbersToOptionLabels(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "feishu:chat:alice", Content: "choose"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if err := engine.HandleQuestion(context.Background(), PendingQuestion{
		SessionID: "ses_new",
		MessageID: "msg_1",
		CallID:    "call_1",
		Questions: []Question{{
			Question: "Pick several",
			Multiple: true,
			Options:  []QuestionOption{{Label: "A"}, {Label: "B"}, {Label: "C"}},
		}},
	}); err != nil {
		t.Fatal(err)
	}

	msg.Content = "1, 3"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if len(sidecar.questionReplies) != 1 {
		t.Fatalf("question replies = %#v", sidecar.questionReplies)
	}
	if got := sidecar.questionReplies[0].answers; len(got) != 1 || len(got[0]) != 2 || got[0][0] != "A" || got[0][1] != "C" {
		t.Fatalf("answers = %#v", got)
	}
}

func TestAssistantTextRetriesTransientDeliveryFailure(t *testing.T) {
	defer func(b time.Duration) { deliveryRetryBackoff = b }(deliveryRetryBackoff)
	deliveryRetryBackoff = 0

	// Recovers when the platform fails transiently, then succeeds.
	recovers := &fakePlatform{replyFailures: deliveryAttempts - 1}
	engine := New(&fakeSidecar{})
	if err := engine.HandleMessage(context.Background(), recovers, &core.Message{SessionKey: "slack:dm:a", Content: "hi"}); err != nil {
		t.Fatal(err)
	}
	if err := engine.HandleAssistantText(context.Background(), "ses_new", "answer"); err != nil {
		t.Fatalf("assistant text should recover after retries: %v", err)
	}
	if recovers.replyCalls != deliveryAttempts || len(recovers.replies) != 1 || recovers.replies[0] != "answer" {
		t.Fatalf("calls=%d replies=%#v", recovers.replyCalls, recovers.replies)
	}

	// Gives up after a bounded number of attempts — never holds the cursor.
	keepsFailing := &fakePlatform{replyFailures: deliveryAttempts + 5}
	engine2 := New(&fakeSidecar{})
	if err := engine2.HandleMessage(context.Background(), keepsFailing, &core.Message{SessionKey: "slack:dm:b", Content: "hi"}); err != nil {
		t.Fatal(err)
	}
	if err := engine2.HandleAssistantText(context.Background(), "ses_new", "answer"); err == nil {
		t.Fatal("expected error after bounded retries")
	}
	if keepsFailing.replyCalls != deliveryAttempts {
		t.Fatalf("attempts = %d, want %d", keepsFailing.replyCalls, deliveryAttempts)
	}
}

func TestPermissionAndQuestionPromptsRetryTransientDeliveryFailure(t *testing.T) {
	defer func(b time.Duration) { deliveryRetryBackoff = b }(deliveryRetryBackoff)
	deliveryRetryBackoff = 0

	// A permission prompt recovers when delivery fails transiently then succeeds.
	permPlatform := &fakePlatform{replyFailures: deliveryAttempts - 1}
	permEngine := New(&fakeSidecar{})
	if err := permEngine.HandleMessage(context.Background(), permPlatform, &core.Message{SessionKey: "slack:dm:a", Content: "hi"}); err != nil {
		t.Fatal(err)
	}
	if err := permEngine.HandlePermission(context.Background(), PendingPermission{
		ID: "perm_1", SessionID: "ses_new", Permission: "edit", Patterns: []string{"/repo/app.ts"},
	}); err != nil {
		t.Fatalf("permission prompt should recover after retries: %v", err)
	}
	if permPlatform.replyCalls != deliveryAttempts || len(permPlatform.replies) != 1 {
		t.Fatalf("calls=%d replies=%#v", permPlatform.replyCalls, permPlatform.replies)
	}

	// A question prompt that keeps failing gives up after bounded attempts.
	questionPlatform := &fakePlatform{replyFailures: deliveryAttempts + 5}
	questionEngine := New(&fakeSidecar{})
	if err := questionEngine.HandleMessage(context.Background(), questionPlatform, &core.Message{SessionKey: "slack:dm:b", Content: "hi"}); err != nil {
		t.Fatal(err)
	}
	if err := questionEngine.HandleQuestion(context.Background(), PendingQuestion{
		MessageID: "msg_1", SessionID: "ses_new", Questions: []Question{{
			Question: "Pick one", Options: []QuestionOption{{Label: "A"}, {Label: "B"}},
		}},
	}); err == nil {
		t.Fatal("expected error after bounded retries")
	}
	if questionPlatform.replyCalls != deliveryAttempts {
		t.Fatalf("attempts = %d, want %d", questionPlatform.replyCalls, deliveryAttempts)
	}
}

func TestQuestionPromptHintsMatchType(t *testing.T) {
	single := questionPrompt(PendingQuestion{Questions: []Question{{
		Question: "Pick one",
		Options:  []QuestionOption{{Label: "A"}, {Label: "B"}},
	}}})
	if !strings.HasSuffix(single, "Reply with a number or answer text.") {
		t.Fatalf("single prompt = %q", single)
	}

	multiSelect := questionPrompt(PendingQuestion{Questions: []Question{{
		Question: "Pick several",
		Multiple: true,
		Options:  []QuestionOption{{Label: "A"}, {Label: "B"}},
	}}})
	if !strings.Contains(multiSelect, "separated by commas") {
		t.Fatalf("multi-select prompt = %q", multiSelect)
	}

	multiQuestion := questionPrompt(PendingQuestion{Questions: []Question{
		{Question: "First?"},
		{Question: "Second?"},
	}})
	if !strings.Contains(multiQuestion, "one line per question") {
		t.Fatalf("multi-question prompt = %q", multiQuestion)
	}
}

func TestMultiSelectAcceptsFullWidthAndIdeographicCommas(t *testing.T) {
	pending := PendingQuestion{Questions: []Question{{
		Multiple: true,
		Options:  []QuestionOption{{Label: "A"}, {Label: "B"}, {Label: "C"}},
	}}}
	for _, input := range []string{"1,3", "1，3", "1、3", "1， 3"} {
		answers, err := answersForQuestionText(pending, input)
		if err != nil {
			t.Fatalf("input %q: %v", input, err)
		}
		if len(answers) != 1 || len(answers[0]) != 2 || answers[0][0] != "A" || answers[0][1] != "C" {
			t.Fatalf("input %q answers = %#v", input, answers)
		}
	}
}

func TestEngineAnswersPendingQuestionsInArrivalOrder(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "start"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	for _, question := range []PendingQuestion{
		{
			SessionID: "ses_new",
			MessageID: "msg_1",
			CallID:    "call_1",
			Questions: []Question{{Question: "First?", Options: []QuestionOption{{Label: "A"}, {Label: "B"}}}},
		},
		{
			SessionID: "ses_new",
			MessageID: "msg_2",
			CallID:    "call_2",
			Questions: []Question{{Question: "Second?", Options: []QuestionOption{{Label: "C"}, {Label: "D"}}}},
		},
	} {
		if err := engine.HandleQuestion(context.Background(), question); err != nil {
			t.Fatal(err)
		}
	}

	msg.Content = "1"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	msg.Content = "2"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if len(sidecar.questionReplies) != 2 {
		t.Fatalf("question replies = %#v", sidecar.questionReplies)
	}
	first := sidecar.questionReplies[0]
	second := sidecar.questionReplies[1]
	if first.pending.CallID != "call_1" || first.answers[0][0] != "A" {
		t.Fatalf("first question reply = %#v", first)
	}
	if second.pending.CallID != "call_2" || second.answers[0][0] != "D" {
		t.Fatalf("second question reply = %#v", second)
	}
}

func TestEngineRepliesToLatestVisibleBlocker(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "start"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	if err := engine.HandlePermission(context.Background(), PendingPermission{
		ID:         "perm_1",
		SessionID:  "ses_new",
		Permission: "edit",
		Patterns:   []string{"/repo/app.ts"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := engine.HandleQuestion(context.Background(), PendingQuestion{
		SessionID: "ses_new",
		MessageID: "msg_1",
		CallID:    "call_1",
		Questions: []Question{{Question: "Pick one", Options: []QuestionOption{{Label: "A"}, {Label: "B"}}}},
	}); err != nil {
		t.Fatal(err)
	}

	msg.Content = "2"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if len(sidecar.questionReplies) != 1 || sidecar.questionReplies[0].pending.CallID != "call_1" {
		t.Fatalf("question replies = %#v", sidecar.questionReplies)
	}
	if len(sidecar.permissionReplies) != 0 {
		t.Fatalf("permission replies = %#v", sidecar.permissionReplies)
	}
	if len(sidecar.prompts) != 1 {
		t.Fatalf("question answer became prompt: %#v", sidecar.prompts)
	}
}

func TestEngineClearsPermissionResolvedOutsideRemote(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "start"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	engine.SetPendingPermission(PendingPermission{
		ID:         "perm_1",
		SessionID:  "ses_new",
		Permission: "edit",
		Patterns:   []string{"/repo/app.ts"},
	})

	if err := engine.HandlePermissionResolved(context.Background(), PermissionResolution{
		SessionID: "ses_new",
		RequestID: "perm_1",
	}); err != nil {
		t.Fatal(err)
	}
	msg.Content = "continue after desktop reply"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if len(sidecar.prompts) != 2 || sidecar.prompts[1] != (sentPrompt{sessionID: "ses_new", text: "continue after desktop reply"}) {
		t.Fatalf("prompts = %#v", sidecar.prompts)
	}
}

func TestEngineClearsQuestionResolvedOutsideRemote(t *testing.T) {
	sidecar := &fakeSidecar{}
	platform := &fakePlatform{}
	engine := New(sidecar)
	msg := &core.Message{SessionKey: "slack:dm:alice", Content: "start"}
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}
	engine.SetPendingQuestion(PendingQuestion{
		SessionID: "ses_new",
		MessageID: "msg_1",
		CallID:    "call_1",
		Questions: []Question{{
			Question: "Pick one",
			Options:  []QuestionOption{{Label: "A"}, {Label: "B"}},
		}},
	})

	if err := engine.HandleQuestionResolved(context.Background(), QuestionResolution{
		SessionID: "ses_new",
		MessageID: "msg_1",
		CallID:    "call_1",
	}); err != nil {
		t.Fatal(err)
	}
	msg.Content = "continue after desktop answer"
	if err := engine.HandleMessage(context.Background(), platform, msg); err != nil {
		t.Fatal(err)
	}

	if len(sidecar.prompts) != 2 || sidecar.prompts[1] != (sentPrompt{sessionID: "ses_new", text: "continue after desktop answer"}) {
		t.Fatalf("prompts = %#v", sidecar.prompts)
	}
}
