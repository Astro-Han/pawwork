package bridge

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/chenhg5/cc-connect/core"
)

type Prompt struct {
	Text string
}

type Session struct {
	ID        string
	Title     string
	ParentID  string
	Directory string
}

type PendingPermission struct {
	ID         string
	SessionID  string
	Permission string
	Patterns   []string
	Directory  string
}

type PermissionReply struct {
	Reply   string
	Message string
}

type PendingQuestion struct {
	SessionID string
	MessageID string
	CallID    string
	Questions []Question
	Directory string
}

type PermissionResolution struct {
	SessionID string
	RequestID string
	Directory string
}

type QuestionResolution struct {
	SessionID string
	MessageID string
	CallID    string
	Directory string
}

type Question struct {
	Header   string
	Question string
	Options  []QuestionOption
	Multiple bool
}

type QuestionOption struct {
	Label       string
	Description string
}

type Sidecar interface {
	CreateSession(context.Context) (string, error)
	SendPrompt(context.Context, string, Prompt) error
	ListSessions(context.Context, int) ([]Session, error)
	AbortSession(context.Context, string) (bool, error)
	ReplyPermission(context.Context, PendingPermission, PermissionReply) error
	SubmitQuestion(context.Context, PendingQuestion, [][]string) error
}

type SessionPointers interface {
	Get(remoteKey string) string
	Set(remoteKey string, sessionID string) error
	SetParent(sessionID string, parentID string) error
	RemoteKeyForSession(sessionID string) string
	RootSession(sessionID string) string
}

type EventCursorStore interface {
	EventCursor() string
	SetEventCursor(cursor string) error
}

type Engine struct {
	mu              sync.Mutex
	sidecar         Sidecar
	pointers        SessionPointers
	pickers         map[string][]Session
	active          map[string]delivery
	platforms       map[string]core.Platform
	permissions     map[string]PendingPermission
	permissionOrder []string
	questions       map[string]PendingQuestion
	questionOrder   []string
	blockerOrder    []blockerRef
}

type blockerKind string

const (
	permissionBlocker blockerKind = "permission"
	questionBlocker   blockerKind = "question"
)

type blockerRef struct {
	kind blockerKind
	key  string
}

type pendingBlocker struct {
	kind       blockerKind
	permission PendingPermission
	question   PendingQuestion
}

type delivery struct {
	platform  core.Platform
	replyCtx  any
	proactive bool
}

func New(sidecar Sidecar) *Engine {
	return NewWithSessionPointers(sidecar, NewMemorySessionPointers())
}

func NewWithSessionPointers(sidecar Sidecar, pointers SessionPointers) *Engine {
	if pointers == nil {
		pointers = NewMemorySessionPointers()
	}
	return &Engine{
		sidecar:     sidecar,
		pointers:    pointers,
		pickers:     make(map[string][]Session),
		active:      make(map[string]delivery),
		platforms:   make(map[string]core.Platform),
		permissions: make(map[string]PendingPermission),
		questions:   make(map[string]PendingQuestion),
	}
}

func (e *Engine) CurrentSession(remoteKey string) string {
	return e.pointers.Get(remoteKey)
}

func (e *Engine) RegisterPlatform(platform core.Platform) {
	if platform == nil || strings.TrimSpace(platform.Name()) == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.platforms[platform.Name()] = platform
}

func (e *Engine) RegisterSession(session Session) error {
	if session.ID == "" || session.ParentID == "" {
		return nil
	}
	return e.pointers.SetParent(session.ID, session.ParentID)
}

func (e *Engine) SetPendingPermission(permission PendingPermission) {
	if permission.SessionID == "" {
		return
	}
	key := permissionKey(permission)
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.permissions[key]; !ok {
		e.permissionOrder = append(e.permissionOrder, key)
		e.blockerOrder = append(e.blockerOrder, blockerRef{kind: permissionBlocker, key: key})
	}
	e.permissions[key] = permission
}

func (e *Engine) SetPendingQuestion(question PendingQuestion) {
	if question.SessionID == "" {
		return
	}
	key := questionKey(question)
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.questions[key]; !ok {
		e.questionOrder = append(e.questionOrder, key)
		e.blockerOrder = append(e.blockerOrder, blockerRef{kind: questionBlocker, key: key})
	}
	e.questions[key] = question
}

