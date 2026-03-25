import type { ExaGetWebContentInput, ExaSearchWebInput } from "$lib/services/exa";

import { AUTUMN_USAGE_FEATURE } from "@btca/autumn/config";

export const AUTUMN_USAGE_FEATURE_ID = AUTUMN_USAGE_FEATURE.id;

export const EXA_SEARCH_RESULTS_THRESHOLD = 25;
export const EXA_SEARCH_REQUEST_PRICE_USD = 5 / 1_000;
export const EXA_SEARCH_LARGE_REQUEST_PRICE_USD = 25 / 1_000;
export const EXA_CONTENTS_PAGE_PRICE_USD = 1 / 1_000;

export interface TurnCostBreakdown {
  modelUsd: number;
  boxUsd: number;
  exaUsd: number;
  totalUsd: number;
  exaSearchRequests: number;
  exaContentPages: number;
  exaSummaryPages: number;
  exaHighlightPages: number;
  boxComputeMs: number;
}

export const createEmptyTurnCostBreakdown = (): TurnCostBreakdown => ({
  modelUsd: 0,
  boxUsd: 0,
  exaUsd: 0,
  totalUsd: 0,
  exaSearchRequests: 0,
  exaContentPages: 0,
  exaSummaryPages: 0,
  exaHighlightPages: 0,
  boxComputeMs: 0,
});

export const roundUsd = (value: number) => Number(value.toFixed(6));

export const addUsd = (...values: readonly number[]) =>
  roundUsd(values.reduce((total, value) => total + value, 0));

export const calculateExaSearchCostUsd = (input: ExaSearchWebInput | null | undefined) =>
  (input?.numResults ?? 5) > EXA_SEARCH_RESULTS_THRESHOLD
    ? EXA_SEARCH_LARGE_REQUEST_PRICE_USD
    : EXA_SEARCH_REQUEST_PRICE_USD;

export const calculateExaContentCostUsd = ({
  input,
  pageCount,
}: {
  input: ExaGetWebContentInput | null | undefined;
  pageCount: number;
}) => {
  if (pageCount <= 0) {
    return 0;
  }

  const multiplier =
    1 +
    (input?.summary ? 1 : 0) +
    (input?.highlightsQuery && input.highlightsQuery.length > 0 ? 1 : 0);

  return roundUsd(pageCount * EXA_CONTENTS_PAGE_PRICE_USD * multiplier);
};
