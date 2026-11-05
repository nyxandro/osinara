/**
 * Raw copies of a chat's updates in the ingress queue, deleted with the group's data (#464).
 *
 * Export:
 * - `purgeChatIngressCopies`: deletes the finished queue rows of one chat, in small batches.
 *
 * Every update of a chat is kept whole in `telegram_ingress_updates` after its turn; without this a
 * deleted group's whole conversation would stay there. Only finished rows go: a pending or running one
 * still belongs to the queue, and after the group is gone it finishes as an update of an unregistered
 * chat. The table has no index by chat, so the rows are found in one pass and deleted by key in batches:
 * no long transaction on a slow disk, and an interrupted purge simply runs again.
 */
import { database } from "../database.js";

const PURGE_BATCH_SIZE = 500;
const GROUP_CHAT_ID_PATTERN = /^-\d+$/u;

export async function purgeChatIngressCopies(telegramChatId: string): Promise<number> {
  if (!GROUP_CHAT_ID_PATTERN.test(telegramChatId)) {
    throw new Error(`AGENT_GROUP_PURGE_CHAT_INVALID: ${JSON.stringify(telegramChatId)} is not a group chat id`);
  }
  // The continuation key starts with the chat id: `chat:topic:conversation`.
  const rows = await database().query<{ update_id: string }>(
    `SELECT update_id::text FROM telegram_ingress_updates
      WHERE ingress_continuation_key LIKE $1 AND status NOT IN ('pending', 'processing')`,
    [`${telegramChatId}:%`],
  );
  const ids = rows.rows.map((row) => row.update_id);
  for (let start = 0; start < ids.length; start += PURGE_BATCH_SIZE) {
    await database().query(
      "DELETE FROM telegram_ingress_updates WHERE update_id = ANY($1::bigint[]) AND status NOT IN ('pending', 'processing')",
      [ids.slice(start, start + PURGE_BATCH_SIZE)],
    );
  }
  return ids.length;
}
