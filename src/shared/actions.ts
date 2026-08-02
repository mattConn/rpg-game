/** Attack types and the action bar slot definitions, shared by server and client. */

export type AttackKind = "melee" | "ranged";

export interface Action {
  id: string;
  kind: AttackKind;
}

/** The two attacks live in the first two slots; the rest are placeholders. */
export const ACTIONS: (Action | null)[] = [
  { id: "attack", kind: "melee" },
  { id: "ranged", kind: "ranged" },
  null,
  null,
  null,
];
