import type { Api, Model, Provider } from "@mariozechner/pi-ai";

type SupportedAgentModel = Model<"openai-responses"> | Model<"anthropic-messages">;

interface AgentModelDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly pricingConfigured?: boolean;
  readonly model: SupportedAgentModel;
}

export interface AgentModelOption {
  readonly id: AgentModelId;
  readonly label: string;
  readonly description: string;
  readonly pricingConfigured: boolean;
  readonly provider: Provider;
  readonly api: Api;
  readonly modelId: string;
}

const hasConfiguredPricing = (model: SupportedAgentModel) =>
  model.cost.input > 0 ||
  model.cost.output > 0 ||
  model.cost.cacheRead > 0 ||
  model.cost.cacheWrite > 0;

const cloneModel = (model: SupportedAgentModel): SupportedAgentModel => structuredClone(model);

const modelDefinitions = [
  {
    id: "gpt-5.4-mini",
    label: "gpt-5.4-mini",
    description: "Current default agent model.",
    pricingConfigured: true,
    model: {
      id: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.75,
        output: 4.5,
        cacheRead: 0.75,
        cacheWrite: 4.5,
      },
      contextWindow: 128000,
      maxTokens: 128000,
    },
  },
  {
    id: "claude-haiku-4-5",
    label: "claude haiku 4.5",
    description: "Fast and fairly precise",
    pricingConfigured: true,
    model: {
      id: "claude-haiku-4-5",
      name: "claude haiku 4.5",
      api: "anthropic-messages",
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 1,
        output: 5,
        cacheRead: 0.1,
        cacheWrite: 1.25,
      },
      contextWindow: 128000,
      maxTokens: 128000,
    },
  },
] as const satisfies readonly AgentModelDefinition[];

export type AgentModelId = (typeof modelDefinitions)[number]["id"];

export const defaultAgentModelId = modelDefinitions[0].id;

const toAgentModelOption = (definition: AgentModelDefinition): AgentModelOption => ({
  id: definition.id as AgentModelId,
  label: definition.label,
  description: definition.description,
  pricingConfigured: definition.pricingConfigured ?? hasConfiguredPricing(definition.model),
  provider: definition.model.provider,
  api: definition.model.api,
  modelId: definition.model.id,
});

export const agentModelOptions: AgentModelOption[] = modelDefinitions.map(toAgentModelOption);

export const getAgentModelOption = (modelId: string | null | undefined) =>
  agentModelOptions.find((definition) => definition.id === modelId) ?? agentModelOptions[0];

export const getAgentModel = (modelId: string | null | undefined) => {
  const definition: AgentModelDefinition =
    modelDefinitions.find((candidate) => candidate.id === modelId) ?? modelDefinitions[0];

  return {
    id: definition.id as AgentModelId,
    label: definition.label,
    description: definition.description,
    pricingConfigured: definition.pricingConfigured ?? hasConfiguredPricing(definition.model),
    model: cloneModel(definition.model),
  };
};

export const findAgentModelOptionForProviderModel = ({
  api,
  provider,
  modelId,
}: {
  api: string;
  provider: string;
  modelId: string;
}) =>
  agentModelOptions.find(
    (candidate) =>
      candidate.api === api && candidate.provider === provider && candidate.modelId === modelId,
  ) ?? null;
