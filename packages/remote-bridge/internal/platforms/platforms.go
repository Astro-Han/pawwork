package platforms

import (
	"sort"

	"github.com/chenhg5/cc-connect/core"
	_ "github.com/chenhg5/cc-connect/platform/dingtalk"
	_ "github.com/chenhg5/cc-connect/platform/discord"
	_ "github.com/chenhg5/cc-connect/platform/feishu"
	_ "github.com/chenhg5/cc-connect/platform/line"
	_ "github.com/chenhg5/cc-connect/platform/max"
	_ "github.com/chenhg5/cc-connect/platform/qq"
	_ "github.com/chenhg5/cc-connect/platform/qqbot"
	_ "github.com/chenhg5/cc-connect/platform/slack"
	_ "github.com/chenhg5/cc-connect/platform/telegram"
	_ "github.com/chenhg5/cc-connect/platform/wecom"
	_ "github.com/chenhg5/cc-connect/platform/weixin"
	_ "github.com/chenhg5/cc-connect/platform/wps-xiezuo"
)

func Available() []string {
	names := core.ListRegisteredPlatforms()
	sort.Strings(names)
	return names
}
