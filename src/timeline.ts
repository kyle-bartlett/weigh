import { z } from "zod";

/** Suite-authored history, carried by suite-info into the hub registration. */
export const timelineSchema = z.array(
  z.object({
    version: z.string().min(1),
    headline: z.string().min(1),
    number: z.string().min(1),
  }),
);
export type TimelineStep = z.infer<typeof timelineSchema>[number];
