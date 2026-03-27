import { z } from "zod";

export const curatedResourceItemSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1),
});

export const curatedResourceSchema = z.object({
  name: z.string().trim().min(1),
  items: z.array(curatedResourceItemSchema).min(1),
});

export const curatedResourcesDocumentSchema = z.object({
  resources: z.array(curatedResourceSchema),
});

export type CuratedResourceItem = z.infer<typeof curatedResourceItemSchema>;
export type CuratedResource = z.infer<typeof curatedResourceSchema>;
