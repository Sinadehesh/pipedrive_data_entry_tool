import { EventSchemas, Inngest } from "inngest";

import { eventSchemas } from "./events";

export const inngest = new Inngest({
  id: "crm-intelligence",
  schemas: new EventSchemas().fromZod(eventSchemas),
});
