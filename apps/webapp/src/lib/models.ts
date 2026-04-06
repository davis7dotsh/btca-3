import { getModel, type Api, type Model, type Provider } from "@mariozechner/pi-ai";

type SupportedAgentModel = Model<Api>;

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
    model: getModel("opencode", "gpt-5.4-mini"),
  },
  {
    id: "claude-haiku-4-5",
    label: "claude-haiku-4-5",
    description: "Fast and fairly precise.",
    model: getModel("opencode", "claude-haiku-4-5"),
  },
  {
    id: "kimi-k2.5",
    label: "kimi-k2.5",
    description: "Strong reasoning with OpenAI-compatible streaming.",
    model: getModel("opencode", "kimi-k2.5"),
  },
] as const satisfies readonly AgentModelDefinition[];

export type AgentModelId = (typeof modelDefinitions)[number]["id"];

export const defaultAgentModelId = modelDefinitions[0].id;
export const isAgentModelId = (value: string | null | undefined): value is AgentModelId =>
  value !== null &&
  value !== undefined &&
  modelDefinitions.some((definition) => definition.id === value);

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
