import { describe, expect, test } from "bun:test"
import {
  FeishuRegistrationError,
  type FormPoster,
  pollFeishuRegistration,
  startFeishuRegistration,
} from "./registration.ts"

/** A FormPoster that replays queued responses and records every call. */
function poster(responses: Array<{ ok?: boolean; status?: number; data: Record<string, unknown> }>): {
  post: FormPoster
  calls: Array<{ url: string; form: Record<string, string> }>
} {
  const calls: Array<{ url: string; form: Record<string, string> }> = []
  let index = 0
  const post: FormPoster = async (url, form) => {
    calls.push({ url, form })
    const response = responses[Math.min(index, responses.length - 1)]
    index++
    return { ok: response.ok ?? true, status: response.status ?? 200, data: response.data }
  }
  return { post, calls }
}

describe("startFeishuRegistration", () => {
  test("maps the begin response and posts the PersonalAgent form to Feishu", async () => {
    const { post, calls } = poster([
      {
        data: {
          device_code: "dev-1",
          user_code: "B9VZ-RT8J",
          verification_uri: "https://open.feishu.cn/page/launcher",
          verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=B9VZ-RT8J",
          expires_in: 3600,
          interval: 5,
        },
      },
    ])
    const start = await startFeishuRegistration({ post })
    expect(start.deviceCode).toBe("dev-1")
    expect(start.userCode).toBe("B9VZ-RT8J")
    expect(start.verificationUri).toBe("https://open.feishu.cn/page/launcher?user_code=B9VZ-RT8J")
    expect(start.intervalMs).toBe(5000)
    expect(start.expiresInMs).toBe(3_600_000)
    expect(start.domain).toBe("feishu")
    expect(calls[0].url).toBe("https://accounts.feishu.cn/oauth/v1/app/registration")
    expect(calls[0].form.action).toBe("begin")
    expect(calls[0].form.archetype).toBe("PersonalAgent")
  })

  test("falls back to verification_uri and default interval / expiry", async () => {
    const { post } = poster([{ data: { device_code: "d", verification_uri: "https://x", user_code: "C" } }])
    const start = await startFeishuRegistration({ post })
    expect(start.verificationUri).toBe("https://x")
    expect(start.intervalMs).toBe(5000)
    expect(start.expiresInMs).toBe(3_600_000)
  })

  test("throws when the response is incomplete", async () => {
    const { post } = poster([{ data: { user_code: "C" } }])
    await expect(startFeishuRegistration({ post })).rejects.toBeInstanceOf(FeishuRegistrationError)
  })

  test("throws on a non-ok begin", async () => {
    const { post } = poster([{ ok: false, status: 400, data: { error_description: "bad request" } }])
    await expect(startFeishuRegistration({ post })).rejects.toThrow("bad request")
  })
})

describe("pollFeishuRegistration", () => {
  test("returns pending while authorization is pending", async () => {
    const { post } = poster([{ data: { error: "authorization_pending" } }])
    expect(await pollFeishuRegistration("dev-1", "feishu", { post })).toEqual({ status: "pending", domain: "feishu" })
  })

  test("treats slow_down as pending", async () => {
    const { post } = poster([{ data: { error: "slow_down" } }])
    expect(await pollFeishuRegistration("dev-1", "feishu", { post })).toEqual({ status: "pending", domain: "feishu" })
  })

  test("returns credentials when approved", async () => {
    const { post, calls } = poster([{ data: { client_id: "cli_abc", client_secret: "sec_xyz" } }])
    expect(await pollFeishuRegistration("dev-1", "feishu", { post })).toEqual({
      status: "done",
      appId: "cli_abc",
      appSecret: "sec_xyz",
      domain: "feishu",
    })
    expect(calls[0].url).toBe("https://accounts.feishu.cn/oauth/v1/app/registration")
    expect(calls[0].form).toEqual({ action: "poll", device_code: "dev-1" })
  })

  test("switches to Lark and re-polls when the tenant is Lark", async () => {
    const { post, calls } = poster([
      { data: { user_info: { tenant_brand: "lark" } } },
      { data: { client_id: "cli_l", client_secret: "sec_l" } },
    ])
    const result = await pollFeishuRegistration("dev-1", "feishu", { post })
    expect(result).toEqual({ status: "done", appId: "cli_l", appSecret: "sec_l", domain: "lark" })
    expect(calls[0].url).toContain("accounts.feishu.cn")
    expect(calls[1].url).toContain("accounts.larksuite.com")
  })

  test("surfaces a terminal error", async () => {
    const { post } = poster([{ data: { error: "expired_token", error_description: "device code expired" } }])
    expect(await pollFeishuRegistration("dev-1", "feishu", { post })).toEqual({
      status: "error",
      message: "device code expired",
    })
  })
})
