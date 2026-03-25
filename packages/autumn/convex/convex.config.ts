import { defineComponent } from "convex/server";
import autumn from "@useautumn/convex/convex.config";

const component = defineComponent("btca_autumn");

component.use(autumn);

export default component;