func (e *Engine) HandleMessage(ctx context.Context, platform core.Platform, msg *core.Message) error {
	text := strings.TrimSpace(msg.Content)
	if text == "" {
		return nil
	}
	key := remoteKey(platform, msg)
	if isRemoteCommand(text) {
		return e.handleCommand(ctx, platform, msg, key, text)
	}
	sessionID, err := e.ensureSession(ctx, key)
	if err != nil {
		_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not start a session: "+err.Error())
		return err
	}
	if handled, err := e.handlePendingReply(ctx, platform, msg, sessionID, text); handled || err != nil {
		return err
	}
	if err := e.sidecar.SendPrompt(ctx, sessionID, Prompt{Text: text}); err != nil {
		_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not send the message: "+err.Error())
		return err
	}
	e.setActive(sessionID, platform, msg.ReplyCtx)
	return nil
}

func (e *Engine) HandleAssistantText(ctx context.Context, sessionID string, text string) error {
	if text == "" {
		return nil
	}
	target, ok := e.activeDelivery(sessionID)
	if !ok {
		return nil
	}
	return sendDelivery(ctx, target, text)
}

func (e *Engine) HandlePermission(ctx context.Context, permission PendingPermission) error {
	e.SetPendingPermission(permission)
	return e.replyToActive(ctx, permission.SessionID, permissionPrompt(permission))
}

func (e *Engine) HandleQuestion(ctx context.Context, question PendingQuestion) error {
	e.SetPendingQuestion(question)
	return e.replyToActive(ctx, question.SessionID, questionPrompt(question))
}

func (e *Engine) HandlePermissionResolved(_ context.Context, resolution PermissionResolution) error {
	e.clearResolvedPermission(resolution)
	return nil
}

func (e *Engine) HandleQuestionResolved(_ context.Context, resolution QuestionResolution) error {
	e.clearResolvedQuestion(resolution)
	return nil
}

func (e *Engine) HandleSession(_ context.Context, session Session) error {
	return e.RegisterSession(session)
}

func (e *Engine) replyToActive(ctx context.Context, sessionID string, content string) error {
	target, ok := e.activeDelivery(sessionID)
	if !ok {
		return nil
	}
	return sendDelivery(ctx, target, content)
}

func (e *Engine) setActive(sessionID string, platform core.Platform, replyCtx any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.active[sessionID] = delivery{platform: platform, replyCtx: replyCtx}
}

func (e *Engine) activeDelivery(sessionID string) (delivery, bool) {
	e.mu.Lock()
	target, ok := e.active[sessionID]
	if !ok {
		target, ok = e.active[e.pointers.RootSession(sessionID)]
	}
	e.mu.Unlock()
	if ok {
		return target, true
	}
	return e.restoreDelivery(sessionID)
}

func (e *Engine) restoreDelivery(sessionID string) (delivery, bool) {
	remoteKey := e.pointers.RemoteKeyForSession(sessionID)
	platformName, _, ok := strings.Cut(remoteKey, ":")
	if !ok || platformName == "" {
		return delivery{}, false
	}

	e.mu.Lock()
	platform := e.platforms[platformName]
	e.mu.Unlock()
	reconstructor, ok := platform.(core.ReplyContextReconstructor)
	if !ok {
		return delivery{}, false
	}
	replyCtx, err := reconstructor.ReconstructReplyCtx(remoteKey)
	if err != nil {
		return delivery{}, false
	}
	target := delivery{platform: platform, replyCtx: replyCtx, proactive: true}

	e.mu.Lock()
	defer e.mu.Unlock()
	if current, ok := e.active[sessionID]; ok {
		return current, true
	}
	e.active[sessionID] = target
	return target, true
}

func sendDelivery(ctx context.Context, target delivery, content string) error {
	if target.proactive {
		return target.platform.Send(ctx, target.replyCtx, content)
	}
	return target.platform.Reply(ctx, target.replyCtx, content)
}

func (e *Engine) handlePendingReply(
	ctx context.Context,
	platform core.Platform,
	msg *core.Message,
	sessionID string,
	text string,
) (bool, error) {
	blocker, ok := e.pendingBlocker(sessionID)
	if !ok {
		return false, nil
	}
	if blocker.kind == permissionBlocker {
		permission := blocker.permission
		reply := permissionReplyForText(text)
		if reply == "" {
			return true, platform.Reply(ctx, msg.ReplyCtx, "Reply yes, always, or no.")
		}
		if err := e.sidecar.ReplyPermission(ctx, permission, PermissionReply{Reply: reply}); err != nil {
			_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not answer the permission request: "+err.Error())
			return true, err
		}
		e.clearPendingPermission(permission)
		return true, nil
	}
	if blocker.kind == questionBlocker {
		question := blocker.question
		answers, err := answersForQuestionText(question, text)
		if err != nil {
			return true, platform.Reply(ctx, msg.ReplyCtx, err.Error())
		}
		if err := e.sidecar.SubmitQuestion(ctx, question, answers); err != nil {
			_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not submit the answer: "+err.Error())
			return true, err
		}
		e.clearPendingQuestion(question)
		return true, nil
	}
	return false, nil
}

