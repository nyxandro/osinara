/** A native command's accepted receipt is not proof that its continuation has finished. */
import type { Session } from "eve/channels";
import type { SessionAuth } from "eve/context";
import { AppError } from "./app-error.js";
import { database } from "./database.js";

export function runtimeHandoffSession(session: Session, admissionId: string): Pick<Session, "respond"> {
  return {
    async respond(responses, options) {
      if (!options.auth) throw new AppError("AGENT_RUNTIME_HANDOFF_AUTH_MISSING", "Не удалось проверить автора продолжения операции");
      const id = crypto.randomUUID();
      const admitted = await database().query(
        `INSERT INTO runtime_admission_holders(id,kind,eve_session_id)
         SELECT $1,'callback',$2 FROM runtime_admission_holders
         WHERE id=$3 AND kind='callback' AND eve_session_id IS NULL RETURNING id`,
        [id, session.id, admissionId],
      );
      if (admitted.rowCount !== 1) throw new AppError("AGENT_RUNTIME_HANDOFF_NOT_ADMITTED", "Допуск продолжения операции уже закрыт");
      // On transport failure the marker stays: the command may already be in Eve's inbox.
      const result = await session.respond(responses, { ...options, auth: { ...options.auth,
        attributes: { ...options.auth.attributes, osinaraRuntimeHandoffIds: [id] },
      } });
      if (result.status !== "accepted") await database().query("DELETE FROM runtime_admission_holders WHERE id=$1", [id]);
      return result;
    },
  };
}

export async function completeRuntimeHandoff(auth: SessionAuth, sessionId: string): Promise<void> {
  const ids = auth.current?.attributes.osinaraRuntimeHandoffIds;
  if (ids === undefined) return;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id)) {
    throw new AppError("AGENT_RUNTIME_HANDOFF_INVALID", "Не удалось проверить завершение служебной операции");
  }
  // The native coalescer preserves the exact consumed delivery IDs, never guessed from requests.
  await database().query("DELETE FROM runtime_admission_holders WHERE id=ANY($1::uuid[]) AND eve_session_id=$2", [ids, sessionId]);
}

export async function completeRuntimeSessionHandoffs(sessionId: string): Promise<void> {
  await database().query("DELETE FROM runtime_admission_holders WHERE eve_session_id=$1", [sessionId]);
}
