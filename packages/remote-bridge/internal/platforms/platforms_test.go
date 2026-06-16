package platforms

import (
	"testing"

	"github.com/chenhg5/cc-connect/core"
)

func TestAvailableIncludesCCConnectPlatforms(t *testing.T) {
	got := map[string]bool{}
	for _, name := range Available() {
		got[name] = true
	}
	for _, name := range []string{
		"dingtalk",
		"discord",
		"feishu",
		"lark",
		"line",
		"max",
		"qq",
		"qqbot",
		"slack",
		"telegram",
		"wecom",
		"weixin",
		"wps-xiezuo",
	} {
		if !got[name] {
			t.Fatalf("platform %q not registered; got %v", name, Available())
		}
	}
	if got["weibo"] {
		t.Fatalf("weibo should not be exposed until it can reconstruct reply contexts; got %v", Available())
	}
}

func TestAvailablePlatformsCanReconstructReplyContexts(t *testing.T) {
	options := map[string]map[string]any{
		"dingtalk":   {"client_id": "client", "client_secret": "secret", "allow_from": "conv"},
		"discord":    {"token": "token", "allow_from": "channel"},
		"feishu":     {"app_id": "app", "app_secret": "secret", "allow_chat": "oc_chat", "group_only": true},
		"lark":       {"app_id": "app", "app_secret": "secret", "allow_chat": "oc_chat", "group_only": true},
		"line":       {"channel_secret": "secret", "channel_token": "token", "allow_from": "target"},
		"max":        {"token": "token", "allow_from": "chat"},
		"qq":         {"allow_from": "user"},
		"qqbot":      {"app_id": "app", "app_secret": "secret", "allow_from": "channel"},
		"slack":      {"bot_token": "xoxb-token", "app_token": "xapp-token", "allow_from": "channel"},
		"telegram":   {"token": "token", "allow_from": "chat"},
		"wecom":      {"mode": "websocket", "bot_id": "bot", "bot_secret": "secret", "allow_from": "chat"},
		"weixin":     {"token": "token", "allow_from": "user"},
		"wps-xiezuo": {"app_id": "app", "app_secret": "secret", "allow_from": "chat"},
	}

	for _, name := range Available() {
		platform, err := core.CreatePlatform(name, options[name])
		if err != nil {
			t.Fatalf("create platform %q: %v", name, err)
		}
		if _, ok := platform.(core.ReplyContextReconstructor); !ok {
			t.Fatalf("platform %q is exposed but cannot reconstruct reply contexts", name)
		}
	}
}
