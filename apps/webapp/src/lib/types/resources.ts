export const resourceItemKinds = ["git_repo", "npm_package", "website"] as const;

export type ResourceItemKind = (typeof resourceItemKinds)[number];

export interface TaggedResourcePromptItem {
  readonly id: string;
  readonly kind: ResourceItemKind;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly branch: string | null;
  readonly packageName: string | null;
}

export interface TaggedResourcePromptResource {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly notes: string | null;
  readonly items: readonly TaggedResourcePromptItem[];
}
