import workflow from "@convex-dev/workflow/convex.config.js";
import { defineApp } from "convex/server";

const app: ReturnType<typeof defineApp> = defineApp();
app.use(workflow);

export default app;
