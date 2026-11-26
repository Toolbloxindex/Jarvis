import type { SearchCriteria } from "./types";

/** A neutral first search: TU Delft, any move-in date, no end date, any budget. */
export const DEFAULT_SEARCH: SearchCriteria = {
  university: "tud",
  moveIn: null,
  moveInFlexDays: 14,
  moveOut: null,
  moveOutFlexDays: 30,
  budget: null,
};