func isRemoteCommand(text string) bool {
	name, _, _ := strings.Cut(text, " ")
	switch name {
	case "/new", "/sessions", "/stop", "/help":
		return true
	default:
		return false
	}
}

func (e *Engine) pendingBlocker(sessionID string) (pendingBlocker, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	root := e.pointers.RootSession(sessionID)
	for index := len(e.blockerOrder) - 1; index >= 0; index-- {
		ref := e.blockerOrder[index]
		switch ref.kind {
		case permissionBlocker:
			permission, ok := e.permissions[ref.key]
			if !ok || e.pointers.RootSession(permission.SessionID) != root {
				continue
			}
			if pending, ok := e.pendingPermissionLocked(root); ok {
				return pendingBlocker{kind: permissionBlocker, permission: pending}, true
			}
		case questionBlocker:
			question, ok := e.questions[ref.key]
			if !ok || e.pointers.RootSession(question.SessionID) != root {
				continue
			}
			if pending, ok := e.pendingQuestionLocked(root); ok {
				return pendingBlocker{kind: questionBlocker, question: pending}, true
			}
		}
	}
	return pendingBlocker{}, false
}

func (e *Engine) pendingPermissionLocked(root string) (PendingPermission, bool) {
	for _, key := range e.permissionOrder {
		permission, ok := e.permissions[key]
		if !ok {
			continue
		}
		if e.pointers.RootSession(permission.SessionID) == root {
			return permission, true
		}
	}
	return PendingPermission{}, false
}

func (e *Engine) clearPendingPermission(permission PendingPermission) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.clearPermissionKeyLocked(permissionKey(permission))
}

func (e *Engine) clearResolvedPermission(resolution PermissionResolution) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if resolution.RequestID != "" {
		e.clearPermissionKeyLocked(resolution.RequestID)
		return
	}
	if resolution.SessionID != "" {
		e.clearPermissionsLocked(func(permission PendingPermission) bool {
			return permission.SessionID == resolution.SessionID
		})
	}
}

func (e *Engine) clearPermissionKeyLocked(key string) {
	delete(e.permissions, key)
	e.clearPermissionOrderLocked(func(current string) bool {
		return current == key
	})
	e.clearBlockerOrderLocked(func(current blockerRef) bool {
		return current.kind == permissionBlocker && current.key == key
	})
}

func (e *Engine) clearPermissionsLocked(match func(PendingPermission) bool) {
	for key, permission := range e.permissions {
		if match(permission) {
			delete(e.permissions, key)
		}
	}
	e.clearPermissionOrderLocked(func(key string) bool {
		_, ok := e.permissions[key]
		return !ok
	})
	e.clearBlockerOrderLocked(func(current blockerRef) bool {
		if current.kind != permissionBlocker {
			return false
		}
		_, ok := e.permissions[current.key]
		return !ok
	})
}

func (e *Engine) clearPermissionOrderLocked(match func(string) bool) {
	next := e.permissionOrder[:0]
	for _, key := range e.permissionOrder {
		if !match(key) {
			next = append(next, key)
		}
	}
	e.permissionOrder = next
}

func (e *Engine) pendingQuestionLocked(root string) (PendingQuestion, bool) {
	for _, key := range e.questionOrder {
		question, ok := e.questions[key]
		if !ok {
			continue
		}
		if e.pointers.RootSession(question.SessionID) == root {
			return question, true
		}
	}
	return PendingQuestion{}, false
}

func (e *Engine) clearPendingQuestion(question PendingQuestion) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.clearQuestionKeyLocked(questionKey(question))
}

func (e *Engine) clearResolvedQuestion(resolution QuestionResolution) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if resolution.CallID != "" || resolution.MessageID != "" {
		for key, question := range e.questions {
			callMatches := resolution.CallID == "" || question.CallID == resolution.CallID
			messageMatches := resolution.MessageID == "" || question.MessageID == resolution.MessageID
			if callMatches && messageMatches {
				e.clearQuestionKeyLocked(key)
				return
			}
		}
		return
	}
	if resolution.SessionID != "" {
		e.clearQuestionsLocked(func(question PendingQuestion) bool {
			return question.SessionID == resolution.SessionID
		})
	}
}

func (e *Engine) clearQuestionKeyLocked(key string) {
	delete(e.questions, key)
	e.clearQuestionOrderLocked(func(current string) bool {
		return current == key
	})
	e.clearBlockerOrderLocked(func(current blockerRef) bool {
		return current.kind == questionBlocker && current.key == key
	})
}

