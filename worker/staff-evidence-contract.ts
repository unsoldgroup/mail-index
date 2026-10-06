import { z } from "zod";
import { staffMailboxDigest, staffMailboxEnvironment, staffMailboxHash, staffMailboxHoldReason } from "./staff-evidence-values.js";

const id = z.string().min(1).max(256);
const challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestamp = z.number().int().nonnegative();
const generation = z.number().int().positive();
const messageId = z.string().max(998).regex(/^<[^<>\s"']+@[^<>\s"']+>$/);
export const staffServiceOperation = z.enum(["acquire", "recheck", "release_recheck"]);
export const staffServiceItem = z.object({ id, version: id, sentAt: timestamp, labels: z.array(id).max(100) }).strict();
export const staffServiceAcquisition = z.object({
  acquisitionChallenge: challenge, acquisitionRequestDigest: staffMailboxDigest,
  id, version: id, sentAt: timestamp, rawSha256: staffMailboxDigest,
}).strict();
export const staffServiceRequest = z.object({
  version: z.literal(1), operation: staffServiceOperation, environment: staffMailboxEnvironment,
  enrollmentHandle: id, expectedEnrollmentGeneration: generation, expectedGrantGeneration: generation,
  challenge, observationId: id, originalMessageId: messageId, forwardMessageId: messageId,
  observedReceivedAt: timestamp, issuedAt: timestamp, expiresAt: timestamp,
  expectedItem: staffServiceAcquisition.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 60_000) ctx.addIssue({ code: "custom", message: "Invalid request lifetime" });
  if ((value.operation === "acquire") === Boolean(value.expectedItem)) ctx.addIssue({ code: "custom", message: "Invalid acquisition binding" });
  if (value.expectedItem?.acquisitionChallenge === value.challenge) ctx.addIssue({ code: "custom", message: "Recheck requires a fresh challenge" });
});
export type StaffServiceRequest = z.infer<typeof staffServiceRequest>;
export type StaffServiceAcquisition = z.infer<typeof staffServiceAcquisition>;

/** Wire digest v1: UTF-8 JSON of this ordered array; no object iteration or locale normalization. */
export function staffServiceRequestCanonical(value: StaffServiceRequest): string {
  const r = staffServiceRequest.parse(value); const item = r.expectedItem;
  return JSON.stringify(["staff-sent-evidence-v1", r.version, r.operation, r.environment, r.enrollmentHandle,
    r.expectedEnrollmentGeneration, r.expectedGrantGeneration, r.challenge, r.observationId,
    r.originalMessageId, r.forwardMessageId, r.observedReceivedAt, r.issuedAt, r.expiresAt,
    item ? [item.acquisitionChallenge, item.acquisitionRequestDigest, item.id, item.version, item.sentAt, item.rawSha256] : null]);
}
export async function staffServiceRequestDigest(value: StaffServiceRequest): Promise<string> {
  return staffMailboxHash(staffServiceRequestCanonical(value));
}
const binding = {
  version: z.literal(1), operation: staffServiceOperation, environment: staffMailboxEnvironment,
  enrollmentHandle: id, expectedEnrollmentGeneration: generation, expectedGrantGeneration: generation,
  challenge, observationId: id, requestDigest: staffMailboxDigest,
};
const evidence = z.object({
  ...binding, status: z.literal("evidence"), provider: z.literal("google"),
  accountSubject: id, mailboxAddress: z.string().email().max(512), scopes: z.array(z.string().max(512)).max(32),
  item: staffServiceItem, rawSha256: staffMailboxDigest, startedAt: timestamp, completedAt: timestamp,
  expiresAt: timestamp, fence: z.literal("current"), rawBase64: z.string().optional(),
}).strict();
const held = z.object({ ...binding, status: z.literal("held"), reason: staffMailboxHoldReason }).strict();
export const staffServiceResponse = z.discriminatedUnion("status", [evidence, held]);
export type StaffServiceResponse = z.infer<typeof staffServiceResponse>;
