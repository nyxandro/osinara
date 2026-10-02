/** Run the production initialization and live DB mount checks with an in-process test filesystem. */
import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";
import productionSandbox from "../../../agent/sandbox.js";
import { database } from "../../../agent/lib/database.js";
import { isMemoryReviewSession } from "../../../agent/lib/memory-review/memory-review-session.js";

export default defineSandbox({
  backend: justbash(),
  async onSession(input) {
    if (!productionSandbox.onSession) throw new Error("TEST_SANDBOX_HOOK_MISSING");
    await productionSandbox.onSession({
      ...input,
      async use(options) {
        const attrs = input.ctx.session.auth.current?.attributes;
        // Silent memory review materializes no workspace capability at all.
        const expected = isMemoryReviewSession(input.ctx) ? [] :
          attrs?.telegramChatType === "private" ? ["personal", "family"] :
          attrs?.groupType === "family_private" ? ["family"] : ["group"];
        if (!options || JSON.stringify(options.mounts.map((mount) => mount.mountPoint)) !== JSON.stringify(expected)) {
          throw new Error("TEST_GROUP_MOUNTS_INVALID");
        }
        await database().query(
          "INSERT INTO telegram_conversation_test_sandboxes (eve_session_id, mounts) VALUES ($1, $2)",
          [input.ctx.session.id, JSON.stringify(options.mounts)],
        );
        return input.use();
      },
    });
  },
});
