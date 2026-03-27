export interface TaggedResourcePromptItem {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly url: string;
}

export interface TaggedResourcePromptResource {
  readonly id: string;
  readonly name: string;
  readonly items: readonly TaggedResourcePromptItem[];
}
