import type { components } from "./data-platform/contract.ts";

type Schemas = components["schemas"];

export type Festival = Schemas["Festival"];
export type Availability = Schemas["Availability"];
export type Reservation = Schemas["Reservation"];
export type Invoice = Schemas["Invoice"];
export type ReservationRequest = Schemas["ReservationRequest"];
export type Money = Schemas["Money"];
export type QueueEntry = Schemas["QueueEntry"];

/** A pass as the website sees it. `availabilityWarning` is set when a live refresh failed and a snapshot is shown. */
export type Offer = Schemas["Offer"] & { availabilityWarning?: "LIVE_REFRESH_FAILED" };

export type ApiError = { code: string; message: string; requestId: string };
