import type { ModelsDev } from "./models"
import {
  VOLCENGINE_PLAN_HIDDEN_MODEL_IDS,
  VOLCENGINE_PLAN_PROVIDER_ID,
  VOLCENGINE_PLAN_VISIBLE_MODEL_IDS,
  volcenginePlanModelFamily,
} from "@opencode-ai/util/volcengine-plan"

const CODING_PLAN_COST = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
}

type Model = ModelsDev.Provider["models"][string]
const KIMI_FOR_CODING_PROVIDER_ID = "kimi-for-coding"
const KIMI_FOR_CODING_REASONING_CONTENT_MODEL_IDS = new Set(["k2p6"])

const textModel = (id: string, name: string, context: number, output: number, extra: Partial<Model> = {}): Model => ({
  id,
  name,
  family: volcenginePlanModelFamily(id),
  attachment: false,
  reasoning: false,
  tool_call: true,
  temperature: true,
  release_date: "",
  cost: CODING_PLAN_COST,
  limit: { context, output },
  modalities: { input: ["text"], output: ["text"] },
  ...extra,
})

export const PAWWORK_PROVIDER_OVERLAYS: Record<string, ModelsDev.Provider> = {
  [VOLCENGINE_PLAN_PROVIDER_ID]: {
    id: VOLCENGINE_PLAN_PROVIDER_ID,
    name: "Volcano Engine Coding Plan",
    npm: "@ai-sdk/openai-compatible",
    api: "https://ark.cn-beijing.volces.com/api/coding/v3",
    env: ["ARK_API_KEY"],
    models: {
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[0]]: textModel("doubao-seed-2.0-code", "Doubao Seed 2.0 Code", 256000, 4096, {
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[1]]: textModel("doubao-seed-2.0-pro", "Doubao Seed 2.0 Pro", 256000, 4096, {
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[2]]: textModel("doubao-seed-2.0-lite", "Doubao Seed 2.0 Lite", 256000, 4096),
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[3]]: textModel("doubao-seed-code", "Doubao Seed Code", 256000, 4096, {
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[4]]: textModel("minimax-m2.7", "MiniMax M2.7", 204800, 131072, {
        reasoning: true,
      }),
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[5]]: textModel("minimax-m2.5", "MiniMax M2.5", 204800, 131072, {
        reasoning: true,
      }),
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[6]]: textModel("glm-5.1", "GLM 5.1", 200000, 131072, {
        reasoning: true,
        interleaved: { field: "reasoning_content" },
      }),
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[7]]: textModel("glm-4.7", "GLM 4.7", 200000, 4096, {
        reasoning: true,
        interleaved: { field: "reasoning_content" },
      }),
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[8]]: textModel("deepseek-v3.2", "DeepSeek V3.2", 128000, 4096),
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[9]]: textModel("kimi-k2.6", "Kimi K2.6", 262144, 32768, {
        attachment: true,
        reasoning: true,
        interleaved: { field: "reasoning_content" },
        modalities: { input: ["text", "image", "video"], output: ["text"] },
      }),
      [VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[10]]: textModel("kimi-k2.5", "Kimi K2.5", 262144, 32768, {
        attachment: true,
        reasoning: true,
        interleaved: { field: "reasoning_content" },
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
      [VOLCENGINE_PLAN_HIDDEN_MODEL_IDS[0]]: textModel("ark-code-latest", "Ark Code Latest", 256000, 4096, {
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      }),
    },
  },
}

function withReasoningContentReplay(model: Model) {
  if (model.interleaved) return model
  return {
    ...model,
    interleaved: { field: "reasoning_content" },
  } satisfies Model
}

function withKimiForCodingReplay(provider: ModelsDev.Provider | undefined) {
  if (!provider) return undefined
  return {
    ...provider,
    models: Object.fromEntries(
      Object.entries(provider.models).map(([id, model]) => [
        id,
        KIMI_FOR_CODING_REASONING_CONTENT_MODEL_IDS.has(id) ? withReasoningContentReplay(model) : model,
      ]),
    ),
  } satisfies ModelsDev.Provider
}

export function withPawWorkProviders(providers: Record<string, ModelsDev.Provider>) {
  const result = {
    ...providers,
    ...PAWWORK_PROVIDER_OVERLAYS,
  }
  const kimiForCoding = withKimiForCodingReplay(result[KIMI_FOR_CODING_PROVIDER_ID])
  if (kimiForCoding) result[KIMI_FOR_CODING_PROVIDER_ID] = kimiForCoding
  return result
}
