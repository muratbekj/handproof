import { isHuman } from "../config.ts";
import type { AgentRef, Handoff } from "../schema/handoff.ts";
import type { Role } from "./lifecycle.ts";

/** Roles `actor` holds on `h`. Identity is the agent name. */
export function rolesFor(actor: AgentRef, h: Handoff): Set<Role> {
  const roles = new Set<Role>(["any"]);
  if (h.from.name === actor.name) roles.add("creator");
  if (h.claim?.by.name === actor.name) roles.add("claimant");
  if (isHuman(actor)) roles.add("human");
  return roles;
}