func (e *Engine) clearQuestionsLocked(match func(PendingQuestion) bool) {
	for key, question := range e.questions {
		if match(question) {
			delete(e.questions, key)
		}
	}
	e.clearQuestionOrderLocked(func(key string) bool {
		_, ok := e.questions[key]
		return !ok
	})
	e.clearBlockerOrderLocked(func(current blockerRef) bool {
		if current.kind != questionBlocker {
			return false
		}
		_, ok := e.questions[current.key]
		return !ok
	})
}

func (e *Engine) clearQuestionOrderLocked(match func(string) bool) {
	next := e.questionOrder[:0]
	for _, key := range e.questionOrder {
		if !match(key) {
			next = append(next, key)
		}
	}
	e.questionOrder = next
}

func (e *Engine) clearBlockerOrderLocked(match func(blockerRef) bool) {
	next := e.blockerOrder[:0]
	for _, current := range e.blockerOrder {
		if !match(current) {
			next = append(next, current)
		}
	}
	e.blockerOrder = next
}

func (e *Engine) handleCommand(ctx context.Context, platform core.Platform, msg *core.Message, key string, text string) error {
	name, arg, _ := strings.Cut(text, " ")
	switch name {
	case "/new":
		sessionID, err := e.sidecar.CreateSession(ctx)
		if err != nil {
			_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not start a session: "+err.Error())
			return err
		}
		if err := e.setCurrent(key, sessionID); err != nil {
			_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not remember the session: "+err.Error())
			return err
		}
		e.setActive(sessionID, platform, msg.ReplyCtx)
		return platform.Reply(ctx, msg.ReplyCtx, "Started a new PawWork session.")
	case "/sessions":
		arg = strings.TrimSpace(arg)
		if arg == "" {
			return e.replySessionPicker(ctx, platform, msg, key)
		}
		return e.switchSession(ctx, platform, msg, key, arg)
	case "/stop":
		sessionID := e.CurrentSession(key)
		if sessionID == "" {
			return platform.Reply(ctx, msg.ReplyCtx, "No active PawWork session.")
		}
		aborted, err := e.sidecar.AbortSession(ctx, sessionID)
		if err != nil {
			_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not stop the run: "+err.Error())
			return err
		}
		if aborted {
			return platform.Reply(ctx, msg.ReplyCtx, "Stopped the current PawWork run.")
		}
		return platform.Reply(ctx, msg.ReplyCtx, "No running PawWork run.")
	case "/help":
		return platform.Reply(ctx, msg.ReplyCtx, "Commands: /new, /sessions, /sessions N, /stop.")
	default:
		return platform.Reply(ctx, msg.ReplyCtx, "Unknown command. Try /help.")
	}
}

func (e *Engine) ensureSession(ctx context.Context, key string) (string, error) {
	if sessionID := e.CurrentSession(key); sessionID != "" {
		return sessionID, nil
	}
	sessionID, err := e.sidecar.CreateSession(ctx)
	if err != nil {
		return "", err
	}
	return sessionID, e.setCurrent(key, sessionID)
}

func (e *Engine) replySessionPicker(ctx context.Context, platform core.Platform, msg *core.Message, key string) error {
	sessions, err := e.sidecar.ListSessions(ctx, 5)
	if err != nil {
		_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not list sessions: "+err.Error())
		return err
	}
	if len(sessions) == 0 {
		e.clearPicker(key)
		return platform.Reply(ctx, msg.ReplyCtx, "No recent PawWork sessions.")
	}
	e.setPicker(key, sessions)
	var out strings.Builder
	out.WriteString("Recent PawWork sessions:")
	for index, session := range sessions {
		out.WriteString("\n")
		out.WriteString(strconv.Itoa(index + 1))
		out.WriteString(". ")
		out.WriteString(sessionLabel(session))
	}
	out.WriteString("\n\nSwitch with /sessions 2.")
	return platform.Reply(ctx, msg.ReplyCtx, out.String())
}

