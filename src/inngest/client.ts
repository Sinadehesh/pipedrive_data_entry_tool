import { EventSchemas, Inngest } from "inngest";

import { eventSchemas } from "./events";
import { inngestEventKey } from "./keys";

export const inngest = new Inngest({
  id: "crm-intelligence",
  // Accepts a prefixed name from the Vercel integration — see ./keys.ts.
  eventKey: inngestEventKey(),
  schemas: new EventSchemas().fromZod(eventSchemas),
});
