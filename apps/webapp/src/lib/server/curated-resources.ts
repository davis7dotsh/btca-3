import YAML from "yaml";
import curatedResourcesYaml from "$lib/data/curated-resources.yaml?raw";
import { curatedResourcesDocumentSchema, type CuratedResource } from "$lib/types/curated-resources";

export const getCuratedResources = (): CuratedResource[] => {
  const parsed = YAML.parse(curatedResourcesYaml);
  return curatedResourcesDocumentSchema.parse(parsed).resources;
};
