import { LIMITS, type ActionAck } from "../shared/types";

/** Error string carried by a rejected ActionAck. */
export type AckError = Extract<ActionAck, { ok: false }>["error"];

/** Human-readable message for a rejected action ack. */
export function messageForAck(error: AckError): string {
  switch (error) {
    case "too-big":
      return "Too big to send. Try attaching it as a file instead.";
    case "rate-limited":
      return "You're sending too fast — wait a moment and try again.";
    case "not-found":
      return "That item no longer exists.";
    case "busy":
      return "Someone else is already sharing their screen.";
    case "full":
      return `Too many people are watching already (max ${LIMITS.maxScreenViewers}).`;
    default:
      return "The server rejected that message.";
  }
}

/** Message for a rejected screen:join. Same codes, screen-specific wording
 *  where the generic message would be misleading ("item no longer exists"). */
export function messageForScreenJoin(error: AckError | "timeout"): string {
  switch (error) {
    case "not-found":
      return "That screen share has already ended.";
    case "invalid":
      return "Couldn't join that screen share.";
    case "timeout":
      return "The server didn't answer. Check your connection and try again.";
    default:
      return messageForAck(error);
  }
}

/** Message for a rejected screen:start. */
export function messageForScreenStart(error: AckError | "timeout"): string {
  switch (error) {
    case "busy":
      return "Someone else started sharing first.";
    case "timeout":
      return "The server didn't answer. Check your connection and try again.";
    case "invalid":
      return "The server couldn't start screen sharing.";
    default:
      return messageForAck(error);
  }
}