func (e *Engine) switchSession(ctx context.Context, platform core.Platform, msg *core.Message, key string, rawIndex string) error {
	index, err := strconv.Atoi(rawIndex)
	if err != nil || index < 1 {
		return platform.Reply(ctx, msg.ReplyCtx, "Choose a session with /sessions 1.")
	}
	sessions := e.picker(key)
	if len(sessions) == 0 {
		sessions, err = e.sidecar.ListSessions(ctx, 5)
		if err != nil {
			_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not list sessions: "+err.Error())
			return err
		}
	}
	if index > len(sessions) {
		return platform.Reply(ctx, msg.ReplyCtx, fmt.Sprintf("Only %d recent PawWork sessions are available.", len(sessions)))
	}
	session := sessions[index-1]
	if err := e.RegisterSession(session); err != nil {
		_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not remember the session: "+err.Error())
		return err
	}
	if err := e.setCurrent(key, session.ID); err != nil {
		_ = platform.Reply(ctx, msg.ReplyCtx, "PawWork could not remember the session: "+err.Error())
		return err
	}
	e.setActive(session.ID, platform, msg.ReplyCtx)
	return platform.Reply(ctx, msg.ReplyCtx, "Switched to "+sessionLabel(session)+".")
}

func (e *Engine) picker(remoteKey string) []Session {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.pickers[remoteKey]
}

func (e *Engine) setPicker(remoteKey string, sessions []Session) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.pickers[remoteKey] = sessions
}

func (e *Engine) clearPicker(remoteKey string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.pickers, remoteKey)
}

func (e *Engine) setCurrent(remoteKey string, sessionID string) error {
	return e.pointers.Set(remoteKey, sessionID)
}

func sessionLabel(session Session) string {
	if strings.TrimSpace(session.Title) != "" {
		return session.Title
	}
	return session.ID
}

func permissionPrompt(permission PendingPermission) string {
	var out strings.Builder
	out.WriteString("PawWork asks permission: ")
	out.WriteString(permission.Permission)
	for _, pattern := range permission.Patterns {
		if strings.TrimSpace(pattern) == "" {
			continue
		}
		out.WriteString("\n")
		out.WriteString(pattern)
	}
	out.WriteString("\n\nReply yes, always, or no.")
	return out.String()
}

func questionPrompt(pending PendingQuestion) string {
	if len(pending.Questions) == 0 {
		return "PawWork asks a question.\n\nReply with your answer."
	}
	var out strings.Builder
	for index, question := range pending.Questions {
		if index > 0 {
			out.WriteString("\n\n")
		}
		if strings.TrimSpace(question.Header) != "" {
			out.WriteString(question.Header)
			out.WriteString("\n")
		}
		out.WriteString(question.Question)
		for optionIndex, option := range question.Options {
			out.WriteString("\n")
			out.WriteString(strconv.Itoa(optionIndex + 1))
			out.WriteString(". ")
			out.WriteString(option.Label)
			if strings.TrimSpace(option.Description) != "" {
				out.WriteString(" - ")
				out.WriteString(option.Description)
			}
		}
	}
	out.WriteString("\n\nReply with a number or answer text.")
	return out.String()
}

func permissionReplyForText(text string) string {
	switch strings.ToLower(strings.TrimSpace(text)) {
	case "yes", "y", "allow", "ok":
		return "once"
	case "always", "always allow":
		return "always"
	case "no", "n", "deny", "reject":
		return "reject"
	default:
		return ""
	}
}

func answersForQuestionText(pending PendingQuestion, text string) ([][]string, error) {
	questions := pending.Questions
	if len(questions) == 0 {
		return [][]string{{text}}, nil
	}
	if len(questions) == 1 {
		return [][]string{answerRowForQuestion(text, questions[0])}, nil
	}
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) != len(questions) {
		return nil, fmt.Errorf("Reply with %d lines, one answer per question.", len(questions))
	}
	answers := make([][]string, 0, len(questions))
	for index, line := range lines {
		answers = append(answers, answerRowForQuestion(line, questions[index]))
	}
	return answers, nil
}

func answerRowForQuestion(text string, question Question) []string {
	text = strings.TrimSpace(text)
	if !question.Multiple {
		return []string{answerTokenForQuestion(text, question)}
	}
	parts := strings.Split(text, ",")
	answers := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			answers = append(answers, answerTokenForQuestion(trimmed, question))
		}
	}
	return answers
}

func answerTokenForQuestion(text string, question Question) string {
	if index, err := strconv.Atoi(text); err == nil && index >= 1 && index <= len(question.Options) {
		return question.Options[index-1].Label
	}
	return text
}

func permissionKey(permission PendingPermission) string {
	if permission.ID != "" {
		return permission.ID
	}
	return permission.SessionID
}

func questionKey(question PendingQuestion) string {
	if question.MessageID != "" || question.CallID != "" {
		return question.MessageID + "\x00" + question.CallID
	}
	return question.SessionID
}

func remoteKey(platform core.Platform, msg *core.Message) string {
	if strings.TrimSpace(msg.SessionKey) != "" {
		return msg.SessionKey
	}
	parts := []string{platform.Name(), msg.ChannelID, msg.UserID}
	return strings.Join(parts, ":")
}
