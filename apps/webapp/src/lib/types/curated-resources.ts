import { z } from "zod";
import { resourceItemKinds } from "$lib/types/resources";

export const curatedResourceItemSchema = z.object({
  kind: z.enum(resourceItemKinds),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  url: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  packageName: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  logoKey: z.string().trim().min(1).optional(),
  searchPath: z.string().trim().min(1).optional(),
  searchPaths: z.array(z.string().trim().min(1)).optional(),
  specialNotes: z.string().trim().min(1).optional(),
});

export const curatedResourceSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  notes: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  logoKey: z.string().trim().min(1).optional(),
  searchPath: z.string().trim().min(1).optional(),
  searchPaths: z.array(z.string().trim().min(1)).optional(),
  specialNotes: z.string().trim().min(1).optional(),
  items: z.array(curatedResourceItemSchema).min(1),
});

export const curatedResourcesDocumentSchema = z.object({
  resources: z.array(curatedResourceSchema),
});

export type CuratedResourceItem = z.infer<typeof curatedResourceItemSchema>;
export type CuratedResource = z.infer<typeof curatedResourceSchema>;
